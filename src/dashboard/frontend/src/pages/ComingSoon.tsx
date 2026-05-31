import {Card} from '../components/Card';

/**
 * Lightweight placeholder for manager screens that the org overview links to but
 * which land in later Phase 2 tasks (Teams → 2.6, Waste Detection → 2.7). Having
 * a real route here keeps the overview's quick links live instead of dead-ending
 * on the 404 page; each task replaces this element with the real screen.
 */
export function ComingSoon({title, description}: {title: string; description: string}): JSX.Element {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
                <p className="mt-1 text-sm text-muted">{description}</p>
            </div>
            <Card>
                <p className="text-sm text-muted">This screen arrives in a later Phase 2 task.</p>
            </Card>
        </div>
    );
}
