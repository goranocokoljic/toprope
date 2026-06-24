/**
 * Best-practice browse/discovery service — the non-contextual discovery path
 * (Task 6.2.8 / #163).
 *
 * Where 6.2.7 surfaces a practice NEXT TO a metric, this is the other half of the
 * library: a browsable, searchable list of best practices and a per-practice detail
 * view. Like everything in Epic 6.2 it adds no new tables and no parallel content
 * stack — it COMPOSES the primitives the earlier tasks already built:
 *
 *   1. SEARCH + SCOPE (6.1.5 / 6.1.4). The candidate set is the PUBLISHED best
 *      practices the viewer may see, produced by {@link searchContributions} with a
 *      `best_practice` + `published` filter and the viewer's team. Free-text search
 *      and the tag/team/scope filters all flow through that one primitive, so scope
 *      enforcement (and per-team hides) lives in exactly one place and a browse can
 *      never surface a practice the viewer could not otherwise see.
 *   2. RICH CONTENT (6.2.3). The detail view renders the current version through the
 *      authoring engine ({@link getPracticeView}), so the HTML it returns is the same
 *      sanitized output the editor previews — safe to inject into a viewer's page.
 *   3. FEEDBACK + RANKING SIGNALS (6.2.4). Each summary carries the practice's
 *      helpful/not-helpful counts and confidence-adjusted ratio, and the detail view
 *      adds the VIEWER'S own current signal so the feedback affordance can render its
 *      toggle state. Endorsement (6.2.2 hybrid) rides along for an "endorsed" marker.
 *   4. CONTRIBUTION MODEL (6.2.2). The detail view resolves the viewer-team's active
 *      contribution model so the create/edit entry points can explain what publishing
 *      means for that team, and exposes `canEdit` (author-only) so the UI shows the
 *      edit affordance solely to the owner — the authoring routes still enforce the
 *      real boundary server-side.
 *
 * Cross-link to a showcase (6.3.8) is rendered "when present": this module exposes the
 * `showcases` slot on the detail view via {@link linkedShowcasesForPractice}, which is
 * the seam Task 6.3.8 fills once the `showcase_practice_links` table and its two-way
 * scope rules exist. Until then it is an empty list, so the affordance simply renders
 * nothing — never a broken link.
 */

import type Database from 'better-sqlite3';
import {searchContributions} from '../contributions/search';
import {resolveVisibleForViewer} from '../contributions/scope';
import {getContribution, getContributionTags} from '../contributions/store';
import {getVersionHistory} from '../contributions/versioning';
import type {Contribution, ContributionScope, ContributionState} from '../contributions/types';
import {getDeveloperById} from '../registry/developers';
import {PRACTICE_CONTENT_TYPE, getPracticeView} from './authoring';
import {resolveContributionModel, type ContributionModel} from './contributionModel';
import {helpfulRatio} from './feedback';
import {getFeedback, getFeedbackCounts, getPracticeDetails} from './store';
import {isPracticeMetric} from './metrics';
import type {FeedbackSignal} from './types';

/** Filters a viewer can apply to the browse list. Every field is optional; combine with AND. */
export interface PracticeBrowseFilters {
    /** Free text matched against title/body/tags (6.1.5). Blank/omitted lists everything visible. */
    text?: string;
    /** Require this exact tag — a metric tag (e.g. `churn`) drives the "filter by tag" affordance. */
    tag?: string;
    /**
     * The "team" filter: a team name narrows to that team's team-scoped practices.
     * Maps to the spine's `scope_target`; it can only NARROW within the viewer's scope,
     * never widen it (the scope tail still runs, so a foreign team resolves to an empty
     * set rather than a leak).
     */
    team?: string;
    /** The "scope" filter: `org` or `team`. */
    scope?: ContributionScope;
    /** Cap the number of results (applied after scope resolution). Omit for no cap. */
    limit?: number;
}

/** A practice's feedback signals, summarised for display. */
export interface PracticeFeedbackSummary {
    helpful: number;
    notHelpful: number;
    /** Raw helpful-ratio in [0,1] for a "found helpful" hint, or null when there is no feedback. */
    helpfulRatio: number | null;
}

/** One row in the browse list — the practice plus the signals that rank/mark it. */
export interface BrowsePracticeSummary {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    authorId: string;
    /** The author's display name, or null when the author record is gone. */
    authorName: string | null;
    currentVersion: number;
    createdAt: string;
    updatedAt: string;
    /** The metric tags attached to the practice (its auto-surfacing metrics), sorted. */
    metrics: string[];
    /** Lead-endorsement flag (hybrid model) — lets the list show an "endorsed" marker. */
    endorsed: boolean;
    feedback: PracticeFeedbackSummary;
}

/** A showcase cross-linked to a practice ("see it in action"). Populated by 6.3.8. */
export interface ShowcaseCrossLink {
    id: string;
    title: string;
}

/** The detail view of a single practice for a viewer. */
export interface BrowsePracticeDetail {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    state: ContributionState;
    authorId: string;
    authorName: string | null;
    currentVersion: number;
    createdAt: string;
    updatedAt: string;
    /** Sanitized HTML of the current version, safe to inject. */
    html: string;
    /** Metric tags referenced by the current body, sorted. */
    metrics: string[];
    /** Feedback counts + the VIEWER's own current signal, so the affordance renders its toggle state. */
    feedback: PracticeFeedbackSummary & {viewerSignal: FeedbackSignal | null};
    endorsed: boolean;
    /** The viewer-team's active contribution model — drives the model-aware create/edit copy. */
    model: ContributionModel;
    /** True only when the viewer authored this practice — gates the edit affordance. */
    canEdit: boolean;
    /** Showcases that demonstrate this practice (6.3.8). Empty until that task is built. */
    showcases: ShowcaseCrossLink[];
}

/** One version in a practice's history, as the browse history view shows it (no body). */
export interface PracticeHistoryEntry {
    version: number;
    authorId: string;
    authorName: string | null;
    changeNote: string | null;
    createdAt: string;
}

/**
 * Resolve an author's display name once per id, memoised across a single response so a
 * list of N practices by the same author hits the registry once, not N times.
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

/** Only the metric-vocabulary tags, sorted — the free-form tags are not part of this surface. */
function metricTags(db: Database.Database, contributionId: string): string[] {
    return getContributionTags(db, contributionId)
        .filter(isPracticeMetric)
        .sort();
}

function feedbackSummary(db: Database.Database, contributionId: string): PracticeFeedbackSummary {
    const counts = getFeedbackCounts(db, contributionId);
    return {
        helpful: counts.helpful,
        notHelpful: counts.notHelpful,
        helpfulRatio: helpfulRatio(counts),
    };
}

/**
 * The published best practices the viewer may see that match the filters, newest-first
 * (or by text relevance when a query is present). Pure composition over 6.1.5 search:
 * the `best_practice` + `published` filter scopes it to this surface, the viewer's team
 * enforces scope, and the free-text/tag/team/scope filters narrow within that.
 */
export function browsePractices(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    filters: PracticeBrowseFilters = {},
): BrowsePracticeSummary[] {
    const hits = searchContributions(db, {
        text: filters.text,
        tag: filters.tag,
        filters: {
            contentType: PRACTICE_CONTENT_TYPE,
            state: 'published',
            scope: filters.scope,
            // `team` selects team-scoped rows for that team; left undefined it does not filter.
            scopeTarget: filters.team,
        },
        viewerTeam,
        // Bound the unbounded discovery surface: the cap is applied AFTER scope
        // resolution by the search primitive, so a capped page is never silently
        // shrunk by out-of-scope rows that were going to be dropped anyway.
        limit: filters.limit,
    });

    const authorName = makeAuthorNameResolver(db);
    return hits.map(({contribution}) => ({
        id: contribution.id,
        title: contribution.title,
        scope: contribution.scope,
        scopeTarget: contribution.scopeTarget,
        authorId: contribution.authorId,
        authorName: authorName(contribution.authorId),
        currentVersion: contribution.currentVersion,
        createdAt: contribution.createdAt,
        updatedAt: contribution.updatedAt,
        metrics: metricTags(db, contribution.id),
        endorsed: getPracticeDetails(db, contribution.id)?.endorsed ?? false,
        feedback: feedbackSummary(db, contribution.id),
    }));
}

/**
 * Load a published best practice the viewer may see, or undefined. The single home for
 * this surface's visibility rule: it returns undefined (→ 404) for a missing id, a
 * non-practice, a non-published practice, AND a practice outside the viewer's scope —
 * the same uniform "you cannot see this" the owner-scoped editor gives, so the response
 * never reveals which of those it was.
 *
 * A point read: fetch the one contribution, reject it on content-type/lifecycle, then
 * run THAT single row through {@link resolveVisibleForViewer} — the exact 6.1.4 scope
 * tail the list and surfacing use (incl. per-team hides), mirroring how
 * `surfacePractices` scope-checks a force-surfaced pin. So the visibility guarantee is
 * identical to the list while the cost is O(1), not a scan of every visible practice.
 */
function loadVisiblePractice(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    id: string,
): Contribution | undefined {
    const contribution = getContribution(db, id);
    if (
        !contribution ||
        contribution.contentType !== PRACTICE_CONTENT_TYPE ||
        contribution.state !== 'published'
    ) {
        return undefined;
    }
    const [visible] = resolveVisibleForViewer(db, [contribution], viewerTeam);
    return visible;
}

/**
 * Showcases cross-linked to a practice — the "see it in action" slot. SEAM for Task
 * 6.3.8: that task owns the `showcase_practice_links` table and the two-way scope
 * rules, and will implement the read here. Until then there are no links to read, so
 * this returns an empty list and the detail view's affordance renders nothing — never
 * a broken cross-link.
 */
export function linkedShowcasesForPractice(
    _db: Database.Database,
    _practiceId: string,
    _viewerTeam: string | null | undefined,
): ShowcaseCrossLink[] {
    return [];
}

/**
 * The viewer-facing detail of one published practice: rendered content, feedback (with
 * the viewer's own signal), endorsement, the active contribution model, the edit
 * affordance gate, and any showcase cross-links. Returns undefined when the practice is
 * not visible to the viewer (missing / not a practice / not published / out of scope),
 * so the route can 404 uniformly.
 */
export function getBrowsePracticeDetail(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    developerId: string,
    id: string,
): BrowsePracticeDetail | undefined {
    const contribution = loadVisiblePractice(db, viewerTeam, id);
    if (!contribution) {
        return undefined;
    }
    const view = getPracticeView(db, id);
    if (!view) {
        // A visible spine row with no renderable version is a corruption, not a normal
        // 404; surface it as not-found rather than a partial detail.
        return undefined;
    }
    const counts = getFeedbackCounts(db, id);
    const authorName = getDeveloperById(db, contribution.authorId)?.name ?? null;
    return {
        id: contribution.id,
        title: contribution.title,
        scope: contribution.scope,
        scopeTarget: contribution.scopeTarget,
        state: contribution.state,
        authorId: contribution.authorId,
        authorName,
        currentVersion: contribution.currentVersion,
        createdAt: contribution.createdAt,
        updatedAt: contribution.updatedAt,
        html: view.html,
        metrics: view.metrics,
        feedback: {
            helpful: counts.helpful,
            notHelpful: counts.notHelpful,
            helpfulRatio: helpfulRatio(counts),
            viewerSignal: getFeedback(db, id, developerId)?.signal ?? null,
        },
        endorsed: getPracticeDetails(db, id)?.endorsed ?? false,
        model: resolveContributionModel(db, viewerTeam),
        canEdit: contribution.authorId === developerId,
        showcases: linkedShowcasesForPractice(db, id, viewerTeam),
    };
}

/**
 * The version history of a published practice the viewer may see, oldest-first, as
 * lean metadata rows (no opaque body). Returns undefined when the practice is not
 * visible to the viewer, so the route 404s the same way the detail view does — history
 * is never exposed for a practice the viewer could not otherwise read.
 */
export function getBrowsePracticeHistory(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    id: string,
): PracticeHistoryEntry[] | undefined {
    if (!loadVisiblePractice(db, viewerTeam, id)) {
        return undefined;
    }
    const authorName = makeAuthorNameResolver(db);
    return getVersionHistory(db, id).map((v) => ({
        version: v.version,
        authorId: v.authorId,
        authorName: authorName(v.authorId),
        changeNote: v.changeNote,
        createdAt: v.createdAt,
    }));
}

/**
 * Whether `id` is a published practice the viewer may see — the visibility gate the
 * feedback route shares with the detail/history views, so a viewer can only leave
 * feedback on a practice they can actually read.
 */
export function isPracticeVisibleToViewer(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    id: string,
): boolean {
    return loadVisiblePractice(db, viewerTeam, id) !== undefined;
}
