import {useMeActivity, useMeJourney, useMeTimeline} from '../hooks/useMe';
import {useTimeRange} from '../hooks/useTimeRange';
import {Card, StatCard} from '../components/Card';
import {TimeRangeSelector} from '../components/TimeRangeSelector';
import {CoverageBadge} from '../components/CoverageBadge';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {SkeletonChart, SkeletonStatCard} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {StatePanel} from '../components/StatePanel';
import {providerLabel} from '../components/toolLabels';
import {formatPercent, formatDateTick} from '../components/format';
import {earliestJourneyStart} from '../components/meHelpers';
import {inclusiveDayCount} from '../timeRange/range';
import type {MeActivity, MeProviderActivity, MeTimeline} from '../api/types';

/**
 * Developer "My Activity" (Task 2.9). The developer's own git output and how it
 * relates to their AI usage — fully private (session-scoped server-side) and
 * framed for self-reflection, never as a report card. The correlation view is
 * deliberately worded to show that two series move together WITHOUT claiming one
 * causes the other, and the churn metric ships with a plain-language explanation
 * so a high number isn't mistaken for a verdict.
 */

/** Compact integer, e.g. 12500 → "12,500". */
function formatCount(value: number): string {
    return value.toLocaleString();
}

// --- Stat cards ------------------------------------------------------------

function ActivityStats({totals}: {totals: MeActivity['totals']}): JSX.Element {
    const linesChanged = totals.lines_added + totals.lines_removed;
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Commits" value={formatCount(totals.commits)} hint="in this range" />
            <StatCard label="PRs merged" value={formatCount(totals.prs_merged)} hint={`${formatCount(totals.prs_opened)} opened`} />
            <StatCard label="Lines changed" value={formatCount(linesChanged)} hint={`+${formatCount(totals.lines_added)} / −${formatCount(totals.lines_removed)}`} />
            <StatCard
                label="Code churn"
                value={totals.avg_churn_rate === null ? '—' : formatPercent(totals.avg_churn_rate)}
                hint="recently-rewritten code"
            />
        </div>
    );
}

// --- Churn explanation -----------------------------------------------------

function ChurnExplainer({churn}: {churn: number | null}): JSX.Element {
    return (
        <Card title="What code churn means">
            <p className="text-sm text-muted">
                Churn is the share of your recently-written code that gets rewritten or deleted again
                soon after. {churn === null ? 'There isn’t enough data to estimate it for this range yet.' : `Across this range it averaged about ${formatPercent(churn)}.`}
            </p>
            <p className="mt-2 text-sm text-muted">
                A higher number isn’t automatically bad — it often just reflects healthy iteration or
                exploratory work. It’s only worth a second look if it stays consistently high, which can
                be a hint to review changes a little more before committing. This is a rough indicator,
                not a precise figure.
            </p>
        </Card>
    );
}

// --- Multi-provider breakdown ----------------------------------------------

/** True when the breakdown contains a merged multi-provider bucket. */
function hasMultiBucket(providers: MeProviderActivity[]): boolean {
    return providers.some((p) => p.provider === 'multi');
}

function ProviderBreakdown({providers}: {providers: MeProviderActivity[]}): JSX.Element {
    return (
        <Card title="Across your git providers">
            <p className="-mt-2 mb-4 text-xs text-muted">
                Your activity aggregated across every git provider you use.
            </p>
            <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="provider-table">
                    <thead>
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted">
                            <th className="pb-2 pr-4 font-medium">Provider</th>
                            <th className="pb-2 pr-4 text-right font-medium">Commits</th>
                            <th className="pb-2 pr-4 text-right font-medium">PRs merged</th>
                            <th className="pb-2 text-right font-medium">Lines changed</th>
                        </tr>
                    </thead>
                    <tbody>
                        {providers.map((p) => (
                            <tr key={p.provider} className="border-b border-border/60 last:border-0">
                                <td className="py-2 pr-4 text-foreground">
                                    {p.provider === 'multi' ? 'Multiple providers' : providerLabel(p.provider)}
                                </td>
                                <td className="py-2 pr-4 text-right tabular-nums text-foreground">{formatCount(p.commits)}</td>
                                <td className="py-2 pr-4 text-right tabular-nums text-foreground">{formatCount(p.prs_merged)}</td>
                                <td className="py-2 text-right tabular-nums text-foreground">
                                    {formatCount(p.lines_added + p.lines_removed)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {hasMultiBucket(providers) ? (
                <p className="mt-3 text-xs text-muted">
                    “Multiple providers” covers days you were active on more than one provider, which are
                    recorded together. Your totals above always reflect the full cross-provider sum.
                </p>
            ) : null}
        </Card>
    );
}

// --- Git activity over time ------------------------------------------------

function gitTimelineData(timeline: MeTimeline | undefined): ChartDatum[] {
    return (timeline?.points ?? []).map((p) => ({
        date: p.date,
        commits: p.git_activity.commits,
        prs: p.git_activity.prs_merged,
        lines: p.git_activity.lines_added + p.git_activity.lines_removed,
    }));
}

function correlationData(timeline: MeTimeline | undefined): ChartDatum[] {
    return (timeline?.points ?? []).map((p) => ({
        date: p.date,
        interactions: p.tool_activity.interaction_count,
        commits: p.git_activity.commits,
    }));
}

// --- Page ------------------------------------------------------------------

function LoadingActivity(): JSX.Element {
    return (
        <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
            </div>
            <Card>
                <SkeletonChart />
            </Card>
        </>
    );
}

/** True when there's no git signal at all in the window. */
function isEmptyActivity(activity: MeActivity): boolean {
    const t = activity.totals;
    return (
        t.commits === 0 &&
        t.prs_opened === 0 &&
        t.prs_merged === 0 &&
        t.lines_added === 0 &&
        t.lines_removed === 0
    );
}

function PageHeader({children}: {children?: JSX.Element}): JSX.Element {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">My Activity</h1>
                <p className="mt-1 text-sm text-muted">
                    Your git output and how it relates to your AI usage — visible only to you.
                </p>
            </div>
            {children}
        </div>
    );
}

/**
 * The time-ranged body. Split out so it only mounts after the journey has
 * settled and `earliest` is known — `useTimeRange` then resolves its smart
 * default on its first render, so the content never flashes back to a skeleton
 * when the journey-derived window arrives.
 */
function MyActivityContent({earliest}: {earliest: string | null}): JSX.Element {
    const {range, setRange} = useTimeRange({earliest});
    const activity = useMeActivity(range);
    const timeline = useMeTimeline(range);

    const isPending = activity.isPending;
    const isError = activity.isError;

    const points = timeline.data?.points ?? [];
    const dataDays = points.length;
    const spanDays = timeline.data ? inclusiveDayCount(timeline.data.from, timeline.data.to) : undefined;
    const empty = !isPending && !isError && activity.data ? isEmptyActivity(activity.data) : false;

    return (
        <div className="space-y-6">
            <PageHeader>
                <TimeRangeSelector value={range} onChange={setRange} earliest={earliest} />
            </PageHeader>

            {isPending ? <LoadingActivity /> : null}

            {isError ? (
                <ErrorState
                    title="Failed to load your activity"
                    detail={activity.error?.message}
                    onRetry={() => void activity.refetch()}
                />
            ) : null}

            {empty ? (
                <StatePanel
                    tone="accent"
                    testId="my-activity-empty"
                    title="No git activity yet"
                    description="Once your commits and pull requests are tracked across your git providers, your activity and AI-vs-output view will appear here."
                />
            ) : null}

            {!isPending && !isError && !empty && activity.data ? (
                <>
                    <ActivityStats totals={activity.data.totals} />

                    <Card>
                        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <h2 className="text-sm font-semibold text-foreground">Git activity over time</h2>
                                <p className="mt-0.5 text-xs text-muted">Your commits, PRs merged, and lines changed by day.</p>
                            </div>
                            <CoverageBadge dataDays={dataDays} spanDays={spanDays} />
                        </div>
                        <TrendChart
                            data={gitTimelineData(timeline.data)}
                            xKey="date"
                            series={[
                                {key: 'lines', label: 'Lines changed', axis: 'left'},
                                {key: 'commits', label: 'Commits', axis: 'right'},
                                {key: 'prs', label: 'PRs merged', axis: 'right'},
                            ]}
                            variant="line"
                            xTickFormatter={formatDateTick}
                            emptyMessage="No git activity in this range yet."
                            testId="git-trend"
                        />
                    </Card>

                    <Card>
                        <div className="mb-1">
                            <h2 className="text-sm font-semibold text-foreground">AI usage vs. output</h2>
                            <p className="mt-0.5 text-xs text-muted">
                                Your AI interactions alongside your commits over the same days.
                            </p>
                        </div>
                        <p className="mb-4 rounded-card bg-surface-raised px-3 py-2 text-xs text-muted" data-testid="correlation-caveat">
                            These two lines simply move along the same timeline. Seeing them rise or fall
                            together is a correlation, not proof that one causes the other — plenty of other
                            things shape how much you ship.
                        </p>
                        <TrendChart
                            data={correlationData(timeline.data)}
                            xKey="date"
                            series={[
                                {key: 'interactions', label: 'AI interactions', axis: 'left'},
                                {key: 'commits', label: 'Commits', axis: 'right'},
                            ]}
                            variant="line"
                            xTickFormatter={formatDateTick}
                            emptyMessage="No activity in this range yet."
                            testId="correlation-trend"
                        />
                    </Card>

                    <ChurnExplainer churn={activity.data.totals.avg_churn_rate} />

                    {activity.data.providers.length > 0 ? (
                        <ProviderBreakdown providers={activity.data.providers} />
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

export function MyActivity(): JSX.Element {
    // Settle the journey first so `earliest` is known before the time-ranged
    // content mounts; the journey query is shared (cached) with the other
    // developer screens.
    const journey = useMeJourney();

    if (journey.isPending) {
        return (
            <div className="space-y-6">
                <PageHeader />
                <LoadingActivity />
            </div>
        );
    }

    return <MyActivityContent earliest={earliestJourneyStart(journey.data)} />;
}
