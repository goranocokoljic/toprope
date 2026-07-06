import {Link, useNavigate, useParams} from 'react-router-dom';
import {useShowcaseDetail, useUnpublishShowcase} from '../hooks/useShowcases';
import type {BrowseShowcaseDetail, ShowcaseAnnotatedTurn, ShowcaseAnnotation} from '../api/types';
import {Card} from '../components/Card';
import {Skeleton} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {ApiError} from '../api/client';
import {formatDateTick} from '../components/format';

/**
 * Showcase unit detail (Task 6.3.9 / #172).
 *
 * Reads one showcase the viewer may see and renders every unit component: the
 * prominent curators' note + outcome link, the inline-annotated conversation (turn by
 * turn, each with the developer's reasoning beside it), the clearly-AI secondary
 * prompt-technique annotation, the cross-linked best practices ("demonstrates"), and
 * — to the author only — the unpublish affordance. A 404 from the API (out of scope /
 * not published / missing) renders a clear not-found state. The public view carries no
 * critique: it is celebratory only. Styling uses semantic theme tokens (dark mode free).
 */
export function ShowcaseDetail(): JSX.Element {
    const {id: idParam} = useParams<{id: string}>();
    const id = idParam ?? '';
    const {data, isPending, isError, error, refetch} = useShowcaseDetail(id);

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
                title={notFound ? 'Showcase not found' : 'Failed to load this showcase'}
                detail={
                    notFound
                        ? 'It may have been unpublished or removed, or it’s outside what you can see.'
                        : error?.message
                }
                onRetry={notFound ? undefined : () => void refetch()}
            />
        );
    }

    return <ShowcaseDetailContent showcase={data} />;
}

/**
 * A link safe to render as a clickable `<a href>`: the value only when it parses as an
 * absolute http(s) URL, else null. Defense-in-depth against a stored `javascript:` /
 * `data:` outcome link (stored XSS) — the server validates the scheme at the write
 * boundary, but the renderer neutralizes anything non-http(s) by rendering it as plain
 * text rather than a clickable link, so a link that predates the server gate (or arrives
 * any other way) can never become script-bearing.
 */
function safeHttpUrl(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
}

function ShowcaseDetailContent({showcase}: {showcase: BrowseShowcaseDetail}): JSX.Element {
    return (
        <div className="space-y-5">
            <div>
                <Link to="/developer/showcase" className="text-xs text-accent hover:underline">
                    ← All showcases
                </Link>
                <h1 className="mt-2 text-2xl font-semibold text-foreground">{showcase.title}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{showcase.authorName ?? 'Unknown author'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="capitalize">{showcase.scope}</span>
                    <span aria-hidden="true">·</span>
                    <span>Updated {formatDateTick(showcase.updatedAt.slice(0, 10))}</span>
                </div>
            </div>

            {showcase.canUnpublish ? <UnpublishControl showcase={showcase} /> : null}

            {/* The curators' note ("what to take away") and outcome lead the view. */}
            <Card title="What to take away">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground" data-testid="curators-note">
                    {showcase.curatorsNote}
                </p>
                {showcase.hasOutcomeLink && showcase.outcomeLink ? (
                    <OutcomeLink link={showcase.outcomeLink} />
                ) : null}
            </Card>

            <Conversation showcase={showcase} />

            <AiAnnotation showcase={showcase} />

            <CrossLinks showcase={showcase} />
        </div>
    );
}

/**
 * The outcome link — a clickable `<a href>` ONLY when the value is a safe http(s) URL;
 * a non-http(s) value (e.g. a stored `javascript:` link) is neutralized to plain text
 * so it can never execute. This is the render-side half of the outcome-link scheme
 * validation (the server enforces the other half at the write boundary).
 */
function OutcomeLink({link}: {link: string}): JSX.Element {
    const safe = safeHttpUrl(link);
    return (
        <p className="mt-3 text-sm">
            <span className="text-muted">Outcome: </span>
            {safe ? (
                <a
                    href={safe}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                    data-testid="outcome-link"
                >
                    {link}
                </a>
            ) : (
                <span className="text-foreground" data-testid="outcome-link-unsafe">
                    {link}
                </span>
            )}
        </p>
    );
}

/** Owner-only unpublish affordance. On success, returns to the gallery. */
function UnpublishControl({showcase}: {showcase: BrowseShowcaseDetail}): JSX.Element {
    const navigate = useNavigate();
    const unpublish = useUnpublishShowcase(showcase.id);

    return (
        <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-raised p-3"
            data-testid="unpublish-control"
        >
            <p className="text-xs text-muted">
                You published this showcase. You can remove it from the gallery at any time.
            </p>
            <button
                type="button"
                disabled={unpublish.isPending}
                onClick={() => unpublish.mutate(undefined, {onSuccess: () => navigate('/developer/showcase')})}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground disabled:opacity-60"
            >
                {unpublish.isPending ? 'Unpublishing…' : 'Unpublish'}
            </button>
        </div>
    );
}

/** A conversation turn's role + text, narrowed defensively from the opaque payload. */
function turnText(turn: unknown): {role: string; text: string} {
    if (turn && typeof turn === 'object') {
        const t = turn as {role?: unknown; text?: unknown; content?: unknown};
        const role = typeof t.role === 'string' ? t.role : 'turn';
        const text =
            typeof t.text === 'string' ? t.text : typeof t.content === 'string' ? t.content : JSON.stringify(turn);
        return {role, text};
    }
    return {role: 'turn', text: String(turn)};
}

/** The inline-annotated conversation: each turn beside the developer's reasoning. */
function Conversation({showcase}: {showcase: BrowseShowcaseDetail}): JSX.Element {
    const {turns, orphaned} = showcase.display;
    return (
        <Card title="The conversation">
            <ol className="space-y-4" data-testid="conversation">
                {turns.map((turn, index) => (
                    <ConversationTurn key={turn.turnRef || index} turn={turn} />
                ))}
            </ol>
            {orphaned.length > 0 ? (
                <div className="mt-4 border-t border-border/60 pt-3" data-testid="orphaned-annotations">
                    <p className="text-xs font-medium text-muted">Notes without an anchored turn</p>
                    <ul className="mt-1.5 space-y-1.5">
                        {orphaned.map((a) => (
                            <AnnotationItem key={a.id} annotation={a} />
                        ))}
                    </ul>
                </div>
            ) : null}
        </Card>
    );
}

function ConversationTurn({turn}: {turn: ShowcaseAnnotatedTurn}): JSX.Element {
    const {role, text} = turnText(turn.turn);
    return (
        <li className="rounded-md border border-border/60 bg-surface-raised p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted">{role}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{text}</p>
            {turn.annotations.length > 0 ? (
                <ul className="mt-2 space-y-1.5 border-l-2 border-accent/40 pl-3">
                    {turn.annotations.map((a) => (
                        <AnnotationItem key={a.id} annotation={a} />
                    ))}
                </ul>
            ) : null}
        </li>
    );
}

/** One inline developer annotation — the highest-value teaching layer (the human voice). */
function AnnotationItem({annotation}: {annotation: ShowcaseAnnotation}): JSX.Element {
    return (
        <li className="text-xs text-foreground" data-testid="annotation">
            <span className="text-accent">▸</span> {annotation.body}
        </li>
    );
}

/**
 * The optional AI prompt-technique annotation — rendered clearly as AI and visually
 * SECONDARY, below the human voice. Hidden entirely when none was generated.
 */
function AiAnnotation({showcase}: {showcase: BrowseShowcaseDetail}): JSX.Element | null {
    const ai = showcase.aiAnnotation;
    if (!ai.present || !ai.text) {
        return null;
    }
    return (
        <div className="rounded-card border border-dashed border-border bg-surface p-3" data-testid="ai-annotation">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted">{ai.label}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{ai.text}</p>
        </div>
    );
}

/** Cross-linked best practices this showcase demonstrates (6.3.8) — rendered only when present. */
function CrossLinks({showcase}: {showcase: BrowseShowcaseDetail}): JSX.Element | null {
    if (showcase.practices.length === 0) {
        return null;
    }
    return (
        <Card title="Demonstrates">
            <ul className="space-y-1.5" data-testid="practice-cross-links">
                {showcase.practices.map((practice) => (
                    <li key={practice.id} className="text-sm">
                        <Link
                            to={`/developer/practices/${encodeURIComponent(practice.id)}`}
                            className="text-accent hover:underline"
                        >
                            {practice.title}
                        </Link>
                    </li>
                ))}
            </ul>
        </Card>
    );
}
