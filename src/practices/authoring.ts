/**
 * Rich authoring engine for best practices (Task 6.2.3 / #158).
 *
 * The authoring surface's content layer: it turns a developer's markdown — with
 * formatting, fenced code blocks (critical for prompt/code examples), and embedded
 * `{{metric}}` references — into a SAFE rendered preview and the auto-surfacing tags
 * those references imply, and it persists every save THROUGH the 6.1.3 versioning
 * primitive so each save is a new version (history is never overwritten).
 *
 * Three contracts the rest of the system relies on:
 *
 *   1. RENDER IS SAFE BY CONSTRUCTION. Markdown is rendered with `marked` and then
 *      passed through `sanitize-html` with a fixed allowlist. Anything outside that
 *      allowlist — `<script>`, inline event handlers, `javascript:` URLs — is dropped,
 *      so no markdown a developer types can inject script into a viewer's page. The
 *      sanitizer is the trust boundary; the renderer never emits unsanitized output.
 *
 *   2. A METRIC REFERENCE PRODUCES A TAG, AND ONLY OUTSIDE CODE. `{{churn}}` in prose
 *      renders as a metric chip and contributes the `churn` auto-surfacing tag; the
 *      same text inside a code span/block is an EXAMPLE and is left verbatim — never
 *      chipped, never tagged. Both the chip and the tag come from the same `marked`
 *      tokenization, so the preview a developer sees and the tags a save writes can
 *      never disagree. An unrecognised `{{foo}}` (not in the metric vocabulary) stays
 *      literal so a typo is visible rather than minting a dead tag.
 *
 *   3. SAVING IS VERSIONING. `createPractice` establishes version 1; `savePractice`
 *      appends a new version and advances `current_version`; `revertPractice` recreates
 *      a prior body as a NEW version. None of these ever mutate or delete a prior
 *      version — they delegate to the 6.1.3 engine, which owns that guarantee.
 *
 * Feature boundary: the spine stores a version `body` as an opaque JSON string. For a
 * best practice that body is `{"markdown": "..."}`; this module is the one place that
 * shape is encoded and decoded, so the spine stays content-agnostic.
 */

import type Database from 'better-sqlite3';
import {Marked, type Tokens} from 'marked';
import sanitizeHtml from 'sanitize-html';
import {
    addContributionTag,
    createContribution,
    getContribution,
    getContributionTags,
    removeContributionTag,
} from '../contributions/store';
import {editContribution, getCurrentVersion, revertToVersion} from '../contributions/versioning';
import type {Contribution, ContributionScope, ContributionState, ContributionVersion} from '../contributions/types';
import {setPracticeDetails} from './store';
import {isPracticeMetric} from './metrics';

/** The contribution content type best practices are stored under. */
export const PRACTICE_CONTENT_TYPE = 'best_practice';

/** Bounds shared by the service and its HTTP edge, so both reject oversize input identically. */
export const MAX_PRACTICE_MARKDOWN_LEN = 100_000;
export const MAX_PRACTICE_TITLE_LEN = 200;

/** The decoded payload carried in a best-practice version body. */
export interface PracticeContent {
    markdown: string;
}

/** A rendered preview: sanitized HTML plus the metric tags the body's references imply. */
export interface RenderedPractice {
    /** Sanitized HTML, safe to inject into a viewer's page. */
    html: string;
    /** The distinct, sorted metric identifiers referenced in PROSE (never from code). */
    metrics: string[];
}

/** Stable error codes the caller (route/service) can map to an HTTP status. */
export type AuthoringErrorCode = 'empty_markdown' | 'empty_title' | 'not_a_practice';

/** A typed failure from the authoring layer, distinct from the spine's `VersioningError`. */
export class AuthoringError extends Error {
    constructor(
        readonly code: AuthoringErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'AuthoringError';
    }
}

// --- Markdown rendering -----------------------------------------------------

/** A custom inline token for an embedded `{{metric}}` reference. */
interface MetricRefToken extends Tokens.Generic {
    type: 'metricRef';
    raw: string;
    metric: string;
}

/** Minimal HTML-escape for the literal fallback of an unrecognised reference. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * A `marked` instance with one inline extension that recognises `{{metric}}`.
 * Because it is an INLINE extension, `marked` never invokes it inside a fenced code
 * block or an inline code span — so a `{{churn}}` shown as an example is preserved
 * verbatim, automatically, with no special-casing here. A recognised metric renders
 * as a chip carrying `data-metric` (the hook the tag extraction and a future
 * surfacing UI both read); an unrecognised one renders as its escaped literal text.
 */
const markdown = new Marked({
    gfm: true,
    breaks: false,
    extensions: [
        {
            name: 'metricRef',
            level: 'inline',
            start(src: string): number | undefined {
                const idx = src.indexOf('{{');
                return idx < 0 ? undefined : idx;
            },
            tokenizer(src: string): MetricRefToken | undefined {
                const match = /^\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/.exec(src);
                if (!match) {
                    return undefined;
                }
                return {type: 'metricRef', raw: match[0], metric: match[1]};
            },
            renderer(token: Tokens.Generic): string {
                const metric = (token as MetricRefToken).metric;
                if (isPracticeMetric(metric)) {
                    return `<span class="metric-ref" data-metric="${metric}">${escapeHtml(metric)}</span>`;
                }
                return escapeHtml((token as MetricRefToken).raw);
            },
        },
    ],
});

/**
 * The sanitizer allowlist. Permits the markdown formatting set (headings, emphasis,
 * lists, blockquotes, tables, links, images, and crucially `pre`/`code` for code
 * blocks) plus the metric chip's `span[class][data-metric]`. Everything else —
 * `<script>`, `<iframe>`, event-handler attributes, `javascript:`/`data:` URLs — is
 * dropped. `allowedSchemes` keeps link/image URLs to safe protocols.
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
    allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'hr', 'blockquote',
        'ul', 'ol', 'li',
        'strong', 'em', 'del', 'code', 'pre',
        'a', 'img',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'span',
    ],
    allowedAttributes: {
        a: ['href', 'title'],
        img: ['src', 'alt', 'title'],
        code: ['class'],
        span: ['class', 'data-metric'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    // Drop, rather than escape, the content of disallowed tags so a stripped
    // <script> leaves no executable residue and no visible leftover text.
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
};

/**
 * Render markdown to a sanitized preview and extract the metric tags its prose
 * references imply. The metric set is read off the rendered (pre-sanitize) HTML's
 * `data-metric` attributes AND filtered back through the vocabulary — code-block and
 * inline-code references contribute neither a chip nor a tag, and unrecognised
 * references contribute neither either. The returned `metrics` are distinct and
 * sorted for a deterministic tag set.
 *
 * Why the vocabulary filter, given the renderer only ever emits `data-metric` for a
 * recognised metric: `marked` passes RAW HTML in the markdown through verbatim, so a
 * developer could hand-write `<span data-metric="anything">…` directly in their body.
 * Without the filter that raw attribute would be scraped into the tag set, minting a
 * tag outside `PRACTICE_METRICS` that `syncMetricTags` could never reconcile away
 * (it only removes recognised metrics). Re-checking `isPracticeMetric` here keeps the
 * tag path gated by exactly the same vocabulary the chip path is, so no raw-HTML
 * escape hatch can forge an auto-surfacing tag.
 *
 * Pure and side-effect free: this is the engine behind both the live-preview
 * endpoint and the tag reconciliation a save performs.
 */
export function renderPractice(md: string): RenderedPractice {
    const rendered = markdown.parse(md) as string;
    const metrics = new Set<string>();
    for (const match of rendered.matchAll(/data-metric="([a-zA-Z0-9_]+)"/g)) {
        if (isPracticeMetric(match[1])) {
            metrics.add(match[1]);
        }
    }
    const html = sanitizeHtml(rendered, SANITIZE_OPTIONS);
    return {html, metrics: [...metrics].sort()};
}

/**
 * The metric identifiers a body references in prose (recognised, distinct, sorted) —
 * the auto-surfacing tags a save will reconcile. A thin projection of
 * {@link renderPractice} so the two can never disagree about what counts as a
 * reference.
 */
export function extractMetricRefs(md: string): string[] {
    return renderPractice(md).metrics;
}

// --- Body encode / decode ---------------------------------------------------

function encodeContent(content: PracticeContent): string {
    return JSON.stringify({markdown: content.markdown});
}

/**
 * Decode a version body into its markdown. Lenient by design: a well-formed
 * `{"markdown": "..."}` yields that markdown; anything else (legacy or hand-written
 * body that is not our JSON shape) is treated as raw markdown text, so a read never
 * throws on an unexpected body — it degrades to showing the body as-is.
 */
export function decodeContent(body: string): PracticeContent {
    try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && typeof (parsed as {markdown?: unknown}).markdown === 'string') {
            return {markdown: (parsed as {markdown: string}).markdown};
        }
    } catch {
        // Not our JSON shape — fall through to treating the body as raw markdown.
    }
    return {markdown: body};
}

// --- Tag reconciliation -----------------------------------------------------

/**
 * Reconcile a contribution's metric-derived tags to `desired`. Adds any newly
 * referenced metric, removes any metric tag no longer referenced, and — critically —
 * leaves every NON-metric (free-form / manually added) tag untouched, since those are
 * not part of the authoring surface's contract. Idempotent.
 */
function syncMetricTags(db: Database.Database, contributionId: string, desired: readonly string[]): void {
    const desiredSet = new Set(desired);
    for (const tag of getContributionTags(db, contributionId)) {
        if (isPracticeMetric(tag) && !desiredSet.has(tag)) {
            removeContributionTag(db, contributionId, tag);
        }
    }
    for (const metric of desired) {
        addContributionTag(db, contributionId, metric);
    }
}

/** Reject an empty/whitespace-only markdown body before it reaches the version store. */
function requireNonEmptyMarkdown(md: string): void {
    if (md.trim() === '') {
        throw new AuthoringError('empty_markdown', 'A practice body cannot be empty.');
    }
}

/**
 * Load a contribution and assert it is a best practice. The versioning primitive is
 * content-agnostic, so guarding the content type is the authoring layer's job: it
 * keeps the practice routes from versioning, say, a showcase example. Returns the
 * contribution, or undefined when it does not exist (so the caller can surface the
 * spine's own not-found) — throws `not_a_practice` when it exists but is some other
 * content type.
 */
function requirePractice(db: Database.Database, contributionId: string): Contribution | undefined {
    const contribution = getContribution(db, contributionId);
    if (!contribution) {
        return undefined;
    }
    if (contribution.contentType !== PRACTICE_CONTENT_TYPE) {
        throw new AuthoringError(
            'not_a_practice',
            `Contribution '${contributionId}' is not a best practice (content type '${contribution.contentType}').`,
        );
    }
    return contribution;
}

// --- Create / save / revert -------------------------------------------------

export interface CreatePracticeInput {
    title: string;
    /** The authoring developer — recorded as author of the contribution and version 1. */
    authorId: string;
    scope: ContributionScope;
    /** Team name when team-scoped; null/omitted for org-wide. */
    scopeTarget?: string | null;
    markdown: string;
    changeNote?: string | null;
    /** The AI model used to assist authoring, if any — persisted to practice_details. */
    modelUsed?: string | null;
    timestamp?: string;
}

export interface CreatedPractice {
    contribution: Contribution;
    /** The metric tags attached from the body's references. */
    metrics: string[];
}

/**
 * Create a best practice from markdown: establishes the spine contribution (version
 * 1, state `draft`), records its practice details, and attaches the auto-surfacing
 * tags its references imply — all in one transaction, so a half-created practice can
 * never be observed. Returns the new contribution and the tags attached.
 *
 * Throws `empty_title` for a blank title and `empty_markdown` for a blank body.
 */
export function createPractice(db: Database.Database, input: CreatePracticeInput): CreatedPractice {
    const title = input.title.trim();
    if (title === '') {
        throw new AuthoringError('empty_title', 'A practice title cannot be empty.');
    }
    requireNonEmptyMarkdown(input.markdown);
    const metrics = extractMetricRefs(input.markdown);

    return db.transaction((): CreatedPractice => {
        const contribution = createContribution(db, {
            contentType: PRACTICE_CONTENT_TYPE,
            title,
            authorId: input.authorId,
            scope: input.scope,
            scopeTarget: input.scopeTarget ?? null,
            body: encodeContent({markdown: input.markdown}),
            changeNote: input.changeNote ?? null,
            timestamp: input.timestamp,
        });
        // Only write a details row when there is something to record; an absent row is
        // the valid "not AI-assisted, not endorsed" default the store already models.
        if (input.modelUsed !== undefined && input.modelUsed !== null) {
            setPracticeDetails(db, contribution.id, {modelUsed: input.modelUsed});
        }
        syncMetricTags(db, contribution.id, metrics);
        return {contribution, metrics};
    })();
}

export interface SavePracticeInput {
    /** The acting developer — recorded as the new version's author. */
    actorId: string;
    markdown: string;
    changeNote?: string | null;
    timestamp?: string;
}

export interface SavedPractice {
    version: ContributionVersion;
    /** The metric tags after reconciliation against the saved body. */
    metrics: string[];
}

/**
 * Save an edit to a best practice: appends a new version through the 6.1.3 engine
 * (advancing `current_version`) and reconciles the metric tags to the new body, in
 * one transaction. History is never overwritten — the prior version is retained.
 *
 * Throws `empty_markdown` for a blank body and `not_a_practice` when the id is some
 * other content type. A missing or `removed` contribution surfaces the spine's
 * `VersioningError` (`not_found` / `contribution_removed`), as does a blank actor
 * (`invalid_actor`).
 */
export function savePractice(db: Database.Database, contributionId: string, input: SavePracticeInput): SavedPractice {
    requirePractice(db, contributionId); // throws not_a_practice; undefined falls through to versioning's not_found
    requireNonEmptyMarkdown(input.markdown);
    const metrics = extractMetricRefs(input.markdown);

    return db.transaction((): SavedPractice => {
        const version = editContribution(db, contributionId, {
            actorId: input.actorId,
            body: encodeContent({markdown: input.markdown}),
            changeNote: input.changeNote ?? null,
            timestamp: input.timestamp,
        });
        syncMetricTags(db, contributionId, metrics);
        return {version, metrics};
    })();
}

export interface RevertPracticeInput {
    actorId: string;
    changeNote?: string | null;
    timestamp?: string;
}

/**
 * Revert a best practice to a prior version: recreates that version's body as a NEW
 * version (history preserved) and reconciles the metric tags to the reverted body —
 * so surfacing follows the content that is now current. One transaction.
 *
 * Throws `not_a_practice` for a non-practice id; surfaces the spine's `VersioningError`
 * for a missing/removed contribution, a missing target version, a blank actor, or a
 * blank target body.
 */
export function revertPractice(
    db: Database.Database,
    contributionId: string,
    targetVersion: number,
    input: RevertPracticeInput,
): SavedPractice {
    requirePractice(db, contributionId);

    return db.transaction((): SavedPractice => {
        const version = revertToVersion(db, contributionId, targetVersion, {
            actorId: input.actorId,
            changeNote: input.changeNote ?? null,
            timestamp: input.timestamp,
        });
        const metrics = extractMetricRefs(decodeContent(version.body).markdown);
        syncMetricTags(db, contributionId, metrics);
        return {version, metrics};
    })();
}

// --- Read -------------------------------------------------------------------

/** The author-facing view of a practice: its current markdown plus a rendered preview. */
export interface PracticeView {
    contributionId: string;
    title: string;
    state: ContributionState;
    currentVersion: number;
    markdown: string;
    html: string;
    metrics: string[];
}

/**
 * The current content of a best practice, rendered. Returns undefined when the id
 * does not exist or is not a best practice (so a route can 404 uniformly). The HTML
 * is sanitized — safe to serve straight to a viewer.
 */
export function getPracticeView(db: Database.Database, contributionId: string): PracticeView | undefined {
    const contribution = requirePractice(db, contributionId);
    if (!contribution) {
        return undefined;
    }
    const current = getCurrentVersion(db, contributionId);
    const md = current ? decodeContent(current.body).markdown : '';
    const {html, metrics} = renderPractice(md);
    return {
        contributionId: contribution.id,
        title: contribution.title,
        state: contribution.state,
        currentVersion: contribution.currentVersion,
        markdown: md,
        html,
        metrics,
    };
}
