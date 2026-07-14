import {useMemo, useState} from 'react';
import {Card} from '../components/Card';
import {DataTable, type Column} from '../components/DataTable';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {SkeletonTable} from '../components/Skeleton';
import {formatPercent} from '../components/format';
import {useTeamNames} from '../hooks/useSettings';
import {useLeaderboard} from '../hooks/useLeaderboard';
import type {LeaderboardEntry, LeaderboardMetric} from '../api/types';

// Metric options surfaced in the selector. `value` is the column the board sorts
// by; the table still shows every metric so the ranking is legible at a glance.
const METRIC_OPTIONS: {value: LeaderboardMetric; label: string; hint: string}[] = [
    {value: 'activity', label: 'Activity', hint: 'total tool interactions'},
    {value: 'acceptance', label: 'Acceptance', hint: 'accepted suggestions / interactions'},
    {value: 'output', label: 'Output', hint: 'git commits'},
];

function metricCell(entry: LeaderboardEntry, metric: LeaderboardMetric): string {
    if (metric === 'acceptance') {
        return formatPercent(entry.acceptance_rate);
    }
    return String(metric === 'activity' ? entry.interactions : entry.commits);
}

function LeaderboardTable({team, metric}: {team: string; metric: LeaderboardMetric}): JSX.Element {
    const {data, isPending, isError, error, refetch} = useLeaderboard(team, metric);

    // Memoized on `metric` so the columns reference is STABLE across re-renders:
    // DataTable's post-sort memo (and thus the pageSize pager's page state) keys
    // off the columns identity, so a fresh array each render would snap the pager
    // back to page 1 on any background re-render (matches the module-constant
    // columns the sibling TeamsList / TeamDetail boards use). Declared BEFORE the
    // early returns so the hook order is stable (rules of hooks).
    const columns: Column<LeaderboardEntry>[] = useMemo(
        () => [
            {key: 'rank', header: '#', accessor: (r) => r.rank, align: 'right'},
            {key: 'name', header: 'Developer', accessor: (r) => r.name},
            {
                key: 'value',
                header: METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? 'Score',
                accessor: (r) => r.value,
                render: (r) => {
                    // On the acceptance board, a developer below the server's
                    // sample floor is ranked at value 0 but still shows a real
                    // (possibly high) rate — flag it so a "100% yet ranked last"
                    // row reads as deliberate, not a bug. The floor signal is
                    // value===0 while the underlying rate is positive.
                    const lowSample = metric === 'acceptance' && r.value === 0 && r.acceptance_rate > 0;
                    return (
                        <span className="font-medium text-foreground">
                            {metricCell(r, metric)}
                            {lowSample ? (
                                <span className="ml-1 text-xs font-normal text-muted">(low sample)</span>
                            ) : null}
                        </span>
                    );
                },
                align: 'right',
            },
            {key: 'interactions', header: 'Interactions', accessor: (r) => r.interactions, align: 'right'},
            {
                key: 'acceptance_rate',
                header: 'Acceptance',
                accessor: (r) => r.acceptance_rate,
                render: (r) => formatPercent(r.acceptance_rate),
                align: 'right',
            },
            {key: 'commits', header: 'Commits', accessor: (r) => r.commits, align: 'right'},
        ],
        [metric],
    );

    if (isPending) {
        return <SkeletonTable rows={5} />;
    }
    if (isError) {
        return <ErrorState detail={error.message} onRetry={() => void refetch()} />;
    }
    if (data.entries.length === 0) {
        return (
            <EmptyState
                title="No developers to rank"
                message="This team has no developers yet, so there is nothing to rank."
            />
        );
    }

    return (
        <DataTable
            columns={columns}
            rows={data.entries}
            getRowKey={(r) => r.developer_id}
            initialSort={{key: 'rank', direction: 'asc'}}
            caption={`Leaderboard for ${team} by ${metric}`}
            // One row per developer — can grow large. Client-side over the
            // already-fetched list; 25/page.
            pageSize={25}
        />
    );
}

/**
 * Optional leaderboard screen (Task 2.17). A ranked team view that ships OFF by
 * default and is reachable only when settings enable it — the route is guarded
 * by RequireLeaderboard and the nav entry by the availability probe, so this
 * component never renders unless the leaderboard is permitted. It conflicts with
 * the coaching-not-surveillance default, hence the deliberate gating.
 */
export function Leaderboard(): JSX.Element {
    const {data: teamNames} = useTeamNames();
    const [team, setTeam] = useState<string | null>(null);
    const [metric, setMetric] = useState<LeaderboardMetric>('activity');

    const metricHint = METRIC_OPTIONS.find((m) => m.value === metric)?.hint;

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Leaderboard</h1>
                <p className="mt-1 text-sm text-muted">
                    Ranked developer view within a team. Off by default — enabled here only because
                    settings permit it.
                </p>
            </div>

            <Card>
                <div className="flex flex-wrap items-end gap-4">
                    <label className="flex items-center gap-3">
                        <span className="text-sm text-foreground">Team</span>
                        <select
                            value={team ?? ''}
                            onChange={(e) => setTeam(e.target.value || null)}
                            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                        >
                            <option value="">Select a team…</option>
                            {(teamNames ?? []).map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex items-center gap-3">
                        <span className="text-sm text-foreground">Rank by</span>
                        <select
                            value={metric}
                            onChange={(e) => setMetric(e.target.value as LeaderboardMetric)}
                            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                        >
                            {METRIC_OPTIONS.map((m) => (
                                <option key={m.value} value={m.value}>
                                    {m.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    {metricHint ? <span className="pb-1.5 text-xs text-muted">{metricHint}</span> : null}
                </div>
            </Card>

            {team ? (
                <LeaderboardTable team={team} metric={metric} />
            ) : (
                <EmptyState title="Select a team" message="Choose a team above to view its leaderboard." />
            )}
        </div>
    );
}
