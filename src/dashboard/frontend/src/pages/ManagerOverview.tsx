import {Link} from 'react-router-dom';
import {useOverview} from '../hooks/useOverview';
import {useCoverage, useOverviewTrend, useToolDistribution, useWasteSummary} from '../hooks/useManagerData';
import {useTimeRange} from '../hooks/useTimeRange';
import {Card, StatCard} from '../components/Card';
import {CoveragePanel} from '../components/CoveragePanel';
import {CoverageBadge} from '../components/CoverageBadge';
import {DataTable, type Column} from '../components/DataTable';
import {TimeRangeSelector} from '../components/TimeRangeSelector';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {DistributionChart, type DistributionSlice} from '../charts/DistributionChart';
import {SkeletonChart, SkeletonStatCard, SkeletonText} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {ColdStartPanel, type ConnectorStatus} from '../components/ColdStartPanel';
import {classifyDataState} from '../components/dataState';
import {toolLabel} from '../components/toolLabels';
import {inclusiveDayCount} from '../timeRange/range';
import type {OverviewData, ToolDistributionEntry, WasteTeamSummary} from '../api/types';

function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0}).format(value);
}

/** Whole-number percent for utilization-style ratios. */
function formatPercent(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
}

/** 'YYYY-MM-DD' → a short, locale-aware axis tick (e.g. "May 5"). */
function formatDateTick(value: string | number): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    return new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'}).format(date);
}

// The connectors GovProxy can pull from. We always list all three so the
// cold-start panel shows what's still unconnected, not just what's wired up.
// `id` must match the tool string the backend writes into tool_snapshots (see
// each connector's transformer, e.g. claude-code → 'claude_code'); `label` is
// the human-facing chip text.
const KNOWN_CONNECTORS = [
    {id: 'copilot', label: 'Copilot'},
    {id: 'claude_code', label: 'Claude Code'},
    {id: 'windsurf', label: 'Windsurf'},
] as const;

/**
 * Count of collected tool snapshots backing the overview. The API's
 * data_quality_distribution is `COUNT(*) FROM tool_snapshots GROUP BY
 * data_quality`, so this is a snapshot-row count (not distinct developers). We
 * sum every bucket except `none` — `none` is the only "no data collected"
 * tier, so excluding it leaves "snapshots that actually carry a signal". Used
 * only as a has-any-data boolean, where the exact count doesn't matter.
 */
function collectedSnapshotCount(data: OverviewData): number {
    const dist = data.data_quality_distribution;
    return (dist?.high ?? 0) + (dist?.medium ?? 0) + (dist?.low ?? 0);
}

function connectorStatuses(data: OverviewData): ConnectorStatus[] {
    const tools = data.active_tools ?? [];
    return KNOWN_CONNECTORS.map(({id, label}) => ({name: label, connected: tools.includes(id)}));
}

function LoadingOverview(): JSX.Element {
    return (
        <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
            </div>
            <Card title="Adoption trend">
                <SkeletonChart />
            </Card>
        </>
    );
}

// --- Top-line metric cards -------------------------------------------------

function MetricCards({data}: {data: OverviewData}): JSX.Element {
    // Utilization is an org-level proxy: distinct developers active in the last
    // 30 days over paid (non-revoked) seats. active_developers counts developers,
    // not seats, so a developer active without a tracked subscription can push
    // the ratio over 100% — clamp the headline so it never reads above full.
    const paidSeats = data.total_subscriptions;
    const utilization = paidSeats > 0 ? Math.min(1, data.active_developers / paidSeats) : null;

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
                label="Active developers"
                value={`${data.active_developers} / ${data.total_developers}`}
                hint="active in last 30 days"
            />
            <StatCard label="Monthly spend" value={formatCurrency(data.total_monthly_cost)} hint="across all tools" />
            <StatCard
                label="Utilization"
                value={utilization === null ? '—' : formatPercent(utilization)}
                hint={
                    paidSeats > 0
                        ? `${data.active_developers} active / ${paidSeats} paid seats`
                        : 'no paid seats yet'
                }
            />
            <StatCard
                label="Potential savings"
                value={formatCurrency(data.total_monthly_waste)}
                hint={`${data.active_waste_alert_count} active ${
                    data.active_waste_alert_count === 1 ? 'alert' : 'alerts'
                }`}
            />
        </div>
    );
}

// --- Hero adoption-trend chart ---------------------------------------------

function AdoptionTrend(): JSX.Element {
    const {range, setRange} = useTimeRange();
    const {data, isPending, isError, error, refetch} = useOverviewTrend(range);

    // Honest coverage: measure days with data and the span from the window the
    // backend actually resolved (correct even for lifetime, which it widens to
    // the earliest record), not the client-side preview window.
    const points = data?.points ?? [];
    const dataDays = points.length;
    const spanDays = data ? inclusiveDayCount(data.from, data.to) : undefined;
    // Plot only the active-developer measure; annotate as ChartDatum[] so the
    // mapped literals satisfy the chart's index-signature row type.
    const chartData: ChartDatum[] = points.map((p) => ({date: p.date, active_developers: p.active_developers}));

    return (
        <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-foreground">Adoption trend</h2>
                    <p className="mt-0.5 text-xs text-muted">Active developers over time.</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                    <TimeRangeSelector value={range} onChange={setRange} />
                    {!isPending && !isError ? <CoverageBadge dataDays={dataDays} spanDays={spanDays} /> : null}
                </div>
            </div>
            {isPending ? <SkeletonChart /> : null}
            {isError ? (
                <ErrorState title="Failed to load trend" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}
            {!isPending && !isError ? (
                <TrendChart
                    data={chartData}
                    xKey="date"
                    series={[{key: 'active_developers', label: 'Active developers'}]}
                    variant="area"
                    xTickFormatter={formatDateTick}
                    emptyMessage="No activity in this range yet."
                />
            ) : null}
        </Card>
    );
}

// --- Tool distribution -----------------------------------------------------

const TOOL_COLUMNS: Column<ToolDistributionEntry>[] = [
    {key: 'tool', header: 'Tool', accessor: (r) => toolLabel(r.tool)},
    {key: 'developers', header: 'Developers', accessor: (r) => r.developers, align: 'right'},
    {key: 'seats', header: 'Seats', accessor: (r) => r.seats, align: 'right'},
    {
        key: 'monthly_cost',
        header: 'Cost',
        accessor: (r) => r.monthly_cost,
        align: 'right',
        render: (r) => formatCurrency(r.monthly_cost),
    },
];

function ToolDistributionCard(): JSX.Element {
    const {data, isPending, isError, error, refetch} = useToolDistribution();
    const tools = data?.tools ?? [];
    const slices: DistributionSlice[] = tools.map((t) => ({label: toolLabel(t.tool), value: t.monthly_cost}));

    return (
        <Card title="Tool distribution">
            {isPending ? <SkeletonChart /> : null}
            {isError ? (
                <ErrorState title="Failed to load tools" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}
            {!isPending && !isError && tools.length === 0 ? (
                <EmptyState title="No tool subscriptions" message="Import expense data to see the tool mix." />
            ) : null}
            {!isPending && !isError && tools.length > 0 ? (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <DistributionChart
                        data={slices}
                        valueFormatter={(v) => formatCurrency(Number(v))}
                        centerLabel={{value: formatCurrency(data?.total_monthly_cost ?? 0), caption: 'monthly'}}
                        emptyMessage="No spend recorded."
                    />
                    <DataTable
                        columns={TOOL_COLUMNS}
                        rows={tools}
                        getRowKey={(r) => r.tool}
                        initialSort={{key: 'monthly_cost', direction: 'desc'}}
                        caption="Developers, seats, and monthly cost per tool"
                    />
                </div>
            ) : null}
        </Card>
    );
}

// --- Quick links + needs attention -----------------------------------------

function QuickLink({to, label, sublabel}: {to: string; label: string; sublabel: string}): JSX.Element {
    return (
        <Link
            to={to}
            className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2.5 transition-colors hover:bg-surface-raised"
        >
            <span>
                <span className="block text-sm font-medium text-foreground">{label}</span>
                <span className="block text-xs text-muted">{sublabel}</span>
            </span>
            <span aria-hidden className="text-muted">
                →
            </span>
        </Link>
    );
}

function NeedsAttention(): JSX.Element {
    const {data, isPending, isError} = useWasteSummary();
    // The summary is ordered by waste descending, so the first few teams are the
    // ones bleeding the most. Surface up to three; a calm note when all is clear.
    const topTeams: WasteTeamSummary[] = (data ?? []).filter((t) => t.total_monthly_waste > 0).slice(0, 3);

    return (
        <Card title="Needs attention">
            {isPending ? (
                <SkeletonText lines={3} />
            ) : isError || topTeams.length === 0 ? (
                <p className="text-sm text-muted">No teams need attention right now.</p>
            ) : (
                <ul className="space-y-2">
                    {topTeams.map((team) => (
                        <li key={team.team}>
                            <Link
                                to="/manager/waste"
                                className="flex items-center justify-between rounded-md px-2 py-1.5 transition-colors hover:bg-surface-raised"
                            >
                                <span className="text-sm font-medium text-foreground">{team.team}</span>
                                <span className="text-right">
                                    <span className="block text-sm font-medium text-danger">
                                        {formatCurrency(team.total_monthly_waste)}/mo
                                    </span>
                                    <span className="block text-xs text-muted">
                                        {team.alert_count} {team.alert_count === 1 ? 'alert' : 'alerts'}
                                    </span>
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}

// --- Data coverage indicator -----------------------------------------------

function DataCoverage(): JSX.Element {
    const {data, isPending, isError, error, refetch} = useCoverage();

    return (
        <Card title="Data coverage">
            {isPending ? <SkeletonText lines={5} /> : null}
            {isError ? (
                <ErrorState title="Failed to load coverage" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}
            {!isPending && !isError && data ? <CoveragePanel coverage={data} /> : null}
        </Card>
    );
}

export function ManagerOverview(): JSX.Element {
    const {data, isPending, isError, error, refetch} = useOverview();

    // Drive the page through the shared classifier. The org overview is a
    // point-in-time aggregate with no per-scope collection window, so we pass no
    // `dataDays`: the classifier then resolves to cold-start (connected but no
    // signal yet, or nothing connected), ready (signal present), loading, or
    // error — never the day-windowed 'empty', which belongs to scopes that do
    // track collection days.
    const state = classifyDataState({
        isLoading: isPending,
        error: isError ? error : null,
        connected: data ? (data.active_tools ?? []).length > 0 : false,
        hasSignal: data ? collectedSnapshotCount(data) > 0 : false,
    });

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Organization Overview</h1>
                <p className="mt-1 text-sm text-muted">Unified AI adoption across all connected tools.</p>
            </div>

            {state === 'loading' ? <LoadingOverview /> : null}

            {state === 'error' ? (
                <ErrorState title="Failed to load overview" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}

            {state === 'cold-start' && data ? (
                <ColdStartPanel
                    scopeLabel="your organization"
                    connectors={connectorStatuses(data)}
                    checklist={[
                        {label: 'Register developers', done: data.total_developers > 0},
                        {label: 'Connect a tool', done: (data.active_tools ?? []).length > 0},
                        {label: 'First sync collected', done: collectedSnapshotCount(data) > 0},
                    ]}
                />
            ) : null}

            {state === 'ready' && data ? (
                <>
                    <MetricCards data={data} />
                    <AdoptionTrend />
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                        <div className="lg:col-span-2">
                            <ToolDistributionCard />
                        </div>
                        <div className="space-y-6">
                            <Card title="Quick links">
                                <div className="space-y-2">
                                    <QuickLink to="/manager/teams" label="Teams" sublabel="Adoption & cost by team" />
                                    <QuickLink
                                        to="/manager/waste"
                                        label="Waste detection"
                                        sublabel="Unused & duplicate seats"
                                    />
                                </div>
                            </Card>
                            <NeedsAttention />
                        </div>
                    </div>
                    <DataCoverage />
                </>
            ) : null}
        </div>
    );
}
