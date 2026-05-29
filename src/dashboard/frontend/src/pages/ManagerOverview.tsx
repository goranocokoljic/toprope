import {useOverview} from '../hooks/useOverview';
import {Card, StatCard} from '../components/Card';
import {DataQualityChart} from '../charts/DataQualityChart';

function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0}).format(value);
}

export function ManagerOverview(): JSX.Element {
    const {data, isPending, isError, error} = useOverview();

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Organization Overview</h1>
                <p className="mt-1 text-sm text-muted">Unified AI adoption across all connected tools.</p>
            </div>

            {isPending ? <p className="text-sm text-muted">Loading overview…</p> : null}

            {isError ? (
                <Card>
                    <p className="text-sm text-danger">Failed to load overview: {error.message}</p>
                </Card>
            ) : null}

            {data ? (
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
