import {Link} from 'react-router-dom';

export function NotFound(): JSX.Element {
    return (
        <div className="space-y-3">
            <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
            <p className="text-sm text-muted">That route doesn’t exist yet.</p>
            <Link to="/manager" className="text-sm font-medium text-accent hover:underline">
                Back to overview
            </Link>
        </div>
    );
}
