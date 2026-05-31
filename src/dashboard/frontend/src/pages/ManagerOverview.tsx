import {useOverview} from '../hooks/useOverview';
import {Card, StatCard} from '../components/Card';
import {DataQualityChart} from '../charts/DataQualityChart';
import {SkeletonStatCard, SkeletonChart} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {ColdStartPanel, type ConnectorStatus} from '../components/ColdStartPanel';
import type {OverviewData} from '../api/types';

function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0}).format(value);
}

// The connectors GovProxy can pull from. We always list all three so the
// cold-start panel shows what's still unconnected, not just what's wired up.
const KNOWN_CONNECTORS = ['copilot', 'claude-code', 'windsurf'] as const;

/** Number of developers with any collected data (high/medium/low, not none). */
function developersWithData(data: OverviewData): number {
    const {high, medium, low} = data.data_quality_distribution;
    return high + medium + low;
}

function connectorStatuses(data: OverviewData): ConnectorStatus[] {
    return KNOWN_CONNECTORS.map((name) => ({name, connected: data.active_tools.includes(name)}));
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

    // Cold-start: the org is set up but no developer has any data yet, so the
    // numbers below would all be hollow zeros. Show collection-in-progress
    // instead of broken-looking empty charts.
    const coldStart = data !== undefined && developersWithData(data) === 0;

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Organization Overview</h1>
                <p className="mt-1 text-sm text-muted">Unified AI adoption across all connected tools.</p>
            </div>

            {isPending ? <LoadingOverview /> : null}

            {isError ? (
                <ErrorState
                    title="Failed to load overview"
                    detail={error.message}
                    onRetry={() => void refetch()}
                />
            ) : null}

            {data && coldStart ? (
                <ColdStartPanel
                    scopeLabel="your organization"
                    connectors={connectorStatuses(data)}
                    checklist={[
                        {label: 'Register developers', done: data.total_developers > 0},
                        {label: 'Connect a tool', done: data.active_tools.length > 0},
                        {label: 'First sync collected', done: developersWithData(data) > 0},
                    ]}
                />
            ) : null}

            {data && !coldStart ? (
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
