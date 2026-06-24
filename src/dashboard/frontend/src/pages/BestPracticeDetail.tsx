import {useState} from 'react';
import {Link, useParams} from 'react-router-dom';
import {usePracticeDetail, usePracticeHistory, useTogglePracticeFeedback} from '../hooks/usePractices';
import type {BrowsePracticeDetail, PracticeFeedbackSignal} from '../api/types';
import {Card} from '../components/Card';
import {Skeleton} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {ApiError} from '../api/client';
import {formatPercent, formatDateTick} from '../components/format';
import {contributionModelExplainer} from '../components/practiceModel';

/**
 * Best-practice detail view (Task 6.2.8 / #163).
 *
 * Reads one practice the viewer may see and renders: its sanitized rich content (6.2.3),
 * a togglable helpful / not-helpful feedback affordance (6.2.4), access to its version
 * history, the model-aware edit entry point (shown only to the author), and any showcase
 * cross-links ("see it in action", 6.3.8 — rendered only when present). A 404 from the
 * API (out of scope / not published / missing) renders a clear not-found state.
 */
export function BestPracticeDetail(): JSX.Element {
    const {id: idParam} = useParams<{id: string}>();
    const id = idParam ?? '';
    const {data, isPending, isError, error, refetch} = usePracticeDetail(id);

    if (isPending) {
        return (
            <div className="space-y-4">
                <Skeleton className="h-8 w-2/3" />
                <Card>
                    <Skeleton className="h-40 w-full" />
                </Card>
            </div>
        );
    }

    if (isError) {
        const notFound = error instanceof ApiError && error.status === 404;
        return (
            <ErrorState
                title={notFound ? 'Practice not found' : 'Failed to load this practice'}
                detail={
                    notFound
                        ? 'It may have been unpublished, or it’s outside what you can see.'
                        : error?.message
                }
                onRetry={notFound ? undefined : () => void refetch()}
            />
        );
    }

    return <PracticeDetailContent practice={data} />;
}

function PracticeDetailContent({practice}: {practice: BrowsePracticeDetail}): JSX.Element {
    return (
        <div className="space-y-5">
            <div>
                <Link to="/developer/practices" className="text-xs text-accent hover:underline">
                    ← All best practices
                </Link>
                <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
                    <h1 className="text-2xl font-semibold text-foreground">{practice.title}</h1>
                    {practice.endorsed ? (
                        <span className="rounded bg-success/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-success">
                            Endorsed
                        </span>
                    ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{practice.authorName ?? 'Unknown author'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="capitalize">{practice.scope}</span>
                    <span aria-hidden="true">·</span>
                    <span>Updated {formatDateTick(practice.updatedAt.slice(0, 10))}</span>
                    <span aria-hidden="true">·</span>
                    <span>v{practice.currentVersion}</span>
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
            </div>

            {practice.canEdit ? <EditEntryPoint practice={practice} /> : null}

            <Card>
                <div
                    className="practice-content space-y-3 text-sm leading-relaxed text-foreground [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-surface-raised [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-raised [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5"
                    data-testid="practice-content"
                    // The HTML is sanitized server-side by the authoring engine (6.2.3),
                    // so it is safe to inject — no client-side sanitization needed.
                    dangerouslySetInnerHTML={{__html: practice.html}}
                />
            </Card>

            <ShowcaseCrossLinks practice={practice} />

            <FeedbackControls practice={practice} />

            <VersionHistory id={practice.id} currentVersion={practice.currentVersion} />
        </div>
    );
}

/** Model-aware edit affordance — shown only to the author (canEdit). */
function EditEntryPoint({practice}: {practice: BrowsePracticeDetail}): JSX.Element {
    return (
        <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-raised p-3"
            data-testid="edit-entry-point"
        >
            <p className="text-xs text-muted">
                You authored this practice. {contributionModelExplainer(practice.model)}
            </p>
            <Link
                to={`/developer/practices/${encodeURIComponent(practice.id)}/edit`}
                className="shrink-0 rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft"
            >
                Edit
            </Link>
        </div>
    );
}

/** Showcase cross-links ("see it in action") — rendered only when present (6.3.8). */
function ShowcaseCrossLinks({practice}: {practice: BrowsePracticeDetail}): JSX.Element | null {
    if (practice.showcases.length === 0) {
        return null;
    }
    return (
        <Card title="See it in action">
            <ul className="space-y-1.5" data-testid="showcase-cross-links">
                {practice.showcases.map((showcase) => (
                    <li key={showcase.id} className="text-sm">
                        <Link
                            to={`/developer/showcase/${encodeURIComponent(showcase.id)}`}
                            className="text-accent hover:underline"
                        >
                            {showcase.title}
                        </Link>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

/** Togglable helpful / not-helpful feedback (6.2.4). */
function FeedbackControls({practice}: {practice: BrowsePracticeDetail}): JSX.Element {
    const toggle = useTogglePracticeFeedback(practice.id);
    const {viewerSignal, helpful, notHelpful, helpfulRatio} = practice.feedback;

    function press(signal: PracticeFeedbackSignal): void {
        toggle.mutate(signal);
    }

    return (
        <Card title="Was this helpful?">
            <div className="flex flex-wrap items-center gap-3" data-testid="feedback-controls">
                <FeedbackButton
                    active={viewerSignal === 'helpful'}
                    label="Helpful"
                    count={helpful}
                    tone="success"
                    disabled={toggle.isPending}
                    onClick={() => press('helpful')}
                />
                <FeedbackButton
                    active={viewerSignal === 'not_helpful'}
                    label="Not helpful"
                    count={notHelpful}
                    tone="muted"
                    disabled={toggle.isPending}
                    onClick={() => press('not_helpful')}
                />
                {helpfulRatio !== null && helpfulRatio > 0 ? (
                    <span className="text-xs text-muted">{formatPercent(helpfulRatio)} found this helpful</span>
                ) : null}
            </div>
        </Card>
    );
}

function FeedbackButton({
    active,
    label,
    count,
    tone,
    disabled,
    onClick,
}: {
    active: boolean;
    label: string;
    count: number;
    tone: 'success' | 'muted';
    disabled: boolean;
    onClick: () => void;
}): JSX.Element {
    const activeClass =
        tone === 'success' ? 'border-success bg-success/10 text-success' : 'border-accent bg-accent-soft text-accent';
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
                active ? activeClass : 'border-border text-muted hover:text-foreground'
            }`}
        >
            {label}
            <span className="tabular-nums">{count}</span>
        </button>
    );
}

/** Collapsible version-history access; the history is fetched only when opened. */
function VersionHistory({id, currentVersion}: {id: string; currentVersion: number}): JSX.Element {
    const [open, setOpen] = useState(false);
    const {data, isPending, isError, refetch} = usePracticeHistory(id, open);

    return (
        <Card title="Version history">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="text-xs font-medium text-accent hover:underline"
            >
                {open ? 'Hide' : `Show history (${currentVersion} ${currentVersion === 1 ? 'version' : 'versions'})`}
            </button>
            {open ? (
                <div className="mt-3" data-testid="version-history">
                    {isPending ? <Skeleton className="h-16 w-full" /> : null}
                    {isError ? (
                        <ErrorState title="Failed to load history" onRetry={() => void refetch()} />
                    ) : null}
                    {data && data.length > 0 ? (
                        <ul className="space-y-2">
                            {[...data].reverse().map((entry) => (
                                <li
                                    key={entry.version}
                                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/60 pb-2 text-xs last:border-0"
                                >
                                    <span className="font-medium text-foreground">v{entry.version}</span>
                                    <span className="text-muted">{entry.authorName ?? 'Unknown'}</span>
                                    <span className="text-muted">{formatDateTick(entry.createdAt.slice(0, 10))}</span>
                                    {entry.changeNote ? (
                                        <span className="text-muted">— {entry.changeNote}</span>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {data && data.length === 0 ? (
                        <p className="text-xs text-muted">No history available.</p>
                    ) : null}
                </div>
            ) : null}
        </Card>
    );
}
