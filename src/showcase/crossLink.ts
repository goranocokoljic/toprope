/**
 * Showcase <-> best-practice cross-link service (Task 6.3.8 / #171).
 *
 * A showcase and a best practice are both `contributions` rows (distinguished by
 * `content_type`), so a "this showcase demonstrates that practice" link is just a
 * row in `showcase_practice_links` joining the two spine ids (6.3.1 / #164). The
 * `unitsStore` already owns that table's raw CRUD; this module is the service on top
 * that the surfaces call, and it adds the two things the raw store deliberately does
 * not:
 *
 *   1. VALIDATED LINK CREATION. Before writing a link, both ends are fetched and
 *      asserted to exist, to be the EXPECTED content type (the showcase end must be a
 *      `showcase_example`, the practice end a `best_practice` — so a link can never be
 *      formed backwards or between two of the same kind), and to be live (not
 *      `removed`). A bad id therefore yields a typed `CrossLinkError` the caller maps
 *      to an HTTP status, never a silent no-op row or a raw FK error. This is the
 *      6.1/6.3 "validate entity existence + lifecycle state before a write" rule.
 *
 *   2. TWO-WAY, SCOPE-RESPECTING SURFACING. `listPracticesForShowcase` /
 *      `listShowcasesForPractice` resolve the link in BOTH directions and return only
 *      the linked items the viewer may actually see: published, of the expected type,
 *      and within the viewer's scope (org-wide, or team-scoped to the viewer's team,
 *      minus per-team hides). The scope filter reuses the ONE canonical resolver
 *      (`resolveVisibleForViewer`, 6.1.4) rather than re-deriving visibility, so an
 *      out-of-scope linked item is never exposed through the cross-link — the link is
 *      not a side channel around scope.
 *
 * Privacy posture: this module reads and links already-stored contributions. It
 * neither publishes nor relaxes any consent/scope rule; surfacing is strictly a
 * subset of what the viewer could already see on the browse surface.
 */

import type Database from 'better-sqlite3';
import {getContribution} from '../contributions/store';
import {resolveVisibleForViewer} from '../contributions/scope';
import type {Contribution} from '../contributions/types';
import {linkPractice, listLinkedPractices, listLinkingShowcases, unlinkPractice} from './unitsStore';
import {SHOWCASE_CONTENT_TYPE} from './unitsTypes';

/** The practice end's spine `content_type` (the showcase end reuses the canonical {@link SHOWCASE_CONTENT_TYPE}). */
const PRACTICE_CONTENT_TYPE = 'best_practice';

/** Stable error codes the route/service maps to HTTP statuses without matching message text. */
export type CrossLinkErrorCode =
    | 'showcase_not_found'
    | 'practice_not_found'
    | 'not_a_showcase'
    | 'not_a_practice'
    | 'removed';

/** A typed failure from the cross-link service, carrying a code the caller can switch on. */
export class CrossLinkError extends Error {
    constructor(
        readonly code: CrossLinkErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'CrossLinkError';
    }
}

/**
 * Fetch a contribution and assert it exists, is the expected content type, and is
 * live (not `removed`). Returns the row so callers don't re-read. Throws a typed
 * `CrossLinkError` — the `*_not_found` / `not_a_*` code distinguishes which end and
 * why — so a typo'd or wrong-kind id is rejected at the trust boundary rather than
 * writing a link row that points at nothing meaningful.
 */
function requireLinkable(
    db: Database.Database,
    id: string,
    expected: typeof SHOWCASE_CONTENT_TYPE | typeof PRACTICE_CONTENT_TYPE,
): Contribution {
    const isShowcase = expected === SHOWCASE_CONTENT_TYPE;
    const contribution = getContribution(db, id);
    if (!contribution) {
        throw new CrossLinkError(
            isShowcase ? 'showcase_not_found' : 'practice_not_found',
            `${isShowcase ? 'Showcase' : 'Practice'} '${id}' not found.`,
        );
    }
    if (contribution.contentType !== expected) {
        throw new CrossLinkError(
            isShowcase ? 'not_a_showcase' : 'not_a_practice',
            `Contribution '${id}' is not a ${isShowcase ? 'showcase' : 'best practice'}.`,
        );
    }
    if (contribution.state === 'removed') {
        throw new CrossLinkError('removed', `Contribution '${id}' has been removed and cannot be linked.`);
    }
    return contribution;
}

/**
 * Link a showcase to a best practice. Validates BOTH ends first (existence, content
 * type, not removed) so a link is always between a real, live showcase and a real,
 * live practice — never backwards, never same-kind, never dangling. Idempotent at the
 * store layer: re-linking the same pair is a no-op. Returns true when a NEW link row
 * was created, false when the pair was already linked.
 *
 * Throws `CrossLinkError` (`showcase_not_found` / `practice_not_found` / `not_a_showcase`
 * / `not_a_practice` / `removed`) when an end fails validation — nothing is written.
 */
export function linkShowcaseToPractice(db: Database.Database, showcaseId: string, practiceId: string): boolean {
    requireLinkable(db, showcaseId, SHOWCASE_CONTENT_TYPE);
    requireLinkable(db, practiceId, PRACTICE_CONTENT_TYPE);
    return linkPractice(db, showcaseId, practiceId);
}

/**
 * Remove a showcase<->practice cross-link. Deliberately lenient: removing a link is a
 * pure restriction (it can only ever hide a surfaced item, never expose one), so it
 * does not re-validate the endpoints — a pair that isn't linked simply finds nothing
 * to remove. Returns true when a row was actually deleted, false otherwise.
 */
export function unlinkShowcaseFromPractice(db: Database.Database, showcaseId: string, practiceId: string): boolean {
    return unlinkPractice(db, showcaseId, practiceId);
}

/** Options shared by the two surfacing reads. */
export interface SurfaceOptions {
    /**
     * Whether per-team hides are currently honored — the resolved hide permission for
     * the viewer's team (see 6.1.4). Defaults to true; pass false to ignore stored
     * hides, exactly as the browse surface does.
     */
    hidesPermitted?: boolean;
}

/**
 * Total, deterministic surfacing order: newest first by `createdAt`, ties broken by
 * `id` ascending. `createdAt` is a UTC ISO string so lexical compare is chronological;
 * the `id` tiebreak makes the order total even for same-instant rows (no reliance on a
 * nondeterministic tiebreak).
 */
function bySurfaceOrder(a: Contribution, b: Contribution): number {
    if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Resolve a set of linked contribution ids into the rows a viewer may actually see:
 * fetch each, keep only those that still exist, are PUBLISHED, and carry the expected
 * content type, then apply the canonical viewer-scope filter. The order is total and
 * deterministic (see {@link bySurfaceOrder}). Shared by both directions so the
 * "what's exposed" rule lives in exactly one place.
 */
function resolveSurfaced(
    db: Database.Database,
    ids: readonly string[],
    expected: typeof SHOWCASE_CONTENT_TYPE | typeof PRACTICE_CONTENT_TYPE,
    viewerTeam: string | null | undefined,
    hidesPermitted: boolean,
): Contribution[] {
    const candidates: Contribution[] = [];
    for (const id of ids) {
        const c = getContribution(db, id);
        // Surface only live, published items of the expected kind. A linked item that
        // was removed/unpublished, or is somehow the wrong type, is not exposed.
        if (c && c.state === 'published' && c.contentType === expected) {
            candidates.push(c);
        }
    }
    const visible = resolveVisibleForViewer(db, candidates, viewerTeam, hidesPermitted);
    return visible.sort(bySurfaceOrder);
}

/**
 * The best practices a showcase demonstrates, as the viewer may see them — the
 * showcase-side surfacing ("demonstrates: <practice>"). Returns only published
 * practices within the viewer's scope; an out-of-scope or unpublished linked practice
 * is silently omitted, never exposed via the link.
 */
export function listPracticesForShowcase(
    db: Database.Database,
    showcaseId: string,
    viewerTeam: string | null | undefined,
    options: SurfaceOptions = {},
): Contribution[] {
    const ids = listLinkedPractices(db, showcaseId);
    return resolveSurfaced(db, ids, PRACTICE_CONTENT_TYPE, viewerTeam, options.hidesPermitted ?? true);
}

/**
 * The showcases that demonstrate a practice, as the viewer may see them — the
 * practice-side surfacing ("see it in action: <showcase>"). The reverse direction of
 * {@link listPracticesForShowcase}, with the same scope/published filtering, so the
 * link surfaces both ways but never exposes an out-of-scope showcase.
 */
export function listShowcasesForPractice(
    db: Database.Database,
    practiceId: string,
    viewerTeam: string | null | undefined,
    options: SurfaceOptions = {},
): Contribution[] {
    const ids = listLinkingShowcases(db, practiceId);
    return resolveSurfaced(db, ids, SHOWCASE_CONTENT_TYPE, viewerTeam, options.hidesPermitted ?? true);
}
