import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useBrowsePractices} from '../hooks/usePractices';
import type {PracticeBrowseFilters} from '../api/client';
import type {BrowsePracticeSummary, ContributionModel} from '../api/types';
import {Card} from '../components/Card';
import {SkeletonTable} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {formatPercent, formatDateTick} from '../components/format';
import {contributionModelExplainer, contributionModelLabel} from '../components/practiceModel';

/**
 * Best-practice browse UI (Task 6.2.8 / #163) — the browsable, searchable library.
 *
 * The non-contextual discovery path that complements the contextual surfacing (6.2.7):
 * free-text search plus tag and scope filters (all driven by 6.1.5 search server-side),
 * a viewer-scoped result list, and a model-aware "contribute" entry point that explains
 * what publishing means for the viewer's team (6.2.2). Styling uses semantic theme
 * tokens only, so dark mode comes for free.
 */
export function BestPractices(): JSX.Element {
    // Draft = what the inputs hold; filters = what we've actually queried with. The
    // search only fires on submit, so typing doesn't refetch on every keystroke.
    const [draft, setDraft] = useState<PracticeBrowseFilters>({});
    const [filters, setFilters] = useState<PracticeBrowseFilters>({});
    const {data, isPending, isError, error, refetch} = useBrowsePractices(filters);

    function submit(e: React.FormEvent): void {
        e.preventDefault();
        setFilters(draft);
    }

    function clearAll(): void {
        setDraft({});
        setFilters({});
    }

    const practices = data?.practices ?? [];
    const hasActiveFilters = Boolean(filters.q || filters.tag || filters.scope);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Best practices</h1>
                <p className="mt-1 text-sm text-muted">
                    Browse and search the practices your team and organization share for working with AI tools.
                </p>
            </div>

            {data ? <ContributeBanner model={data.model} /> : null}

            <Card>
                <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label="Search best practices">
                    <label className="flex grow flex-col gap-1 text-xs font-medium text-muted">
                        Search
                        <input
                            type="search"
                            value={draft.q ?? ''}
                            onChange={(e) => setDraft({...draft, q: e.target.value})}
                            placeholder="Search by title or content"
                            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Metric tag
                        <input
                            type="text"
                            value={draft.tag ?? ''}
                            onChange={(e) => setDraft({...draft, tag: e.target.value})}
                            placeholder="e.g. churn"
                            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Scope
                        <select
                            value={draft.scope ?? ''}
                            onChange={(e) =>
                                setDraft({...draft, scope: (e.target.value || undefined) as PracticeBrowseFilters['scope']})
                            }
                            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                        >
                            <option value="">All scopes</option>
                            <option value="org">Organization</option>
                            <option value="team">My team</option>
                        </select>
                    </label>
                    <button
                        type="submit"
                        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                    >
                        Search
                    </button>
                    {hasActiveFilters ? (
                        <button
                            type="button"
                            onClick={clearAll}
                            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground"
                        >
                            Clear
                        </button>
                    ) : null}
                </form>
            </Card>

            {isPending ? (
                <Card>
                    <SkeletonTable rows={5} columns={3} />
                </Card>
            ) : null}

            {isError ? (
                <ErrorState
                    title="Failed to load best practices"
                    detail={error?.message}
                    onRetry={() => void refetch()}
                />
            ) : null}

            {!isPending && !isError && practices.length === 0 ? (
                <EmptyState
                    title={hasActiveFilters ? 'No matching practices' : 'No best practices yet'}
                    message={
                        hasActiveFilters
                            ? 'Try a broader search or clear the filters.'
                            : 'Once your team publishes practices for working with AI tools, they’ll appear here.'
                    }
                />
            ) : null}

            {!isPending && !isError && practices.length > 0 ? (
                <ul className="space-y-3" data-testid="practice-list">
                    {practices.map((practice) => (
                        <PracticeRow key={practice.id} practice={practice} />
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

/** Model-aware entry point explaining how this team contributes a practice (6.2.2). */
function ContributeBanner({model}: {model: ContributionModel}): JSX.Element {
    return (
        <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-raised p-4"
            data-testid="contribute-banner"
        >
            <div>
                <p className="text-sm font-medium text-foreground">Share a practice</p>
                <p className="mt-0.5 text-xs text-muted">{contributionModelExplainer(model)}</p>
            </div>
            <Link
                to="/developer/practices/new"
                className="shrink-0 rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft"
            >
                Contribute · {contributionModelLabel(model)}
            </Link>
        </div>
    );
}

/** One practice row in the browse list. */
function PracticeRow({practice}: {practice: BrowsePracticeSummary}): JSX.Element {
    const ratio = practice.feedback.helpfulRatio;
    return (
        <li className="rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-accent/60">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <Link
                    to={`/developer/practices/${encodeURIComponent(practice.id)}`}
                    className="text-sm font-semibold text-accent hover:underline"
                >
                    {practice.title}
                </Link>
                {practice.endorsed ? (
                    <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
                        Endorsed
                    </span>
                ) : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{practice.authorName ?? 'Unknown author'}</span>
                <span aria-hidden="true">·</span>
                <span>Updated {formatDateTick(practice.updatedAt.slice(0, 10))}</span>
                {ratio !== null && ratio > 0 ? (
                    <>
                        <span aria-hidden="true">·</span>
                        <span>{formatPercent(ratio)} found this helpful</span>
                    </>
                ) : null}
            </div>
            {practice.metrics.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                    {practice.metrics.map((metric) => (
                        <span
                            key={metric}
                            className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                        >
                            {metric}
                        </span>
                    ))}
                </div>
            ) : null}
        </li>
    );
}
