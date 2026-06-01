import {useMeJourney, useMeOverview, useMeTimeline} from '../hooks/useMe';
import {useTimeRange} from '../hooks/useTimeRange';
import type {TimeRangeQuery} from '../api/client';
import {Card, StatCard} from '../components/Card';
import {TimeRangeSelector} from '../components/TimeRangeSelector';
import {CoverageBadge} from '../components/CoverageBadge';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {SkeletonChart, SkeletonStatCard, SkeletonText} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {StatePanel} from '../components/StatePanel';
import {SIGNIFICANCE_DAYS} from '../components/dataState';
import {toolLabel} from '../components/toolLabels';
import {formatCurrency, formatPercent, formatDateTick} from '../components/format';
import {inclusiveDayCount} from '../timeRange/range';
import type {MeJourney, MeJourneyEvent, MeJourneyTool, MeOverview} from '../api/types';

/**
 * Developer "My Dashboard" (Task 2.8). The developer's private landing screen:
 * personal stats, adoption journey, and activity trend — framed as personal
 * growth, never a report card and never compared to peers. Every query is
 * session-scoped server-side, so nothing here can reach another developer's
 * data, and no ranking or comparison appears anywhere by construction.
 */

/** YYYY-MM-DD for a Date (UTC). */
function isoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** A `[today-(days-1), today]` inclusive window as a raw range query. */
function trailingWindow(days: number): TimeRangeQuery {
    const to = new Date();
    const from = new Date(to.getTime());
    from.setUTCDate(from.getUTCDate() - (days - 1));
    return {from: isoDate(from), to: isoDate(to)};
}

/** Earliest started_on across all journey tools, or null if none recorded. */
function earliestStart(journey: MeJourney | undefined): string | null {
    if (!journey) {
        return null;
    }
    let earliest: string | null = null;
    for (const tool of journey.tools) {
        if (tool.started_on && (earliest === null || tool.started_on < earliest)) {
            earliest = tool.started_on;
        }
    }
    return earliest;
}

/** 'YYYY-MM-DD' → "March 2026" for milestone labels; passes through bad input. */
function formatMonthYear(value: string): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat(undefined, {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(date);
}

// --- Personal stat cards ---------------------------------------------------

function StatCards({month, week}: {month: MeOverview; week: MeOverview | undefined}): JSX.Element {
    const primary = month.primary_tools[0];
    const extraTools = month.primary_tools.length - 1;
    const {current, previous, trend} = month.acceptance_rate;

    // Acceptance card: show the rate plus a points-delta chip when we can compare
    // two halves. When there's nothing to compare, name the direction softly
    // rather than implying a precise move.
    const acceptanceValue = current === null ? '—' : formatPercent(current);
    const showDelta = current !== null && previous !== null;
    const deltaPoints = showDelta ? Math.round((current! - previous!) * 100) : 0;
    const trendHint = trend === 'flat' ? 'holding steady' : trend === 'up' ? 'trending up' : 'trending down';

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
                label="Active days"
                value={String(month.active_days)}
                hint={
                    week
                        ? `${week.active_days} this week · last 30 days`
                        : 'in the last 30 days'
                }
            />
            <StatCard
                label="Primary tool"
                value={primary ? toolLabel(primary) : '—'}
                hint={
                    primary
                        ? extraTools > 0
                            ? `+${extraTools} other ${extraTools === 1 ? 'tool' : 'tools'} in use`
                            : 'your most-used tool'
                        : 'no tool activity yet'
                }
            />
            <StatCard
                label="Acceptance rate"
                value={acceptanceValue}
                hint={current === null ? 'no suggestions yet' : trendHint}
                trend={showDelta ? {value: deltaPoints, goodWhen: 'up', suffix: 'pp'} : undefined}
            />
            <StatCard
                label="Your AI cost"
                value={formatCurrency(month.estimated_monthly_cost)}
                hint="estimated monthly spend"
            />
        </div>
    );
}

// --- Adoption journey ------------------------------------------------------

/** A signed monthly-cost delta like "+$180/mo", or null when costs are absent. */
function costDelta(oldCost: number | null, newCost: number | null): string | null {
    if (oldCost === null || newCost === null) {
        return null;
    }
    const delta = newCost - oldCost;
    if (delta === 0) {
        return null;
    }
    const sign = delta > 0 ? '+' : '−';
    return `${sign}${formatCurrency(Math.abs(delta))}/mo`;
}

function journeyEventText(event: MeJourneyEvent): {title: string; detail: string | null} {
    const tool = toolLabel(event.tool);
    if (event.type === 'started') {
        return {title: `Started using ${tool}`, detail: null};
    }
    if (event.type === 'tool_switch') {
        const from = event.from_tool ? toolLabel(event.from_tool) : 'another tool';
        return {title: `Switched from ${from} to ${tool}`, detail: costDelta(event.old_monthly_cost, event.new_monthly_cost)};
    }
    // plan_change
    const from = event.from_plan ?? 'previous plan';
    const to = event.to_plan ?? 'a new plan';
    return {title: `${tool}: ${from} → ${to}`, detail: costDelta(event.old_monthly_cost, event.new_monthly_cost)};
}

function ToolSummary({tool}: {tool: MeJourneyTool}): JSX.Element {
    const parts: string[] = [];
    if (tool.started_on) {
        parts.push(`since ${formatMonthYear(tool.started_on)}`);
    }
    if (tool.active && tool.current_plan) {
        parts.push(tool.current_plan);
    }
    return (
        <span
            className={[
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                tool.active ? 'bg-accent-soft text-accent' : 'bg-surface-raised text-muted',
            ].join(' ')}
        >
            <span className="font-semibold">{toolLabel(tool.tool)}</span>
            {parts.length > 0 ? <span className="text-muted">{parts.join(' · ')}</span> : null}
        </span>
    );
}

function AdoptionJourney({journey}: {journey: MeJourney}): JSX.Element {
    return (
        <Card title="My adoption journey">
            <p className="-mt-2 mb-4 text-xs text-muted">
                When you started with each tool and how your setup has evolved.
            </p>

            {journey.tools.length > 0 ? (
                <div className="mb-5 flex flex-wrap gap-2" data-testid="journey-tools">
                    {journey.tools.map((tool) => (
                        <ToolSummary key={tool.tool} tool={tool} />
                    ))}
                </div>
            ) : null}

            {journey.events.length > 0 ? (
                <ol className="space-y-4" data-testid="journey-timeline">
                    {journey.events.map((event, i) => {
                        const {title, detail} = journeyEventText(event);
                        return (
                            <li key={`${event.date}-${event.type}-${event.tool}-${i}`} className="flex gap-3">
                                <div className="flex flex-col items-center">
                                    <span aria-hidden className="mt-1 h-2.5 w-2.5 rounded-full bg-accent" />
                                    {i < journey.events.length - 1 ? (
                                        <span aria-hidden className="mt-1 w-px flex-1 bg-border" />
                                    ) : null}
                                </div>
                                <div className="pb-1">
                                    <p className="text-xs font-medium uppercase tracking-wider text-muted">
                                        {formatMonthYear(event.date)}
                                    </p>
                                    <p className="text-sm font-medium text-foreground">{title}</p>
                                    {detail ? <p className="text-xs text-muted">{detail}</p> : null}
                                </div>
                            </li>
                        );
                    })}
                </ol>
            ) : (
                <p className="text-sm text-muted">
                    Your journey starts here — milestones will appear as your tool usage is tracked.
                </p>
            )}
        </Card>
    );
}

// --- Personal activity trend -----------------------------------------------

function ActivityTrend({earliest}: {earliest: string | null}): JSX.Element {
    const {range, setRange} = useTimeRange({earliest});
    const {data, isPending, isError, error, refetch} = useMeTimeline(range);

    const points = data?.points ?? [];
    const dataDays = points.length;
    const spanDays = data ? inclusiveDayCount(data.from, data.to) : undefined;
    const chartData: ChartDatum[] = points.map((p) => ({
        date: p.date,
        interactions: p.tool_activity.interaction_count,
        commits: p.git_activity.commits,
        prs: p.git_activity.prs_merged,
    }));

    return (
        <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-foreground">My activity trend</h2>
                    <p className="mt-0.5 text-xs text-muted">
                        Your AI interactions over time, with your git activity (commits, PRs) overlaid.
                    </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                    <TimeRangeSelector value={range} onChange={setRange} earliest={earliest} />
                    {!isPending && !isError ? <CoverageBadge dataDays={dataDays} spanDays={spanDays} /> : null}
                </div>
            </div>
            {isPending ? <SkeletonChart /> : null}
            {isError ? (
                <ErrorState title="Failed to load your activity" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}
            {!isPending && !isError ? (
                <TrendChart
                    data={chartData}
                    xKey="date"
                    series={[
                        {key: 'interactions', label: 'AI interactions', axis: 'left'},
                        {key: 'commits', label: 'Commits', axis: 'right'},
                        {key: 'prs', label: 'PRs merged', axis: 'right'},
                    ]}
                    variant="line"
                    xTickFormatter={formatDateTick}
                    emptyMessage="No activity in this range yet."
                />
            ) : null}
        </Card>
    );
}

// --- Page ------------------------------------------------------------------

function LoadingDashboard(): JSX.Element {
    return (
        <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
            </div>
            <Card title="My adoption journey">
                <SkeletonText lines={4} />
            </Card>
            <Card>
                <SkeletonChart />
            </Card>
        </>
    );
}

export function DeveloperDashboard(): JSX.Element {
    // Stat cards read fixed trailing windows (week + month) so the headline
    // numbers stay stable regardless of the trend chart's own range selector.
    const month = useMeOverview({range: '30d'});
    const week = useMeOverview(trailingWindow(7));
    const journey = useMeJourney();

    // Structural load/error gate keys off the month summary + journey; the trend
    // chart owns its own loading/error inline.
    const isPending = month.isPending || journey.isPending;
    const isError = month.isError || journey.isError;

    const earliest = earliestStart(journey.data);
    // "Building your history": no tool ever tracked and nothing active recently.
    const isColdStart =
        !isPending && !isError && (journey.data?.tools.length ?? 0) === 0 && (month.data?.active_days ?? 0) === 0;
    // Low-data: real but young history — a gentle, encouraging note, not a block.
    const historyDays = earliest ? inclusiveDayCount(earliest, isoDate(new Date())) : 0;
    const isLowData = !isColdStart && earliest !== null && historyDays < SIGNIFICANCE_DAYS;

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">My Dashboard</h1>
                <p className="mt-1 text-sm text-muted">Your personal AI adoption journey.</p>
            </div>

            {isPending ? <LoadingDashboard /> : null}

            {isError ? (
                <ErrorState
                    title="Failed to load your dashboard"
                    detail={(month.error ?? journey.error)?.message}
                    onRetry={() => {
                        void month.refetch();
                        void journey.refetch();
                    }}
                />
            ) : null}

            {isColdStart ? (
                <StatePanel
                    tone="accent"
                    testId="developer-cold-start"
                    icon={
                        <span className="relative flex h-2.5 w-2.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
                        </span>
                    }
                    title="Building your history"
                    description="As your AI tool and git activity is tracked, your personal stats and adoption journey will appear here. Check back in a few days."
                />
            ) : null}

            {!isPending && !isError && !isColdStart && month.data ? (
                <>
                    {isLowData ? (
                        <div
                            data-testid="low-data-note"
                            className="rounded-card border border-dashed border-border bg-accent-soft/40 px-4 py-3 text-sm text-foreground"
                        >
                            <span className="font-medium">We're still building your history.</span>{' '}
                            <span className="text-muted">
                                You&apos;ve been tracked for {historyDays} {historyDays === 1 ? 'day' : 'days'} so far —
                                your trends will get richer as more days are collected.
                            </span>
                        </div>
                    ) : null}
                    <StatCards month={month.data} week={week.data} />
                    {journey.data ? <AdoptionJourney journey={journey.data} /> : null}
                    <ActivityTrend earliest={earliest} />
                </>
            ) : null}
        </div>
    );
}
