import {useMeJourney, useMeOverview, useMeTimeline} from '../hooks/useMe';
import {useTimeRange} from '../hooks/useTimeRange';
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
import {inclusiveDayCount, presetValue} from '../timeRange/range';
import {earliestJourneyStart} from '../components/meHelpers';
import {JourneyTimeline} from '../components/JourneyTimeline';
import type {MeOverview, MeTimeline} from '../api/types';

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

/**
 * Distinct active days in the trailing 7 days of a timeline, using the same
 * "tool active OR a commit landed" definition as the server's active_days, and
 * anchored to the timeline's server-resolved `to` date so the count never drifts
 * with the browser clock. Returns null until the timeline has loaded.
 */
function weekActiveDays(timeline: MeTimeline | undefined): number | null {
    if (!timeline) {
        return null;
    }
    const toMs = Date.parse(`${timeline.to}T00:00:00.000Z`);
    if (Number.isNaN(toMs)) {
        return null;
    }
    const cutoffMs = toMs - 6 * 86_400_000; // inclusive 7-day window ending at `to`
    let count = 0;
    for (const point of timeline.points) {
        const dayMs = Date.parse(`${point.date}T00:00:00.000Z`);
        if (Number.isNaN(dayMs) || dayMs < cutoffMs) {
            continue;
        }
        if (point.tool_activity.is_active || point.git_activity.commits > 0) {
            count += 1;
        }
    }
    return count;
}

// --- Personal stat cards ---------------------------------------------------

function StatCards({month, weekDays}: {month: MeOverview; weekDays: number | null}): JSX.Element {
    const primary = month.primary_tools[0];
    const extraTools = month.primary_tools.length - 1;
    const {current, previous} = month.acceptance_rate;

    // Acceptance card: show the rate plus a points-delta chip when we can compare
    // two halves. The chip and the hint are both driven off the same client-side
    // delta so they can never disagree (e.g. an "up" hint beside a 0pp chip).
    const acceptanceValue = current === null ? '—' : formatPercent(current);
    const showDelta = current !== null && previous !== null;
    const deltaPoints = showDelta ? Math.round((current - previous) * 100) : 0;
    let acceptanceHint: string;
    if (current === null) {
        acceptanceHint = 'no suggestions yet';
    } else if (!showDelta || deltaPoints === 0) {
        acceptanceHint = 'holding steady';
    } else {
        acceptanceHint = deltaPoints > 0 ? 'trending up' : 'trending down';
    }

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
                label="Active days"
                value={String(month.active_days)}
                hint={
                    weekDays !== null
                        ? `${weekDays} this week · last 30 days`
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
                hint={acceptanceHint}
                trend={showDelta && deltaPoints !== 0 ? {value: deltaPoints, goodWhen: 'up', suffix: 'pp'} : undefined}
            />
            <StatCard
                label="Your AI cost"
                value={formatCurrency(month.estimated_monthly_cost)}
                hint="estimated monthly spend"
            />
        </div>
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
    // Stat cards read a fixed 30-day window so the headline numbers stay stable
    // regardless of the trend chart's own range selector. The "this week" figure
    // is derived from the same fixed 30-day timeline rather than a second
    // overview round-trip — one cheap per-day series covers both windows, and
    // both anchor to the server-resolved dates (no browser-clock drift). When the
    // chart's range is also 30d, React Query dedupes the two timeline reads.
    const month = useMeOverview({range: '30d'});
    const monthTimeline = useMeTimeline(presetValue('30d'));
    const journey = useMeJourney();
    const weekDays = weekActiveDays(monthTimeline.data);

    // Structural load/error gate keys off the month summary + journey; the trend
    // chart owns its own loading/error inline.
    const isPending = month.isPending || journey.isPending;
    const isError = month.isError || journey.isError;

    const earliest = earliestJourneyStart(journey.data);
    // "Building your history": no tool ever tracked and nothing active recently.
    const isColdStart =
        !isPending && !isError && (journey.data?.tools.length ?? 0) === 0 && (month.data?.active_days ?? 0) === 0;
    // Low-data: real but young history — a gentle, encouraging note, not a block.
    // Measure tenure to the server-resolved overview date (falling back to the
    // browser clock only before it loads) so the threshold never drifts a day on
    // a clock-skewed client, consistent with the week-active-days derivation.
    const today = month.data?.to ?? isoDate(new Date());
    const historyDays = earliest ? inclusiveDayCount(earliest, today) : 0;
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
                    <StatCards month={month.data} weekDays={weekDays} />
                    {journey.data ? <JourneyTimeline journey={journey.data} framing="self" /> : null}
                    <ActivityTrend earliest={earliest} />
                </>
            ) : null}
        </div>
    );
}
