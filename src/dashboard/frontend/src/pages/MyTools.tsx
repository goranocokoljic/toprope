import {useMeJourney, useMeTools} from '../hooks/useMe';
import {useTimeRange} from '../hooks/useTimeRange';
import {Card} from '../components/Card';
import {Badge} from '../components/Badge';
import {TimeRangeSelector} from '../components/TimeRangeSelector';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {SkeletonChart, SkeletonStatCard} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {StatePanel} from '../components/StatePanel';
import {toolLabel, featureLabel} from '../components/toolLabels';
import {formatCurrency, formatPercent, formatDateTick} from '../components/format';
import {earliestJourneyStart} from '../components/meHelpers';
import type {MeJourney, MeJourneyTool, MeToolBreakdown} from '../api/types';

/**
 * Developer "My Tools" (Task 2.9). Per-tool usage detail for the logged-in
 * developer only — every query is session-scoped server-side, so nothing here
 * can reach another developer's data. The value is self-reflection: the feature
 * breakdown makes it visually obvious when a paid (premium) seat is only being
 * used for basic features, without ranking the developer against anyone.
 */

// Share of total feature usage at or above which a single feature is treated as
// dominant — used only to phrase a gentle, non-judgmental utilization note.
const DOMINANT_FEATURE_SHARE = 0.85;

/** The plan/active status for a tool, looked up from the adoption journey. */
function planForTool(journeyTools: MeJourneyTool[] | undefined, tool: string): MeJourneyTool | undefined {
    return journeyTools?.find((t) => t.tool === tool);
}

// --- Feature usage breakdown ----------------------------------------------

function FeatureBreakdown({tool}: {tool: MeToolBreakdown}): JSX.Element {
    const features = tool.feature_usage;
    if (features.length === 0) {
        return (
            <p className="text-sm text-muted" data-testid="feature-empty">
                No feature-level data recorded for this tool yet.
            </p>
        );
    }
    const max = Math.max(...features.map((f) => f.count));
    return (
        <ul className="space-y-2.5" data-testid="feature-breakdown">
            {features.map((f) => {
                // Width is relative to the most-used feature, so a lopsided
                // breakdown (one tall bar, the rest short) reads at a glance.
                const pct = max > 0 ? Math.max(4, Math.round((f.count / max) * 100)) : 0;
                return (
                    <li key={f.feature}>
                        <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                            <span className="text-foreground">{featureLabel(f.feature)}</span>
                            <span className="tabular-nums text-muted">{f.count.toLocaleString()}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-surface-raised">
                            <div className="h-full rounded-full bg-accent" style={{width: `${pct}%`}} />
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}

/**
 * A gentle, non-causal utilization note. Only shown when the developer pays for
 * the tool and their usage is concentrated in a single feature — the case the
 * task calls out ("paying for a premium plan but only using basic features").
 * Deliberately suggestive, never prescriptive, and never a comparison to peers.
 */
function utilizationNote(tool: MeToolBreakdown): string | null {
    if (tool.estimated_monthly_cost <= 0 || tool.feature_usage.length === 0) {
        return null;
    }
    const total = tool.feature_usage.reduce((sum, f) => sum + f.count, 0);
    if (total <= 0) {
        return null;
    }
    const top = tool.feature_usage[0];
    const share = top.count / total;
    if (tool.feature_usage.length === 1) {
        return `Your ${toolLabel(tool.tool)} usage is all ${featureLabel(top.feature)} — worth checking your plan fits how you actually use it.`;
    }
    if (share >= DOMINANT_FEATURE_SHARE) {
        return `Most of your ${toolLabel(tool.tool)} usage is ${featureLabel(top.feature)} — worth checking your plan fits how you actually use it.`;
    }
    return null;
}

// --- Per-tool card ---------------------------------------------------------

function ToolCard({tool, plan}: {tool: MeToolBreakdown; plan: MeJourneyTool | undefined}): JSX.Element {
    const chartData: ChartDatum[] = tool.activity.map((p) => ({date: p.date, interactions: p.interactions}));
    const note = utilizationNote(tool);

    return (
        <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-foreground">{toolLabel(tool.tool)}</h2>
                    {plan?.active && plan.current_plan ? <Badge tone="accent">{plan.current_plan}</Badge> : null}
                </div>
                <div className="text-right">
                    <p className="font-display text-lg font-semibold text-foreground">
                        {formatCurrency(tool.estimated_monthly_cost)}
                    </p>
                    <p className="text-xs text-muted">est. monthly cost</p>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
                <div>
                    <p className="text-xs uppercase tracking-wider text-muted">Active days</p>
                    <p className="font-display text-xl font-semibold text-foreground">{tool.active_days}</p>
                </div>
                <div>
                    <p className="text-xs uppercase tracking-wider text-muted">Interactions</p>
                    <p className="font-display text-xl font-semibold text-foreground">
                        {tool.interactions.toLocaleString()}
                    </p>
                </div>
                <div>
                    <p className="text-xs uppercase tracking-wider text-muted">Acceptance</p>
                    <p className="font-display text-xl font-semibold text-foreground">
                        {tool.acceptance_rate === null ? '—' : formatPercent(tool.acceptance_rate)}
                    </p>
                </div>
            </div>

            <div className="mt-5">
                <h3 className="mb-2 text-sm font-medium text-foreground">Activity over time</h3>
                {chartData.length >= 2 ? (
                    <TrendChart
                        data={chartData}
                        xKey="date"
                        series={[{key: 'interactions', label: 'Interactions'}]}
                        variant="area"
                        height={140}
                        xTickFormatter={formatDateTick}
                        testId={`tool-trend-${tool.tool}`}
                    />
                ) : (
                    <p className="text-sm text-muted">Not enough days yet to chart a trend.</p>
                )}
            </div>

            <div className="mt-5">
                <h3 className="mb-2 text-sm font-medium text-foreground">Feature usage</h3>
                <FeatureBreakdown tool={tool} />
                {note ? (
                    <p className="mt-3 rounded-card bg-accent-soft/40 px-3 py-2 text-xs text-foreground" data-testid="utilization-note">
                        {note}
                    </p>
                ) : null}
            </div>
        </Card>
    );
}

// --- Page ------------------------------------------------------------------

function LoadingTools(): JSX.Element {
    return (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {[0, 1].map((i) => (
                <Card key={i}>
                    <SkeletonStatCard />
                    <div className="mt-4">
                        <SkeletonChart height={140} />
                    </div>
                </Card>
            ))}
        </div>
    );
}

function PageHeader({children}: {children?: JSX.Element}): JSX.Element {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">My Tools</h1>
                <p className="mt-1 text-sm text-muted">
                    How you use each of your AI tools — visible only to you.
                </p>
            </div>
            {children}
        </div>
    );
}

/**
 * The time-ranged body. Split out from the page so it only mounts once the
 * journey has settled and `earliest` is known — that way `useTimeRange` resolves
 * its smart default from the developer's true first day on its very first render
 * (no 30d→year flip after the journey loads, so the content never flashes back
 * to a skeleton).
 */
function MyToolsContent({earliest, journey}: {earliest: string | null; journey: MeJourney | undefined}): JSX.Element {
    const {range, setRange} = useTimeRange({earliest});
    const {data, isPending, isError, error, refetch} = useMeTools(range);
    const tools = data?.tools ?? [];

    return (
        <div className="space-y-6">
            <PageHeader>
                <TimeRangeSelector value={range} onChange={setRange} earliest={earliest} />
            </PageHeader>

            {isPending ? <LoadingTools /> : null}

            {isError ? (
                <ErrorState
                    title="Failed to load your tools"
                    detail={error?.message}
                    onRetry={() => void refetch()}
                />
            ) : null}

            {!isPending && !isError && tools.length === 0 ? (
                <StatePanel
                    tone="accent"
                    testId="my-tools-empty"
                    title="No tool activity yet"
                    description="Once your AI tool usage is tracked, a per-tool breakdown of your activity, features, and cost will appear here."
                />
            ) : null}

            {!isPending && !isError && tools.length > 0 ? (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    {tools.map((tool) => (
                        <ToolCard key={tool.tool} tool={tool} plan={planForTool(journey?.tools, tool.tool)} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function MyTools(): JSX.Element {
    // Resolve the journey first (it carries per-tool plans and the developer's
    // earliest tool-use day). The time-ranged content mounts only once it has
    // settled, so the range starts correct rather than snapping after load.
    const journey = useMeJourney();

    if (journey.isPending) {
        return (
            <div className="space-y-6">
                <PageHeader />
                <LoadingTools />
            </div>
        );
    }

    return <MyToolsContent earliest={earliestJourneyStart(journey.data)} journey={journey.data} />;
}
