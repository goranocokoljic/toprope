import {Link} from 'react-router-dom';
import {useTeams} from '../hooks/useTeamData';
import {useWasteSummary} from '../hooks/useManagerData';
import {DataTable, type Column} from '../components/DataTable';
import {Badge} from '../components/Badge';
import {Card} from '../components/Card';
import {SkeletonTable} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {toolLabel} from '../components/toolLabels';
import {utilizationTier} from '../components/utilization';
import {formatCurrency, formatPercent} from '../components/format';
import type {TeamListItem, WasteTeamSummary} from '../api/types';

/**
 * A team list row: the backend team summary plus its open-waste rollup (merged
 * from /api/waste/summary). The teams endpoint carries no waste field, so the
 * waste flag/amount is joined client-side by team name.
 */
interface TeamRow extends TeamListItem {
    monthly_waste: number;
    alert_count: number;
    /** Whether waste data was available at all (vs failed to load). */
    waste_known: boolean;
}

// Full literal class strings (Tailwind can't see dynamically-built names).
const UTILIZATION_DOT: Record<'success' | 'warning' | 'danger', string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
};

function UtilizationCell({rate}: {rate: number}): JSX.Element {
    const tier = utilizationTier(rate);
    const dot = UTILIZATION_DOT[tier.tone as 'success' | 'warning' | 'danger'];
    return (
        <span className="inline-flex items-center gap-2">
            <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
            <span className="tabular-nums text-foreground">{formatPercent(rate)}</span>
            <Badge tone={tier.tone}>{tier.label}</Badge>
        </span>
    );
}

function ToolMixCell({tools}: {tools: string[]}): JSX.Element {
    if (tools.length === 0) {
        return <span className="text-muted">—</span>;
    }
    return (
        <span className="flex flex-wrap gap-1">
            {tools.map((t) => (
                <Badge key={t} tone="neutral">
                    {toolLabel(t)}
                </Badge>
            ))}
        </span>
    );
}

function WasteCell({row}: {row: TeamRow}): JSX.Element {
    if (!row.waste_known) {
        // A failed waste load must not read as a confident "no waste".
        return <span className="text-muted">unknown</span>;
    }
    if (row.monthly_waste <= 0) {
        return <span className="text-muted">None</span>;
    }
    return (
        <Badge tone="danger" title={`${row.alert_count} ${row.alert_count === 1 ? 'alert' : 'alerts'}`}>
            {formatCurrency(row.monthly_waste)}/mo
        </Badge>
    );
}

const COLUMNS: Column<TeamRow>[] = [
    {
        key: 'name',
        header: 'Team',
        accessor: (r) => r.name,
        render: (r) => (
            <Link
                to={`/manager/teams/${encodeURIComponent(r.name)}`}
                className="font-medium text-accent hover:underline"
            >
                {r.name}
            </Link>
        ),
    },
    {
        key: 'developer_count',
        header: 'Developers',
        // Sort by team size; the cell shows active / total for context.
        accessor: (r) => r.developer_count,
        align: 'right',
        render: (r) => (
            <span className="tabular-nums">
                <span className="text-foreground">{r.active_count}</span>
                <span className="text-muted"> / {r.developer_count}</span>
            </span>
        ),
    },
    {
        key: 'utilization_rate',
        header: 'Utilization',
        accessor: (r) => r.utilization_rate,
        render: (r) => <UtilizationCell rate={r.utilization_rate} />,
    },
    {
        key: 'total_monthly_cost',
        header: 'Monthly cost',
        accessor: (r) => r.total_monthly_cost,
        align: 'right',
        render: (r) => <span className="tabular-nums">{formatCurrency(r.total_monthly_cost)}</span>,
    },
    {
        key: 'tool_mix',
        header: 'Tools',
        // Sortable by how many tools are in the mix.
        accessor: (r) => r.tool_mix.length,
        render: (r) => <ToolMixCell tools={r.tool_mix} />,
    },
    {
        key: 'waste',
        header: 'Waste',
        accessor: (r) => r.monthly_waste,
        align: 'right',
        render: (r) => <WasteCell row={r} />,
    },
];

function mergeRows(teams: TeamListItem[], waste: WasteTeamSummary[] | undefined, wasteKnown: boolean): TeamRow[] {
    const wasteByTeam = new Map((waste ?? []).map((w) => [w.team, w]));
    return teams.map((team) => {
        const w = wasteByTeam.get(team.name);
        return {
            ...team,
            monthly_waste: w?.total_monthly_waste ?? 0,
            alert_count: w?.alert_count ?? 0,
            waste_known: wasteKnown,
        };
    });
}

export function TeamsList(): JSX.Element {
    const {data: teams, isPending, isError, error, refetch} = useTeams();
    // Waste is a secondary, mergeable signal — a failure there annotates the
    // waste column as "unknown" rather than blocking the whole list.
    const waste = useWasteSummary();
    const wasteKnown = !waste.isError;

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Teams</h1>
                <p className="mt-1 text-sm text-muted">
                    Compare adoption, cost, and waste across teams. Utilization is active developers over team size.
                </p>
            </div>

            {isPending ? (
                <Card>
                    <SkeletonTable rows={6} columns={6} />
                </Card>
            ) : null}

            {isError ? (
                <ErrorState title="Failed to load teams" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}

            {!isPending && !isError && teams && teams.length === 0 ? (
                <EmptyState
                    title="No teams yet"
                    message="Register developers and assign them to teams to compare adoption here."
                />
            ) : null}

            {!isPending && !isError && teams && teams.length > 0 ? (
                <>
                    {waste.isError ? (
                        <p className="text-xs text-muted">
                            Waste data is temporarily unavailable, so the Waste column reads “unknown”.
                        </p>
                    ) : null}
                    <DataTable
                        columns={COLUMNS}
                        rows={mergeRows(teams, waste.data, wasteKnown)}
                        getRowKey={(r) => r.name}
                        initialSort={{key: 'name', direction: 'asc'}}
                        caption="Teams by adoption, cost, and waste — sortable by every column except the tool list"
                    />
                </>
            ) : null}
        </div>
    );
}
