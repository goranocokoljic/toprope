import {useOverview} from '../hooks/useOverview';
import {Card, StatCard} from '../components/Card';
import {DataQualityChart} from '../charts/DataQualityChart';
import {SkeletonStatCard, SkeletonChart} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {ColdStartPanel, type ConnectorStatus} from '../components/ColdStartPanel';
import {classifyDataState} from '../components/dataState';
import type {OverviewData} from '../api/types';

function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0}).format(value);
}

// The connectors GovProxy can pull from. We always list all three so the
// cold-start panel shows what's still unconnected, not just what's wired up.
const KNOWN_CONNECTORS = ['copilot', 'claude-code', 'windsurf'] as const;

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
    return KNOWN_CONNECTORS.map((name) => ({name, connected: tools.includes(name)}));
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
            <Card title="Data quality coverage">
                <SkeletonChart />
            </Card>
        </>
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

            {state === 'error' && isError ? (
                <ErrorState title="Failed to load overview" detail={error.message} onRetry={() => void refetch()} />
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
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <StatCard
                            label="Active developers"
                            value={`${data.active_developers} / ${data.total_developers}`}
                            hint="active in last 30 days"
                        />
                        <StatCard label="Monthly spend" value={formatCurrency(data.total_monthly_cost)} />
                        <StatCard
                            label="Monthly waste"
                            value={formatCurrency(data.total_monthly_waste)}
                            hint={`${data.active_waste_alert_count} active alerts`}
                        />
                        <StatCard label="Subscriptions" value={String(data.total_subscriptions)} />
                    </div>

                    <Card title="Data quality coverage">
                        <DataQualityChart overview={data} />
                    </Card>
                </>
            ) : null}
        </div>
    );
}
