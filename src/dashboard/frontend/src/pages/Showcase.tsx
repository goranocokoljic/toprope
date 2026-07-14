import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useBrowseShowcases, useShowcaseRemovals} from '../hooks/useShowcases';
import type {ShowcaseBrowseFilters} from '../api/client';
import type {BrowseShowcaseSummary, ShowcaseRemovalNotice} from '../api/types';
import {Card} from '../components/Card';
import {SkeletonTable} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {Pagination} from '../components/Pagination';
import {usePagination} from '../components/usePagination';
import {formatDateTick} from '../components/format';

/** Client-side page size for the showcase gallery (#226). */
const SHOWCASE_PAGE_SIZE = 12;

/**
 * Stable empty fallback: `usePagination` resets to page 1 on an items-reference
 * change, so a fresh `[]` literal each render (while data loads) would loop.
 */
const NO_SHOWCASES: BrowseShowcaseSummary[] = [];

/**
 * Showcase gallery (Task 6.3.9 / #172) — the browsable, searchable library of
 * exemplar AI conversations the org has chosen to celebrate.
 *
 * The consumption surface for Epic 6.3: free-text search plus tag and scope filters
 * (all driven by 6.1.5 search server-side), a viewer-scoped result list, and the
 * author's own removal-notification feed surfaced at the top when present. Styling uses
 * semantic theme tokens only, so dark mode comes for free.
 */
export function Showcase(): JSX.Element {
    // Draft = what the inputs hold; filters = what we've actually queried with. Search
    // fires on submit, so typing doesn't refetch on every keystroke.
    const [draft, setDraft] = useState<ShowcaseBrowseFilters>({});
    const [filters, setFilters] = useState<ShowcaseBrowseFilters>({});
    const {data, isPending, isError, error, refetch} = useBrowseShowcases(filters);
    const removals = useShowcaseRemovals();

    function submit(e: React.FormEvent): void {
        e.preventDefault();
        setFilters(draft);
    }

    function clearAll(): void {
        setDraft({});
        setFilters({});
    }

    const showcases = data?.showcases ?? NO_SHOWCASES;
    const hasActiveFilters = Boolean(filters.q || filters.tag || filters.scope);
    // A new search/filter refetches → fresh reference → page resets to 1; stable
    // across a pager click (same `data` reference), so paging holds.
    const paged = usePagination(showcases, SHOWCASE_PAGE_SIZE);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Showcase</h1>
                <p className="mt-1 text-sm text-muted">
                    Standout AI conversations your team and organization share as teaching examples.
                </p>
            </div>

            {removals.data && removals.data.length > 0 ? <RemovalNotices notices={removals.data} /> : null}

            <Card>
                <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label="Search showcase">
                    <label className="flex grow flex-col gap-1 text-xs font-medium text-muted">
                        Search
                        <input
                            type="search"
                            value={draft.q ?? ''}
                            onChange={(e) => setDraft({...draft, q: e.target.value})}
                            placeholder="Search by title"
                            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Tag
                        <input
                            type="text"
                            value={draft.tag ?? ''}
                            onChange={(e) => setDraft({...draft, tag: e.target.value})}
                            placeholder="e.g. refactor"
                            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Scope
                        <select
                            value={draft.scope ?? ''}
                            onChange={(e) =>
                                setDraft({...draft, scope: (e.target.value || undefined) as ShowcaseBrowseFilters['scope']})
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
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
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
                    title="Failed to load the showcase"
                    detail={error?.message}
                    onRetry={() => void refetch()}
                />
            ) : null}

            {!isPending && !isError && showcases.length === 0 ? (
                <EmptyState
                    title={hasActiveFilters ? 'No matching showcases' : 'No showcases yet'}
                    message={
                        hasActiveFilters
                            ? 'Try a broader search or clear the filters.'
                            : 'When your team showcases a standout AI conversation, it’ll appear here.'
                    }
                />
            ) : null}

            {!isPending && !isError && showcases.length > 0 ? (
                <>
                    <ul className="space-y-3" data-testid="showcase-list">
                        {paged.pageItems.map((showcase) => (
                            <ShowcaseRow key={showcase.id} showcase={showcase} />
                        ))}
                    </ul>
                    {paged.pageCount > 1 ? (
                        <div className="flex justify-end">
                            <Pagination
                                page={paged.page}
                                pageCount={paged.pageCount}
                                onPageChange={paged.setPage}
                                ariaLabel="Showcase pages"
                            />
                        </div>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

/** The author's removal-notification feed — how a lead removal reaches its author (never silent). */
function RemovalNotices({notices}: {notices: ShowcaseRemovalNotice[]}): JSX.Element {
    return (
        <div
            className="rounded-card border border-border bg-surface-raised p-4"
            data-testid="showcase-removals"
        >
            <p className="text-sm font-medium text-foreground">Removed from the showcase</p>
            <ul className="mt-2 space-y-1.5">
                {notices.map((notice) => (
                    <li key={notice.showcaseId} className="text-xs text-muted">
                        <span className="font-medium text-foreground">{notice.title}</span> was removed on{' '}
                        {formatDateTick(notice.occurredAt.slice(0, 10))}
                        {notice.reason ? <> — {notice.reason}</> : null}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Human label for a publish path, for the provenance marker. */
function publishPathLabel(path: BrowseShowcaseSummary['publishPath']): string | null {
    if (path === 'self_publish') return 'Self-published';
    if (path === 'joint_curation') return 'Jointly curated';
    return null;
}

/** One showcase card in the gallery. */
function ShowcaseRow({showcase}: {showcase: BrowseShowcaseSummary}): JSX.Element {
    const pathLabel = publishPathLabel(showcase.publishPath);
    return (
        <li className="rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-accent/60">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <Link
                    to={`/developer/showcase/${encodeURIComponent(showcase.id)}`}
                    className="text-sm font-semibold text-accent hover:underline"
                >
                    {showcase.title}
                </Link>
                {pathLabel ? (
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                        {pathLabel}
                    </span>
                ) : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{showcase.authorName ?? 'Unknown author'}</span>
                <span aria-hidden="true">·</span>
                <span>Updated {formatDateTick(showcase.updatedAt.slice(0, 10))}</span>
                {showcase.annotationCount > 0 ? (
                    <>
                        <span aria-hidden="true">·</span>
                        <span>
                            {showcase.annotationCount} annotation{showcase.annotationCount === 1 ? '' : 's'}
                        </span>
                    </>
                ) : null}
                {showcase.hasOutcomeLink ? (
                    <>
                        <span aria-hidden="true">·</span>
                        <span>Has outcome</span>
                    </>
                ) : null}
            </div>
        </li>
    );
}
