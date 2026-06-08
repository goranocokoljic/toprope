import {Link, useParams} from 'react-router-dom';
import {useTeamDetail, useTeamProviders, useTeamTrend, useTeamWaste} from '../hooks/useTeamData';
import {useAnomalies} from '../hooks/useAnomalies';
import {severityTone, severityLabel} from '../components/anomalies';
import {useTimeRange} from '../hooks/useTimeRange';
import {ApiError} from '../api/client';
import {Card, StatCard} from '../components/Card';
import {Badge} from '../components/Badge';
import {DataTable, type Column} from '../components/DataTable';
import {TimeRangeSelector} from '../components/TimeRangeSelector';
import {CoverageBadge} from '../components/CoverageBadge';
import {MaturityTrendCard} from '../components/MaturityTrendCard';
import {SummariesPanel} from '../components/SummariesPanel';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {SkeletonChart, SkeletonStatCard, SkeletonTable, SkeletonText} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {providerLabel, toolLabel} from '../components/toolLabels';
import {activityTier, utilizationTier, wasteTypeLabel} from '../components/utilization';
import {formatCurrency, formatPercent, formatDateTick} from '../components/format';
import {inclusiveDayCount} from '../timeRange/range';
import type {DeveloperInTeam, TeamDetail as TeamDetailData, WasteAlert} from '../api/types';

// --- Scoped summary cards --------------------------------------------------

function SummaryCards({team}: {team: TeamDetailData}): JSX.Element {
    // `active_count` is defined server-side (same query as the teams list), so
    // the detail header can never drift from the list's "active" definition.
    const activeCount = team.active_count;
    const utilization = team.developer_count > 0 ? activeCount / team.developer_count : null;
    const tier = utilization === null ? null : utilizationTier(utilization);

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
                label="Active developers"
                value={`${activeCount} / ${team.developer_count}`}
                hint="active in last 30 days"
            />
            <StatCard
                label="Utilization"
                value={utilization === null ? '—' : formatPercent(utilization)}
                hint={tier ? tier.label : 'no developers yet'}
            />
            <StatCard label="Monthly cost" value={formatCurrency(team.total_monthly_cost)} hint="across all tools" />
            <StatCard
                label="Potential savings"
                value={formatCurrency(team.total_monthly_waste)}
                hint="from open waste alerts"
            />
        </div>
    );
}

// --- Team adoption trend ---------------------------------------------------

function AdoptionTrend({team}: {team: string}): JSX.Element {
    const {range, setRange} = useTimeRange();
    const {data, isPending, isError, error, refetch} = useTeamTrend(team, range);

    const points = data?.points ?? [];
    const dataDays = points.length;
    const spanDays = data ? inclusiveDayCount(data.from, data.to) : undefined;
    const chartData: ChartDatum[] = points.map((p) => ({date: p.date, active_developers: p.active_developers}));

    return (
        <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-foreground">Adoption trend</h2>
                    <p className="mt-0.5 text-xs text-muted">Active developers on this team over time.</p>
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

// --- Developer list (aggregate health, NOT a ranking) ----------------------

const ACTIVITY_DOT: Record<'success' | 'warning' | 'neutral', string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    neutral: 'bg-muted',
};

function ActivityCell({dev}: {dev: DeveloperInTeam}): JSX.Element {
    const tier = activityTier(dev.activity_summary.active_days_30d);
    const dot = ACTIVITY_DOT[tier.tone as 'success' | 'warning' | 'neutral'];
    return (
        <span className="inline-flex items-center gap-2">
            <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
            <Badge tone={tier.tone}>{tier.label}</Badge>
            <span className="text-xs text-muted">{dev.activity_summary.active_days_30d}d active</span>
        </span>
    );
}

const DEVELOPER_COLUMNS: Column<DeveloperInTeam>[] = [
    {
        key: 'name',
        header: 'Developer',
        accessor: (r) => r.name,
        render: (r) => (
            <Link
                to={`/manager/developers/${encodeURIComponent(r.id)}`}
                className="font-medium text-accent hover:underline"
            >
                {r.name}
            </Link>
        ),
    },
    {
        key: 'activity',
        header: 'Activity',
        accessor: (r) => r.activity_summary.active_days_30d,
        // Deliberately not sortable: this is a utilization-health view, not a
        // leaderboard — sorting developers by activity is the ranking the
        // product principle (and issue #41) forbids.
        sortable: false,
        render: (r) => <ActivityCell dev={r} />,
    },
    {
        key: 'tools',
        header: 'Tools',
        accessor: (r) => r.tools.length,
        render: (r) =>
            r.tools.length === 0 ? (
                <span className="text-muted">—</span>
            ) : (
                <span className="flex flex-wrap gap-1">
                    {r.tools.map((t) => (
                        <Badge key={t} tone="neutral">
                            {toolLabel(t)}
                        </Badge>
                    ))}
                </span>
            ),
    },
    {
        key: 'interactions',
        header: 'Interactions (30d)',
        accessor: (r) => r.activity_summary.total_interactions_30d,
        align: 'right',
        // Not sortable, for the same anti-leaderboard reason as Activity above.
        sortable: false,
        render: (r) => <span className="tabular-nums">{r.activity_summary.total_interactions_30d.toLocaleString()}</span>,
    },
    {
        key: 'cost',
        header: 'Monthly cost',
        accessor: (r) => r.subscription_cost,
        align: 'right',
        render: (r) => <span className="tabular-nums">{formatCurrency(r.subscription_cost)}</span>,
    },
];

function DeveloperList({team}: {team: TeamDetailData}): JSX.Element {
    return (
        <Card title="Team utilization health">
            <p className="mb-3 text-xs text-muted">
                Per-developer aggregate activity — a utilization-health view, not a performance ranking.
            </p>
            <DataTable
                columns={DEVELOPER_COLUMNS}
                rows={team.developers}
                getRowKey={(r) => r.id}
                initialSort={{key: 'name', direction: 'asc'}}
                emptyMessage="No developers in this team yet."
                caption="Developers with aggregate activity, tools, and cost — not ranked against each other"
            />
        </Card>
    );
}

// --- Tool breakdown --------------------------------------------------------

function ToolBreakdown({team}: {team: TeamDetailData}): JSX.Element {
    const tools = team.tool_breakdown;
    return (
        <Card title="Tool breakdown">
            {tools.length === 0 ? (
                <p className="text-sm text-muted">No tool activity or subscriptions for this team yet.</p>
            ) : (
                <ul className="space-y-2">
                    {tools.map((t) => (
                        <li key={t.tool} className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-foreground">{toolLabel(t.tool)}</span>
                            <span className="flex items-center gap-3 text-xs text-muted">
                                <span>
                                    {t.developers} {t.developers === 1 ? 'dev' : 'devs'}
                                </span>
                                <span className="tabular-nums text-foreground">{formatCurrency(t.monthly_cost)}/mo</span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}

// --- Git provider label ----------------------------------------------------

function GitProviders({team}: {team: string}): JSX.Element {
    const {data, isPending, isError, error, refetch} = useTeamProviders(team);
    const providers = (data?.providers ?? []).filter((p) => p.developer_count > 0);

    return (
        <Card title="Git provider">
            {isPending ? <SkeletonText lines={2} /> : null}
            {isError ? (
                <ErrorState title="Failed to load providers" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}
            {!isPending && !isError && providers.length === 0 ? (
                <p className="text-sm text-muted">No git activity recorded for this team.</p>
            ) : null}
            {!isPending && !isError && providers.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {providers.map((p) => (
                        <Badge key={p.provider} tone="accent" title={`${p.developer_count} developers with git activity`}>
                            {providerLabel(p.provider)}
                        </Badge>
                    ))}
                </div>
            ) : null}
        </Card>
    );
}

// --- Inline waste alerts ---------------------------------------------------

function WasteAlerts({team}: {team: string}): JSX.Element {
    const {data, isPending, isError, error, refetch} = useTeamWaste(team);
    const alerts: WasteAlert[] = data ?? [];

    return (
        <Card title="Waste alerts">
            {isPending ? <SkeletonText lines={3} /> : null}
            {/* A failed load must NOT read as "all clear" on a savings surface. */}
            {isError ? (
                <ErrorState title="Failed to load waste alerts" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}
            {!isPending && !isError && alerts.length === 0 ? (
                <p className="text-sm text-muted">No active waste alerts for this team.</p>
            ) : null}
            {!isPending && !isError && alerts.length > 0 ? (
                <>
                    <ul className="space-y-2">
                        {alerts.map((a) => (
                            <li key={a.id} className="flex items-center justify-between gap-3">
                                <span className="flex items-center gap-2">
                                    <Badge tone="danger">{wasteTypeLabel(a.alert_type)}</Badge>
                                    {a.tool ? <span className="text-xs text-muted">{toolLabel(a.tool)}</span> : null}
                                </span>
                                <span className="tabular-nums text-sm font-medium text-danger">
                                    {a.monthly_waste != null ? `${formatCurrency(a.monthly_waste)}/mo` : '—'}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <Link
                        to="/manager/waste"
                        className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
                    >
                        View waste detection →
                    </Link>
                </>
            ) : null}
        </Card>
    );
}

// --- Inline anomaly flags --------------------------------------------------

/**
 * Inline anomaly flags for the team (Task 4.8). Reads the open team-anomaly list
 * and shows the ones for THIS team beside its metrics — a severity-toned flag per
 * affected metric, with the honest basis label and a link to the full panel. Only
 * rendered when the team has open anomalies, so a clean team shows nothing.
 */
function AnomalyFlags({team}: {team: string}): JSX.Element | null {
    const {data} = useAnomalies('open');
    const flags = (data ?? []).filter((a) => a.team === team);
    if (flags.length === 0) return null;

    return (
        <Card title="Anomaly flags">
            <ul className="space-y-2">
                {flags.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3" data-testid="team-anomaly-flag">
                        <span className="flex flex-wrap items-center gap-2">
                            <Badge tone={severityTone(a.severity)}>{severityLabel(a.severity)}</Badge>
                            <span className="text-sm text-foreground">{a.description}</span>
                        </span>
                        <Badge tone="neutral" title="What this anomaly is derived from">
                            {a.basis_label}
                        </Badge>
                    </li>
                ))}
            </ul>
            <Link
                to="/manager/anomalies"
                className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
            >
                View anomalies →
            </Link>
        </Card>
    );
}

// --- Page ------------------------------------------------------------------

function LoadingDetail(): JSX.Element {
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
            <Card>
                <SkeletonTable rows={5} columns={5} />
            </Card>
        </>
    );
}

export function TeamDetail(): JSX.Element {
    const {team: teamParam} = useParams<{team: string}>();
    const team = teamParam ?? '';
    const {data, isPending, isError, error, refetch} = useTeamDetail(team);

    const notFound = isError && error instanceof ApiError && error.status === 404;

    return (
        <div className="space-y-6">
            <div>
                <Link to="/manager/teams" className="text-sm text-accent hover:underline">
                    ← Teams
                </Link>
                <h1 className="mt-1 text-2xl font-semibold text-foreground">{data?.name ?? team}</h1>
                {data && (data.department || data.manager) ? (
                    <p className="mt-1 text-sm text-muted">
                        {[data.department, data.manager ? `Managed by ${data.manager}` : null]
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                ) : null}
            </div>

            {isPending ? <LoadingDetail /> : null}

            {notFound ? (
                <EmptyState
                    title="Team not found"
                    message="This team no longer exists or was never registered. Use “← Teams” above to go back."
                />
            ) : null}

            {isError && !notFound ? (
                <ErrorState title="Failed to load team" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}

            {!isPending && !isError && data ? (
                <>
                    <SummaryCards team={data} />
                    <AnomalyFlags team={team} />
                    <AdoptionTrend team={team} />
                    <MaturityTrendCard
                        scope={team}
                        title="AI maturity trend"
                        subtitle="This team's AI maturity score over time."
                    />
                    <SummariesPanel scope={`team:${team}`} compact />
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                        <div className="lg:col-span-2">
                            <DeveloperList team={data} />
                        </div>
                        <div className="space-y-6">
                            <ToolBreakdown team={data} />
                            <GitProviders team={team} />
                            <WasteAlerts team={team} />
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}
