import {useState, type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {useCompareTable} from '../hooks/useCompareTable';
import {DataTable, type Column} from '../components/DataTable';
import {Card} from '../components/Card';
import {Badge} from '../components/Badge';
import {SkeletonTable} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {formatCurrency, formatPercent} from '../components/format';
import {UtilizationCell} from '../components/UtilizationCell';
import {tierLabel, tierTone, tierDescription, tierBreakdownSummary} from '../components/tier';
import {maturityBasisLabel, maturityBasisDescription} from '../components/maturity';
import type {CompareTableTeam, DataQualityTier} from '../api/types';

/**
 * Sortable all-teams ranking table (Task 4.10 / #105). The large-org case: rank
 * every overseen team by any metric for a chosen period. Reuses the Phase 2
 * Teams List's sortable `DataTable` and the shared tier/maturity formatters
 * rather than duplicating them; the data is the pre-computed quarterly rollup, so
 * it stays responsive for many teams.
 *
 * A metric is missing in two honest ways, both rendered as an em dash: the team
 * has no aggregate row for the period (`metrics === null`), or a particular
 * column is null within the row (no members → utilization, no PRs → cost-per-PR,
 * no computed score → maturity). For sorting, a missing value is returned as
 * `null` from the column accessor, and the shared `DataTable` sorts such rows to
 * the END in BOTH directions — so a no-data team never reads as the best or
 * worst ranked value.
 */

/** Order tiers by data-quality strength so the Tier column sorts sensibly. */
const TIER_RANK: Record<DataQualityTier, number> = {high: 3, medium: 2, low: 1, none: 0};

function Dash(): JSX.Element {
    return <span className="text-muted">—</span>;
}

function MaturityCell({team}: {team: CompareTableTeam}): JSX.Element {
    const score = team.metrics?.ai_maturity_score ?? null;
    if (score === null) {
        return <Dash />;
    }
    const basis = team.metrics?.ai_maturity_basis ?? null;
    return (
        <span className="inline-flex items-center justify-end gap-2">
            <span className="tabular-nums text-foreground">{Math.round(score)} / 100</span>
            <Badge tone="accent" title={maturityBasisDescription(basis)}>
                {maturityBasisLabel(basis)}
            </Badge>
        </span>
    );
}

function WasteCell({waste}: {waste: number | null}): JSX.Element {
    if (waste === null) {
        return <Dash />;
    }
    if (waste <= 0) {
        return <span className="text-muted">None</span>;
    }
    return <Badge tone="danger">{formatCurrency(waste)}/mo</Badge>;
}

function TierCell({team}: {team: CompareTableTeam}): JSX.Element {
    return (
        <Badge
            tone={tierTone(team.tier)}
            title={`${tierDescription(team.tier)} (${tierBreakdownSummary(
                team.tier_breakdown,
            )}). Reflects current connection, not the selected period.`}
        >
            {tierLabel(team.tier)}
        </Badge>
    );
}

const COLUMNS: Column<CompareTableTeam>[] = [
    {
        key: 'name',
        header: 'Team',
        accessor: (t) => t.name,
        render: (t) => (
            <Link
                to={`/manager/teams/${encodeURIComponent(t.name)}`}
                className="font-medium text-accent hover:underline"
            >
                {t.name}
            </Link>
        ),
    },
    {
        key: 'utilization',
        header: 'Utilization',
        accessor: (t) => t.metrics?.utilization_rate ?? null,
        render: (t) => <UtilizationCell rate={t.metrics?.utilization_rate ?? null} />,
    },
    {
        key: 'active',
        header: 'Active devs',
        accessor: (t) => t.metrics?.active_developer_count ?? null,
        align: 'right',
        render: (t) =>
            t.metrics === null ? (
                <Dash />
            ) : (
                <span className="tabular-nums">
                    <span className="text-foreground">{t.metrics.active_developer_count}</span>
                    <span className="text-muted"> / {t.metrics.developer_count}</span>
                </span>
            ),
    },
    {
        key: 'cost',
        header: 'Total cost',
        accessor: (t) => t.metrics?.total_subscription_cost ?? null,
        align: 'right',
        render: (t) =>
            t.metrics?.total_subscription_cost == null ? (
                <Dash />
            ) : (
                <span className="tabular-nums">{formatCurrency(t.metrics.total_subscription_cost)}</span>
            ),
    },
    {
        key: 'cost_per_pr',
        header: 'Cost / PR',
        accessor: (t) => t.metrics?.cost_per_pr ?? null,
        align: 'right',
        render: (t) =>
            t.metrics?.cost_per_pr == null ? (
                <Dash />
            ) : (
                <span className="tabular-nums">{formatCurrency(t.metrics.cost_per_pr)}</span>
            ),
    },
    {
        key: 'churn',
        header: 'Churn',
        accessor: (t) => t.metrics?.avg_code_churn ?? null,
        align: 'right',
        render: (t) =>
            t.metrics?.avg_code_churn == null ? (
                <Dash />
            ) : (
                <span className="tabular-nums">{formatPercent(t.metrics.avg_code_churn)}</span>
            ),
    },
    {
        key: 'maturity',
        header: 'AI maturity',
        accessor: (t) => t.metrics?.ai_maturity_score ?? null,
        align: 'right',
        render: (t) => <MaturityCell team={t} />,
    },
    {
        key: 'waste',
        header: 'Waste',
        accessor: (t) => t.metrics?.wasted_spend ?? null,
        align: 'right',
        render: (t) => <WasteCell waste={t.metrics?.wasted_spend ?? null} />,
    },
    {
        key: 'tier',
        header: 'Data quality',
        accessor: (t) => TIER_RANK[t.tier],
        render: (t) => <TierCell team={t} />,
    },
];

// --- Period selector --------------------------------------------------------

interface PeriodSelectorProps {
    periods: string[];
    value: string;
    onChange: (period: string) => void;
}

/**
 * Picks which period's pre-computed aggregates the table shows. A plain native
 * select keyed to the available quarters (most recent first) — changing it
 * refetches the table for that period.
 */
function PeriodSelector({periods, value, onChange}: PeriodSelectorProps): JSX.Element {
    return (
        <label className="inline-flex items-center gap-2 text-sm">
            <span className="font-medium text-foreground">Period</span>
            <select
                aria-label="Period"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            >
                {periods.map((p) => (
                    <option key={p} value={p}>
                        {p}
                    </option>
                ))}
            </select>
        </label>
    );
}

// --- Page -------------------------------------------------------------------

export function TeamCompareTable(): JSX.Element {
    // Undefined until the user picks one — the server then defaults to the latest
    // rolled-up quarter and echoes it back as `data.period`.
    const [period, setPeriod] = useState<string | undefined>(undefined);
    const {data, isPending, isError, error, refetch} = useCompareTable(period);

    const heading: ReactNode = (
        <div>
            <h1 className="text-2xl font-semibold text-foreground">Rank teams</h1>
            <p className="mt-1 text-sm text-muted">
                Every team you oversee in one sortable table — rank by utilization, cost, output, maturity, or
                waste for a chosen period. Click any column to sort.
            </p>
        </div>
    );

    if (isPending) {
        return (
            <div className="space-y-6">
                {heading}
                <Card>
                    <SkeletonTable rows={6} columns={9} />
                </Card>
            </div>
        );
    }

    if (isError) {
        return (
            <div className="space-y-6">
                {heading}
                <ErrorState
                    title="Failed to load the teams table"
                    detail={error?.message}
                    onRetry={() => void refetch()}
                />
            </div>
        );
    }

    const selectedPeriod = period ?? data.period ?? '';

    return (
        <div className="space-y-6">
            {heading}

            {data.teams.length === 0 ? (
                <EmptyState
                    title="No teams yet"
                    message="Register developers and assign them to teams to rank adoption here."
                />
            ) : (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        {data.available_periods.length > 0 ? (
                            <PeriodSelector
                                periods={data.available_periods}
                                value={selectedPeriod}
                                onChange={setPeriod}
                            />
                        ) : (
                            <p className="text-xs text-muted">
                                No period aggregates have been computed yet — run the quarterly rollup to populate
                                metrics. Teams are listed below with their current data-quality tier.
                            </p>
                        )}
                        <p className="text-xs text-muted">
                            Maturity is a git-based estimate at launch. Tier reflects current connection, not the
                            selected period.
                        </p>
                    </div>

                    <DataTable
                        columns={COLUMNS}
                        rows={data.teams}
                        getRowKey={(t) => t.name}
                        initialSort={{key: 'name', direction: 'asc'}}
                        caption="All overseen teams for the selected period — sortable by every column"
                    />
                </>
            )}
        </div>
    );
}
