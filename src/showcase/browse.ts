/**
 * Showcase browse/discovery service — the consumption surface for Epic 6.3
 * (Task 6.3.9 / #172), the showcase analogue of the best-practice browse (6.2.8).
 *
 * This is the other half of Epic 6.3: the earlier children BUILD a showcase unit
 * (schema, dual publish paths, inline annotations, curators' note, scrubber,
 * mandatory review, AI annotation, cross-link); this task lets the org CONSUME and
 * GOVERN it. Like 6.2.8 it adds no parallel content stack — it COMPOSES the shared
 * primitives already built:
 *
 *   1. SEARCH + SCOPE (6.1.5 / 6.1.4). The candidate set is the PUBLISHED showcases
 *      the viewer may see, produced by {@link searchContributions} with a
 *      `showcase_example` + `published` filter and the viewer's team. Free-text
 *      search and the tag/team/scope filters all flow through that one primitive, so
 *      scope enforcement (and per-team hides) lives in exactly one place and a browse
 *      can never surface a showcase the viewer could not otherwise see.
 *   2. THE ASSEMBLED UNIT (6.3.3 / 6.3.4 / 6.3.7). The detail view reuses the
 *      canonical {@link assembleCuratedUnit} for the curators' note + outcome header,
 *      the inline-annotated conversation body, and the clearly-AI secondary
 *      annotation — one source of truth for the unit's shape, no re-derivation here.
 *   3. CROSS-LINKS (6.3.8). The "demonstrates" practices come from the canonical
 *      two-way, scope-respecting {@link listPracticesForShowcase}; an out-of-scope or
 *      unpublished linked practice is never exposed through the link.
 *
 * Privacy posture — the defining property of this surface:
 *   * NO PATH BACK TO PRIVATE CAPTURES. Every read here is over the contribution
 *     spine + showcase companion tables (already-published, developer-consented,
 *     redacted content). Nothing in this module reads `prompt_captures` or any
 *     private session; there is structurally no route from the gallery or the detail
 *     view back into anyone's private captures.
 *   * SCOPE IS THE LAST WORD. Both the list and the single-item detail run their
 *     candidates through the same 6.1.4 scope tail, so a team-scoped showcase in
 *     another team is a uniform 404 — indistinguishable from a missing one.
 */

import type Database from 'better-sqlite3';
import {searchContributions} from '../contributions/search';
import {resolveVisibleForViewer} from '../contributions/scope';
import {getContribution} from '../contributions/store';
import type {Contribution, ContributionScope, ContributionState} from '../contributions/types';
import {getDeveloperById} from '../registry/developers';
import {renderAiAnnotation, type RenderedAiAnnotation} from './aiAnnotation';
import {assembleCuratedUnit} from './curation';
import {listPracticesForShowcase} from './crossLink';
import type {InlineDisplay} from './annotations';
import {getShowcaseUnit} from './unitsStore';
import {SHOWCASE_CONTENT_TYPE, type PublishPath} from './unitsTypes';

/** Filters a viewer can apply to the gallery. Every field is optional; combine with AND. */
export interface ShowcaseBrowseFilters {
    /** Free text matched against title/body/tags (6.1.5). Blank/omitted lists everything visible. */
    text?: string;
    /** Require this exact tag. Combines (AND) with the others. */
    tag?: string;
    /**
     * The "team" filter: a team name narrows to that team's team-scoped showcases.
     * Maps to the spine's `scope_target`; it can only NARROW within the viewer's
     * scope, never widen it (the scope tail still runs, so a foreign team resolves to
     * an empty set rather than a leak).
     */
    team?: string;
    /** The "scope" filter: `org` or `team`. */
    scope?: ContributionScope;
    /** Cap the number of results (applied after scope resolution). Omit for no cap. */
    limit?: number;
}

/** One card in the gallery — the showcase plus the at-a-glance signals. */
export interface BrowseShowcaseSummary {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    authorId: string;
    /** The author's display name, or null when the author record is gone. */
    authorName: string | null;
    /** Which path published it (self-publish vs joint curation), for a provenance marker. */
    publishPath: PublishPath | null;
    /** Whether a usable outcome link is present — drives an "has outcome" affordance without the link itself. */
    hasOutcomeLink: boolean;
    /** How many inline developer annotations the unit carries (the teaching layer's heft). */
    annotationCount: number;
    createdAt: string;
    updatedAt: string;
}

/** A best practice this showcase demonstrates ("demonstrates", 6.3.8). */
export interface ShowcaseCrossLink {
    id: string;
    title: string;
}

/** The viewer-facing detail of one showcase unit — every component the issue lists. */
export interface BrowseShowcaseDetail {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    state: ContributionState;
    authorId: string;
    authorName: string | null;
    publishPath: PublishPath | null;
    createdAt: string;
    updatedAt: string;
    /** The MANDATORY curators' note ("what to take away"), rendered prominently. */
    curatorsNote: string;
    /** The outcome link (PR/commit/goal), or null when none was captured. */
    outcomeLink: string | null;
    hasOutcomeLink: boolean;
    /** The annotated conversation body (turns + inline annotations), from the canonical assembler. */
    display: InlineDisplay;
    /** The optional, clearly-AI, SECONDARY prompt-technique annotation (6.3.7). */
    aiAnnotation: RenderedAiAnnotation;
    /** Best practices this showcase demonstrates, scope-filtered (6.3.8). Empty when none. */
    practices: ShowcaseCrossLink[];
    /**
     * True only when the viewer authored this showcase — gates the owner-unpublish
     * affordance. The governance service still enforces the real boundary server-side.
     */
    canUnpublish: boolean;
}

/**
 * Resolve an author's display name once per id, memoised across a single response so a
 * gallery of N showcases by the same author hits the registry once, not N times.
 */
function makeAuthorNameResolver(db: Database.Database): (authorId: string) => string | null {
    const cache = new Map<string, string | null>();
    return (authorId: string): string | null => {
        const cached = cache.get(authorId);
        if (cached !== undefined) {
            return cached;
        }
        const name = getDeveloperById(db, authorId)?.name ?? null;
        cache.set(authorId, name);
        return name;
    };
}

/** Whether a value is a present, non-blank string (the outcome-link "filled in" test). */
function hasText(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

/**
 * Total inline annotations on a unit — those anchored to a turn PLUS any orphaned
 * (drifted) ones, so the gallery's count never under-reports the teaching layer. 0
 * when the id is not a showcase.
 */
function annotationCount(db: Database.Database, contributionId: string): number {
    const display = assembleCuratedUnit(db, contributionId)?.display;
    if (!display) {
        return 0;
    }
    const anchored = display.turns.reduce((sum, turn) => sum + turn.annotations.length, 0);
    return anchored + display.orphaned.length;
}

/**
 * The published showcases the viewer may see that match the filters, ranked by text
 * relevance when a query is present else newest-first. Pure composition over 6.1.5
 * search: the `showcase_example` + `published` filter scopes it to this surface, the
 * viewer's team enforces scope, and the free-text/tag/team/scope filters narrow within.
 */
export function browseShowcases(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    filters: ShowcaseBrowseFilters = {},
): BrowseShowcaseSummary[] {
    const hits = searchContributions(db, {
        text: filters.text,
        tag: filters.tag,
        filters: {
            contentType: SHOWCASE_CONTENT_TYPE,
            state: 'published',
            scope: filters.scope,
            // `team` selects team-scoped rows for that team; left undefined it does not filter.
            scopeTarget: filters.team,
        },
        viewerTeam,
        // Bound the discovery surface; the cap is applied AFTER scope resolution by the
        // search primitive, so a capped page is never silently shrunk by out-of-scope rows.
        limit: filters.limit,
    });

    const authorName = makeAuthorNameResolver(db);
    return hits.map(({contribution}) => {
        // The unit is the showcase's companion payload; a published showcase always has
        // one, but default defensively so a divergent row degrades rather than throws.
        const unit = getShowcaseUnit(db, contribution.id);
        return {
            id: contribution.id,
            title: contribution.title,
            scope: contribution.scope,
            scopeTarget: contribution.scopeTarget,
            authorId: contribution.authorId,
            authorName: authorName(contribution.authorId),
            publishPath: unit?.publishPath ?? null,
            hasOutcomeLink: hasText(unit?.outcomeLink),
            annotationCount: annotationCount(db, contribution.id),
            createdAt: contribution.createdAt,
            updatedAt: contribution.updatedAt,
        };
    });
}

/**
 * Load a published showcase the viewer may see, or undefined. The single home for this
 * surface's visibility rule: it returns undefined (→ 404) for a missing id, a
 * non-showcase, a non-published showcase, AND a showcase outside the viewer's scope —
 * the same uniform "you cannot see this" so the response never reveals which it was.
 *
 * A point read: fetch the one contribution, reject it on content-type/lifecycle, then
 * run THAT single row through {@link resolveVisibleForViewer} — the exact 6.1.4 scope
 * tail the gallery uses (incl. per-team hides), at O(1) rather than a full scan.
 */
function loadVisibleShowcase(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    id: string,
): Contribution | undefined {
    const contribution = getContribution(db, id);
    if (
        !contribution ||
        contribution.contentType !== SHOWCASE_CONTENT_TYPE ||
        contribution.state !== 'published'
    ) {
        return undefined;
    }
    const [visible] = resolveVisibleForViewer(db, [contribution], viewerTeam);
    return visible;
}

/**
 * The viewer-facing detail of one published showcase: the prominent curators' note +
 * outcome, the inline-annotated conversation, the clearly-AI secondary annotation, and
 * the cross-linked practices — every unit component the 6.3.9 detail view lists.
 * Returns undefined when the showcase is not visible to the viewer (missing / not a
 * showcase / not published / out of scope), so the route can 404 uniformly.
 */
export function getShowcaseDetail(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    developerId: string,
    id: string,
): BrowseShowcaseDetail | undefined {
    const contribution = loadVisibleShowcase(db, viewerTeam, id);
    if (!contribution) {
        return undefined;
    }
    const curated = assembleCuratedUnit(db, id);
    if (!curated) {
        // A visible spine row with no showcase unit is a corruption, not a normal 404;
        // surface it as not-found rather than a partial detail.
        return undefined;
    }
    const unit = getShowcaseUnit(db, id);
    return {
        id: contribution.id,
        title: contribution.title,
        scope: contribution.scope,
        scopeTarget: contribution.scopeTarget,
        state: contribution.state,
        authorId: contribution.authorId,
        authorName: getDeveloperById(db, contribution.authorId)?.name ?? null,
        publishPath: unit?.publishPath ?? null,
        createdAt: contribution.createdAt,
        updatedAt: contribution.updatedAt,
        curatorsNote: curated.curatorsNote,
        outcomeLink: curated.outcomeLink,
        hasOutcomeLink: curated.hasOutcomeLink,
        display: curated.display,
        aiAnnotation: renderAiAnnotation(unit?.aiAnnotation ?? null),
        practices: listPracticesForShowcase(db, id, viewerTeam).map((p) => ({id: p.id, title: p.title})),
        // The owner-unpublish affordance shows only to the author; the governance
        // service re-checks authorship, so this is presentation only.
        canUnpublish: contribution.authorId === developerId,
    };
}

/**
 * Whether `id` is a published showcase the viewer may see — the visibility gate any
 * viewer-scoped action shares with the detail view, so an action can only ever touch a
 * showcase the viewer can actually read.
 */
export function isShowcaseVisibleToViewer(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    id: string,
): boolean {
    return loadVisibleShowcase(db, viewerTeam, id) !== undefined;
}
