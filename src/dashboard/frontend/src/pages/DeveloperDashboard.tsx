import {Card} from '../components/Card';

export function DeveloperDashboard(): JSX.Element {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">My Dashboard</h1>
                <p className="mt-1 text-sm text-muted">Your personal AI adoption journey.</p>
            </div>
            <Card>
                <p className="text-sm text-muted">
                    The developer view arrives in a later Phase 2 task. This placeholder confirms client-side routing
                    works.
                </p>
            </Card>
        </div>
    );
}
