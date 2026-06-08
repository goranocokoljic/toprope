import {useState, type ReactNode} from 'react';
import {useTeams} from '../hooks/useTeamData';
import {useTeamCompare} from '../hooks/useCompare';
import {useTimeRange} from '../hooks/useTimeRange';
import {Card} from '../components/Card';
import {Badge} from '../components/Badge';
import {TimeRangeSelector} from '../components/TimeRangeSelector';
import {TrendChart} from '../charts/TrendChart';
import {SkeletonChart, SkeletonTable} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {toolLabel} from '../components/toolLabels';
import {formatCurrency, formatPercent, formatCount, formatDateTick} from '../components/format';
import {tierLabel, tierTone, tierDescription} from '../components/tier';
import {maturityBasisLabel, maturityBasisDescription} from '../components/maturity';
import {mergeCompareTrends} from '../compare/mergeTrends';
import {MIN_COMPARE_TEAMS, MAX_COMPARE_TEAMS} from '../compare/limits';
import type {CompareTeam, CompareTeamMetrics} from '../api/types';

// --- Team selector ---------------------------------------------------------

interface TeamSelectorProps {
    available: string[];
    selected: string[];
    onToggle: (team: string) => void;
}

/**
 * Multi-select of the teams to compare. Capped at MAX_COMPARE_TEAMS: once the
 * cap is reached, unselected chips are disabled so the UI can't request a 5th
 * (the API rejects it too, as defense-in-depth).
 */
function TeamSelector({available, selected, onToggle}: TeamSelectorProps): JSX.Element {
    const atCap = selected.length >= MAX_COMPARE_TEAMS;
    return (
        <Card title="Teams to compare">
            <p className="mb-3 text-xs text-muted">
                Pick {MIN_COMPARE_TEAMS}–{MAX_COMPARE_TEAMS} teams. {selected.length} selected.
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Teams to compare">
                {available.map((team) => {
                    const isSelected = selected.includes(team);
                    const disabled = !isSelected && atCap;
                    return (
                        <button
                            key={team}
                            type="button"
                            aria-pressed={isSelected}
                            disabled={disabled}
                            onClick={() => onToggle(team)}
                            className={[
                                'rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                                isSelected
                                    ? 'border-accent bg-accent text-white'
                                    : 'border-border bg-surface text-foreground hover:bg-surface-raised',
                                disabled ? 'cursor-not-allowed opacity-40' : '',
                            ].join(' ')}
                        >
                            {team}
                        </button>
                    );
                })}
            </div>
            {atCap ? (
                <p className="mt-2 text-xs text-muted">
                    Maximum of {MAX_COMPARE_TEAMS} teams — deselect one to swap. For ranking many teams, use the
                    Teams list.
                </p>
            ) : null}
        </Card>
    );
}

// --- Per-metric comparison rows --------------------------------------------

interface MetricRow {
    key: string;
    label: string;
    /** Optional sub-label, e.g. the maturity honesty note. */
    note?: ReactNode;
    value: (m: CompareTeamMetrics) => ReactNode;
}

function ToolMix({tools}: {tools: string[]}): JSX.Element {
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

function MaturityValue({metrics}: {metrics: CompareTeamMetrics}): JSX.Element {
    if (metrics.ai_maturity_score === null) {
        return <span className="text-muted">—</span>;
    }
    return (
        <span className="inline-flex items-center gap-2">
            <span className="tabular-nums text-foreground">{Math.round(metrics.ai_maturity_score)} / 100</span>
            <Badge tone="accent" title={maturityBasisDescription(metrics.ai_maturity_basis)}>
                {maturityBasisLabel(metrics.ai_maturity_basis)}
            </Badge>
        </span>
    );
}

const METRIC_ROWS: MetricRow[] = [
    {
        key: 'active',
        label: 'Active developers',
        value: (m) => (
            <span className="tabular-nums">
                <span className="text-foreground">{m.active_developer_count}</span>
                <span className="text-muted"> / {m.developer_count}</span>
            </span>
        ),
    },
    {
        key: 'utilization',
        label: 'Utilization',
        value: (m) =>
            m.utilization_rate === null ? (
                <span className="text-muted">—</span>
            ) : (
                <span className="tabular-nums">{formatPercent(m.utilization_rate)}</span>
            ),
    },
    {
        key: 'cost',
        label: 'Total cost',
        note: 'monthly subscription spend',
        value: (m) => <span className="tabular-nums">{formatCurrency(m.total_subscription_cost)}</span>,
    },
    {
        key: 'cost_per_pr',
        label: 'Cost per PR',
        value: (m) =>
            m.cost_per_pr === null ? (
                <span className="text-muted">—</span>
            ) : (
                <span className="tabular-nums">{formatCurrency(m.cost_per_pr)}</span>
            ),
    },
    {
        key: 'prs',
        label: 'PRs merged',
        value: (m) => <span className="tabular-nums">{formatCount(m.total_prs_merged)}</span>,
    },
    {
        key: 'churn',
        label: 'Code churn',
        value: (m) =>
            m.avg_code_churn === null ? (
                <span className="text-muted">—</span>
            ) : (
                <span className="tabular-nums">{formatPercent(m.avg_code_churn)}</span>
            ),
    },
    {
        key: 'maturity',
        label: 'AI maturity score',
        note: 'git-based estimate at launch',
        value: (m) => <MaturityValue metrics={m} />,
    },
    {
        key: 'tool_mix',
        label: 'Tool mix',
        value: (m) => <ToolMix tools={m.tool_mix} />,
    },
];

function ComparisonTable({teams}: {teams: CompareTeam[]}): JSX.Element {
    return (
        <Card title="Side-by-side metrics">
            <div className="overflow-x-auto rounded-card border border-border">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">
                        Per-metric comparison of the selected teams, with each team&apos;s data-quality tier
                    </caption>
                    <thead>
                        <tr className="border-b border-border bg-surface-raised">
                            <th
                                scope="col"
                                className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted"
                            >
                                Metric
                            </th>
                            {teams.map((team) => (
                                <th
                                    key={team.name}
                                    scope="col"
                                    className="px-4 py-2.5 text-right text-xs font-semibold text-muted"
                                >
                                    <div className="flex flex-col items-end gap-1">
                                        <span className="text-sm font-semibold text-foreground">{team.name}</span>
                                        <Badge tone={tierTone(team.tier)} title={tierDescription(team.tier)}>
                                            {tierLabel(team.tier)}
                                        </Badge>
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {METRIC_ROWS.map((row) => (
                            <tr key={row.key} className="border-b border-border last:border-0">
                                <th
                                    scope="row"
                                    className="px-4 py-3 text-left font-medium text-foreground"
                                >
                                    {row.label}
                                    {row.note ? (
                                        <span className="block text-xs font-normal text-muted">{row.note}</span>
                                    ) : null}
                                </th>
                                {teams.map((team) => (
                                    <td key={team.name} className="px-4 py-3 text-right align-top">
                                        <span className="inline-flex justify-end">{row.value(team.metrics)}</span>
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}

// --- Overlaid adoption trend -----------------------------------------------

function OverlaidTrend({teams}: {teams: CompareTeam[]}): JSX.Element {
    const {data, series} = mergeCompareTrends(teams);
    return (
        <TrendChart
            data={data}
            xKey="date"
            series={series}
            variant="line"
            xTickFormatter={formatDateTick}
            emptyMessage="No activity in this range yet."
            testId="compare-trend-chart"
        />
    );
}

// --- Page ------------------------------------------------------------------

export function TeamCompare(): JSX.Element {
    const {range, setRange} = useTimeRange();
    const teamsList = useTeams();
    const [selected, setSelected] = useState<string[]>([]);

    function toggle(team: string): void {
        setSelected((current) => {
            if (current.includes(team)) {
                return current.filter((t) => t !== team);
            }
            if (current.length >= MAX_COMPARE_TEAMS) {
                return current; // at cap — selecting more is a no-op (UI also disables)
            }
            return [...current, team];
        });
    }

    const enoughSelected = selected.length >= MIN_COMPARE_TEAMS;
    const compare = useTeamCompare(selected, range);

    const available = (teamsList.data ?? []).map((t) => t.name);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Compare teams</h1>
                <p className="mt-1 text-sm text-muted">
                    Put {MIN_COMPARE_TEAMS}–{MAX_COMPARE_TEAMS} teams side by side — utilization, cost, output,
                    maturity, and tool mix, with each team&apos;s data-quality tier.
                </p>
            </div>

            {teamsList.isPending ? (
                <Card>
                    <SkeletonTable rows={3} columns={2} />
                </Card>
            ) : null}

            {teamsList.isError ? (
                <ErrorState
                    title="Failed to load teams"
                    detail={teamsList.error?.message}
                    onRetry={() => void teamsList.refetch()}
                />
            ) : null}

            {!teamsList.isPending && !teamsList.isError && available.length === 0 ? (
                <EmptyState
                    title="No teams yet"
                    message="Register developers and assign them to teams to compare adoption here."
                />
            ) : null}

            {!teamsList.isPending && !teamsList.isError && available.length > 0 ? (
                <>
                    <TeamSelector available={available} selected={selected} onToggle={toggle} />

                    {!enoughSelected ? (
                        <EmptyState
                            title="Select teams to compare"
                            message={`Pick at least ${MIN_COMPARE_TEAMS} teams above to see them side by side.`}
                        />
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <h2 className="text-sm font-semibold text-foreground">Time range</h2>
                                <TimeRangeSelector value={range} onChange={setRange} />
                            </div>

                            {compare.isPending ? (
                                <>
                                    <Card>
                                        <SkeletonTable rows={8} columns={selected.length + 1} />
                                    </Card>
                                    <Card title="Adoption trend">
                                        <SkeletonChart />
                                    </Card>
                                </>
                            ) : null}

                            {compare.isError ? (
                                <ErrorState
                                    title="Failed to load comparison"
                                    detail={compare.error?.message}
                                    onRetry={() => void compare.refetch()}
                                />
                            ) : null}

                            {!compare.isPending && !compare.isError && compare.data ? (
                                <>
                                    <ComparisonTable teams={compare.data.teams} />
                                    <Card>
                                        <div className="mb-2">
                                            <h2 className="text-sm font-semibold text-foreground">Adoption trend</h2>
                                            <p className="mt-0.5 text-xs text-muted">
                                                Active developers per team over time — one line each.
                                            </p>
                                        </div>
                                        <OverlaidTrend teams={compare.data.teams} />
                                    </Card>
                                </>
                            ) : null}
                        </>
                    )}
                </>
            ) : null}
        </div>
    );
}
