/**
 * Search over the contribution spine (Task 6.1.5 / #155).
 *
 * The feature-agnostic primitive that makes shared content DISCOVERABLE: a single
 * free-text search across every contribution (best practices + showcase examples
 * today), with structured filters (content_type, scope, team, tag, lifecycle state)
 * that combine, and — non-negotiably — results that NEVER leak outside the viewer's
 * scope. Like the rest of Epic 6.1 it knows nothing about what a best practice or a
 * showcase example is; it searches the spine's own columns.
 *
 * How it fits the other 6.1 primitives:
 *   * The free-text matching runs against the FTS5 `contribution_search` index
 *     (migration 035), which triggers keep fresh as content is created, edited
 *     (6.1.3), tagged, published/unpublished (6.1.2 state changes), and removed —
 *     so the "index updates when content changes" criterion holds at the DB layer.
 *   * Filtering and scope read the LIVE `contributions` table (the FTS row carries
 *     only free text), so type/scope/team/state are always the authoritative values.
 *   * Scope enforcement REUSES the 6.1.4 resolver ({@link resolveVisible}): after the
 *     text+filter query selects candidates, they are passed through the exact same
 *     visibility rule the browse surfaces use, so search can never surface content a
 *     viewer could not otherwise see — including respecting per-team hides.
 *
 * Ranking: when a text query is present, results are ordered by FTS5 `bm25`
 * relevance (lower is better), with title matches weighted above body and tags so a
 * title hit outranks a passing mention. With no text query it is a pure filtered
 * browse, ordered newest-first to match the store's default. Feature-specific
 * ranking (e.g. blending in usage/feedback signals) is layered on later by 6.2/6.3.
 *
 * KNOWN LIMITATION — the body is the spine's opaque JSON payload, indexed VERBATIM
 * (the spine must not parse it). So the JSON's own structural KEYS are tokenized and
 * indexed alongside the prose: a free-text query for a word that happens to be an
 * envelope key (e.g. `markdown`) will match every contribution that uses that key.
 * This is the documented tradeoff of keeping the spine feature-agnostic; the fix is
 * for a feature to later supply EXTRACTED text to index instead of the raw envelope.
 */

import type Database from 'better-sqlite3';
import {resolveVisibleForViewer} from './scope';
import type {Contribution, ContributionFilters} from './types';
import {isContributionScope, isContributionState} from './types';

interface ContributionRow {
    id: string;
    content_type: string;
    title: string;
    author_id: string;
    scope: string;
    scope_target: string | null;
    state: string;
    current_version: number;
    created_at: string;
    updated_at: string;
}

/** A single search hit: the matched contribution plus its text-relevance score. */
export interface ContributionSearchResult {
    contribution: Contribution;
    /**
     * Text relevance for this hit. Lower is more relevant (FTS5 `bm25` convention);
     * `0` for every result of a no-text (pure-filter) query, where ordering is by
     * recency instead. Exposed so a feature can re-rank by blending it with its own
     * signals rather than re-running the search.
     */
    score: number;
}

/**
 * A search request. Every field is optional: an empty query lists everything the
 * viewer may see, newest-first.
 */
export interface ContributionSearchQuery {
    /** Free text. Tokenized and matched against title/body/tags; empty/blank = no text filter. */
    text?: string;
    /** Require this exact tag (the "tag" filter). Combines (AND) with text and the others. */
    tag?: string;
    /**
     * Structured filters on the spine row — content_type, scope, scope_target (the
     * "team" filter: a team name selects that team's content, explicit `null` selects
     * org-wide), state, author. Reuses the store's filter shape so the semantics
     * (including the `null` scopeTarget → `IS NULL` rule) match listing exactly.
     */
    filters?: ContributionFilters;
    /**
     * The viewer's team, used for SCOPE ENFORCEMENT (not a content filter): org items
     * plus this team's items are eligible; everything else is removed. `null`/omitted
     * means a teamless viewer, who sees only org items.
     */
    viewerTeam?: string | null;
    /**
     * Whether the viewer's per-team hides are honored (the resolved 6.1.4 permission).
     * Defaults to `true`. `false` ignores stored hides so a hidden org item resurfaces,
     * mirroring the settings resolver ignoring an override when its flag is off.
     */
    hidesPermitted?: boolean;
    /** Cap the number of results (applied AFTER scope resolution). Omit for no cap. */
    limit?: number;
}

function rowToContribution(row: ContributionRow): Contribution {
    return {
        id: row.id,
        contentType: row.content_type,
        title: row.title,
        authorId: row.author_id,
        scope: isContributionScope(row.scope) ? row.scope : 'team',
        scopeTarget: row.scope_target,
        state: isContributionState(row.state) ? row.state : 'removed',
        currentVersion: row.current_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Turn arbitrary user text into a SAFE FTS5 MATCH expression, or `null` when the
 * text carries no usable search term. FTS5's query language treats characters like
 * `"`, `*`, `(`, `:`, `-`, `^` and bare `AND`/`OR`/`NOT` as syntax, so passing raw
 * user input straight to MATCH risks a SQLITE_ERROR (or surprising boolean logic).
 *
 * Strategy: split on whitespace, strip every FTS-significant character from each
 * token (keeping letters, digits and underscore — unicode-aware), drop now-empty
 * tokens, then re-quote each surviving token as a double-quoted string and append a
 * `*` so it matches as a prefix ("chu" finds "churn"). Tokens are space-joined,
 * which FTS5 reads as implicit AND — all terms must appear, with `bm25` ranking the
 * AND-matches by relevance. Returns `null` if nothing usable survives, so the caller
 * treats the query as text-less rather than building an empty MATCH.
 */
export function buildMatchExpression(text: string): string | null {
    const tokens = text
        .split(/\s+/)
        // Keep unicode letters/numbers and underscore; drop all FTS operators/quotes.
        .map((tok) => tok.replace(/[^\p{L}\p{N}_]/gu, ''))
        .filter((tok) => tok.length > 0);
    if (tokens.length === 0) {
        return null;
    }
    return tokens.map((tok) => `"${tok}"*`).join(' ');
}

/**
 * Search the contribution spine.
 *
 * Pipeline: build the candidate query from the text match (against the FTS index)
 * and the structured filters (against the live spine), order by relevance when there
 * is text else by recency, then ENFORCE SCOPE by running the candidates through the
 * 6.1.4 resolver with the viewer's team and per-team hides. The scope step is the
 * last word: no filter combination can widen a viewer's visibility past it.
 *
 * Returns hits in ranked order. `limit` is applied after scope resolution so a
 * capped result set is never silently shrunk by out-of-scope rows that were going to
 * be dropped anyway.
 */
export function searchContributions(
    db: Database.Database,
    query: ContributionSearchQuery = {},
): ContributionSearchResult[] {
    const filters = query.filters ?? {};
    const match = query.text !== undefined ? buildMatchExpression(query.text) : null;

    const joins: string[] = [];
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (match !== null) {
        // INNER JOIN to the FTS index restricts to text matches; bm25 gives the score.
        joins.push('JOIN contribution_search cs ON cs.contribution_id = c.id');
        clauses.push('contribution_search MATCH ?');
        params.push(match);
    }

    if (query.tag !== undefined) {
        // EXISTS (not a JOIN) so a contribution with the tag appears once, not per row.
        clauses.push('EXISTS (SELECT 1 FROM contribution_tags ct WHERE ct.contribution_id = c.id AND ct.tag = ?)');
        params.push(query.tag);
    }

    if (filters.contentType !== undefined) {
        clauses.push('c.content_type = ?');
        params.push(filters.contentType);
    }
    if (filters.scope !== undefined) {
        clauses.push('c.scope = ?');
        params.push(filters.scope);
    }
    if (filters.scopeTarget === null) {
        // `= NULL` is never true; an explicit null (org-wide rows) needs IS NULL.
        clauses.push('c.scope_target IS NULL');
    } else if (filters.scopeTarget !== undefined) {
        clauses.push('c.scope_target = ?');
        params.push(filters.scopeTarget);
    }
    if (filters.state !== undefined) {
        clauses.push('c.state = ?');
        params.push(filters.state);
    }
    if (filters.authorId !== undefined) {
        clauses.push('c.author_id = ?');
        params.push(filters.authorId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Weight title above body above tags so a title hit outranks a passing mention.
    // bm25's weights are POSITIONAL over ALL declared columns, including the leading
    // UNINDEXED `contribution_id` — so the first weight (0.0) is the inert id column
    // and the real weights are title=10, body=4, tags=2. (Omitting the id weight
    // would silently shift every weight one column left, leaving tags at the default
    // 1.0 — the off-by-one this 0.0 prefix prevents.) bm25 is lower-is-better, so
    // ascending order is most-relevant-first.
    const BM25 = 'bm25(contribution_search, 0.0, 10.0, 4.0, 2.0)';
    const orderBy =
        match !== null
            ? `ORDER BY ${BM25} ASC, c.created_at DESC, c.id DESC`
            : 'ORDER BY c.created_at DESC, c.id DESC';
    const scoreSelect = match !== null ? `${BM25} AS __score` : '0 AS __score';

    const sql = `SELECT c.*, ${scoreSelect} FROM contributions c ${joins.join(' ')} ${where} ${orderBy}`;
    const rows = db.prepare(sql).all(...params) as (ContributionRow & {__score: number})[];

    // Enforce viewer scope with the SAME 6.1.4 tail the browse surfaces use, so the
    // visibility rule lives in exactly one place (resolveVisibleForViewer) and can
    // never diverge between search and browse.
    const results: ContributionSearchResult[] = resolveVisibleForViewer(
        db,
        rows.map((row) => ({...rowToContribution(row), __score: row.__score})),
        query.viewerTeam,
        query.hidesPermitted ?? true,
    ).map((row) => {
        const {__score, ...contribution} = row;
        return {contribution, score: __score};
    });

    return query.limit !== undefined ? results.slice(0, query.limit) : results;
}
