import {Link, useParams} from 'react-router-dom';
import {useDeveloperIdentity, useDeveloperJourney} from '../hooks/useDeveloper';
import {ApiError} from '../api/client';
import {Card} from '../components/Card';
import {JourneyTimeline} from '../components/JourneyTimeline';
import {SkeletonText} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';

/**
 * Manager's developer-detail view (Task 4.11 / #106). The per-developer aggregate
 * adoption story — framed as journey/health, never a ranking. It surfaces the
 * same journey the developer sees of themselves (no prompt content, nothing
 * rankable); the route is admin-only server-side. Identity (name/team) heads the
 * page; the journey card carries the timeline, transitions, trajectory, and
 * annotated key moments.
 */

function LoadingDetail(): JSX.Element {
    return (
        <Card title="Adoption journey">
            <SkeletonText lines={5} />
        </Card>
    );
}

export function DeveloperDetail(): JSX.Element {
    const {id: idParam} = useParams<{id: string}>();
    const id = idParam ?? '';
    const identity = useDeveloperIdentity(id);
    const journey = useDeveloperJourney(id);

    const isPending = identity.isPending || journey.isPending;
    const isError = identity.isError || journey.isError;
    const error = identity.error ?? journey.error;
    const notFound = isError && error instanceof ApiError && error.status === 404;

    return (
        <div className="space-y-6">
            <div>
                <Link to="/manager/teams" className="text-sm text-accent hover:underline">
                    ← Teams
                </Link>
                <h1 className="mt-1 text-2xl font-semibold text-foreground">{identity.data?.name ?? id}</h1>
                <p className="mt-1 text-sm text-muted">
                    {identity.data?.team
                        ? `${identity.data.team} · adoption journey`
                        : 'Developer adoption journey'}
                </p>
            </div>

            {isPending ? <LoadingDetail /> : null}

            {notFound ? (
                <EmptyState
                    title="Developer not found"
                    message="This developer no longer exists or was never registered. Use “← Teams” above to go back."
                />
            ) : null}

            {isError && !notFound ? (
                <ErrorState
                    title="Failed to load developer"
                    detail={error?.message}
                    onRetry={() => {
                        void identity.refetch();
                        void journey.refetch();
                    }}
                />
            ) : null}

            {!isPending && !isError && journey.data ? (
                <JourneyTimeline journey={journey.data} framing="manager" />
            ) : null}
        </div>
    );
}
