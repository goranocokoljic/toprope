/**
 * Showcase governance service for the Epic 6.3 unit model (Task 6.3.9 / #172) —
 * the removal/unpublish authority that CARRIES THE PHASE 5 RULE forward onto the
 * shared contribution spine.
 *
 * The one invariant this module exists to make structural: governance can REMOVE or
 * (for the owner) UNPUBLISH, but it can NEVER publish on a developer's behalf. There
 * are exactly two verbs here — owner-unpublish and lead-remove — and NEITHER creates
 * or alters a showcase's content. Publishing lives solely in the dual-path publish
 * flow (6.3.2), which requires the developer's own recorded approval; nothing in this
 * manager-facing path can mint that approval or reach into `prompt_captures`.
 *
 * Two governance actions, mirroring the Phase 5 standalone governance (src/showcase/
 * governance.ts) but expressed over the spine's lifecycle + audit trail so there is no
 * second store and no second source of truth:
 *
 *   * OWNER UNPUBLISH. The author removes their OWN showcase from the gallery
 *     (published → unpublished). Author-scoped and guarded on the showcase being
 *     currently published, so a non-owner, a missing id, or one a lead already removed
 *     is rejected with a typed code the route maps to a status — an owner can never
 *     resurrect a removed showcase by unpublishing it.
 *
 *   * LEAD REMOVE. A team lead removes a showcase from their team's gallery
 *     (published/unpublished → removed). SCOPED to a named team, not gated by a
 *     per-team-lead identity (GovProxy's role model is binary admin|developer, as the
 *     Phase 5 governance notes): `team` bounds WHICH showcases may be touched (the
 *     showcase must belong to that team's gallery), not WHO may moderate. The removal
 *     is LOGGED in the contribution audit trail (the `removed` event), atomically with
 *     the status flip, and the author is NOTIFIED by reading that same trail back
 *     ({@link listShowcaseRemovalsForAuthor}) — so a removal can never be silent.
 *
 * A showcase belongs to team T's gallery when it is team-scoped to T, OR its author is
 * currently on team T (T's contribution to the org-wide gallery) — the same boundary
 * the Phase 5 `isExampleInTeamShowcase` draws.
 */

import type Database from 'better-sqlite3';
import {getContribution, listContributions, listReviewEvents} from '../contributions/store';
import {remove as smRemove, unpublish as smUnpublish} from '../contributions/stateMachine';
import type {Contribution} from '../contributions/types';
import {getDeveloperById} from '../registry/developers';
import {SHOWCASE_CONTENT_TYPE} from './unitsTypes';

/** Stable error codes the route maps to HTTP statuses without string-matching messages. */
export type UnitGovernanceErrorCode =
    | 'not_found'
    | 'not_a_showcase'
    | 'not_author'
    | 'not_published'
    | 'not_removable'
    | 'not_team_showcase';

/** A typed failure from the governance flow, carrying a code the route can switch on. */
export class UnitGovernanceError extends Error {
    constructor(
        readonly code: UnitGovernanceErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'UnitGovernanceError';
    }
}

/**
 * Fetch a contribution and assert it exists and is a showcase. Returns the row so
 * callers don't re-read. Throws `not_found` / `not_a_showcase` so a typo'd or
 * wrong-kind id is rejected at the trust boundary rather than acting on a non-showcase.
 */
function requireShowcase(db: Database.Database, id: string): Contribution {
    const contribution = getContribution(db, id);
    if (!contribution) {
        throw new UnitGovernanceError('not_found', `Showcase '${id}' not found.`);
    }
    if (contribution.contentType !== SHOWCASE_CONTENT_TYPE) {
        throw new UnitGovernanceError('not_a_showcase', `Contribution '${id}' is not a showcase.`);
    }
    return contribution;
}

/** Fields needed to unpublish one's own showcase. */
export interface UnpublishOwnInput {
    showcaseId: string;
    /** The acting developer — must be the showcase's author. */
    developerId: string;
    /** Optional human note recorded on the audit event. */
    reason?: string | null;
}

/**
 * Owner unpublish: the author removes their OWN showcase from the gallery
 * (published → unpublished), recording an `unpublished` audit event via the spine
 * state machine. Validates, in order: the id is a showcase (`not_found` /
 * `not_a_showcase`), the actor is its author (`not_author`), and it is currently
 * published (`not_published`) — so a non-owner is refused before any state read leaks,
 * and an already-removed/unpublished showcase cannot be resurrected. Returns the
 * updated contribution.
 */
export function unpublishOwnShowcase(db: Database.Database, input: UnpublishOwnInput): Contribution {
    const contribution = requireShowcase(db, input.showcaseId);
    // Authorship before lifecycle: a non-owner learns only that it isn't theirs to
    // unpublish, never its current state.
    if (contribution.authorId !== input.developerId) {
        throw new UnitGovernanceError(
            'not_author',
            'Only the showcase author can unpublish their own showcase.',
        );
    }
    if (contribution.state !== 'published') {
        throw new UnitGovernanceError(
            'not_published',
            `Showcase is already ${contribution.state}; nothing to unpublish.`,
        );
    }
    return smUnpublish(db, {
        contributionId: input.showcaseId,
        actorId: input.developerId,
        note: input.reason ?? null,
    });
}

/**
 * Whether a showcase belongs to team `team`'s gallery — the boundary a lead removal
 * scoped to that team may touch. True when the showcase is team-scoped to that team,
 * or when its author is currently on that team (so the team owns its org-wide
 * contribution too). The same rule the Phase 5 `isExampleInTeamShowcase` draws.
 */
export function isShowcaseInTeam(db: Database.Database, contribution: Contribution, team: string): boolean {
    if (contribution.scope === 'team' && contribution.scopeTarget === team) {
        return true;
    }
    return getDeveloperById(db, contribution.authorId)?.team === team;
}

/** Fields needed to remove a showcase from a team's gallery as a lead. */
export interface RemoveShowcaseInput {
    showcaseId: string;
    /** The team whose gallery the lead is acting for — bounds which showcases may be touched. */
    team: string;
    /** The acting lead, from their session — recorded so the action is never anonymous. */
    removedByUserId: string;
    /** Optional reason shown to the author in their removal feed. */
    reason?: string | null;
}

/**
 * Lead remove: remove a showcase from a team's gallery (published/unpublished →
 * removed), recording a `removed` audit event via the spine state machine. Validates,
 * in order: the id is a showcase (`not_found` / `not_a_showcase`), it is within the
 * lead's team (`not_team_showcase` — a lead outside the showcase's team learns only
 * that it isn't theirs to remove), and it is in a removable lifecycle state
 * (`not_removable` — `removed` is terminal, a draft/submitted showcase was never in a
 * gallery). The state flip and its audit row commit together inside the state machine's
 * transaction, so the trail is inseparable from the action. Returns the now-removed
 * contribution.
 */
export function removeShowcaseAsLead(db: Database.Database, input: RemoveShowcaseInput): Contribution {
    const contribution = requireShowcase(db, input.showcaseId);
    // Authorization before lifecycle, exactly as Phase 5: scope the action to the team
    // first, so a lead never learns the state of a showcase outside their gallery.
    if (!isShowcaseInTeam(db, contribution, input.team)) {
        throw new UnitGovernanceError(
            'not_team_showcase',
            `This showcase is not part of team '${input.team}' gallery; a lead can only remove their own team's showcases.`,
        );
    }
    // Only a published or unpublished showcase is in (or recently in) the gallery and
    // thus removable; draft/submitted were never published, and `removed` is terminal.
    if (contribution.state !== 'published' && contribution.state !== 'unpublished') {
        throw new UnitGovernanceError(
            'not_removable',
            `Showcase is ${contribution.state}; only a published or unpublished showcase can be removed.`,
        );
    }
    // The note encodes the reason; the actor is the lead's user id, so the `removed`
    // event names who removed it. The author reads both back via the removal feed.
    return smRemove(db, {
        contributionId: input.showcaseId,
        actorId: input.removedByUserId,
        note: input.reason ?? null,
    });
}

/**
 * One removal notice in an author's feed — how "the author is notified" is delivered:
 * the same `removed` audit row the trail keeps, read back by the author, so a lead
 * removal can never be silent.
 */
export interface ShowcaseRemovalNotice {
    showcaseId: string;
    title: string;
    /** The acting lead's user id, from the `removed` event's actor. */
    removedBy: string;
    /** The reason the lead gave, or null when none. */
    reason: string | null;
    /** UTC ISO timestamp of the removal. */
    occurredAt: string;
}

/**
 * The author's removal-notification feed: every lead removal of one of THEIR showcases,
 * newest first. Derived from the canonical audit trail rather than a parallel
 * notification table — for each of the author's showcases now in `removed` state, the
 * most recent `removed` event supplies who removed it, why, and when. Author-scoped:
 * `developerId` selects only that author's showcases, so it can never read another
 * developer's removals.
 */
export function listShowcaseRemovalsForAuthor(db: Database.Database, developerId: string): ShowcaseRemovalNotice[] {
    const removed = listContributions(db, {
        contentType: SHOWCASE_CONTENT_TYPE,
        authorId: developerId,
        state: 'removed',
    });
    const notices: ShowcaseRemovalNotice[] = [];
    for (const contribution of removed) {
        // The audit trail is oldest-first; the LAST `removed` event is the live removal
        // (the lifecycle graph has no path back out of `removed`, so there is one, but
        // taking the last is robust to any future re-entry).
        const events = listReviewEvents(db, contribution.id);
        let last: {actorId: string; note: string | null; occurredAt: string} | undefined;
        for (const e of events) {
            if (e.event === 'removed') {
                last = {actorId: e.actorId, note: e.note, occurredAt: e.occurredAt};
            }
        }
        if (last) {
            notices.push({
                showcaseId: contribution.id,
                title: contribution.title,
                removedBy: last.actorId,
                reason: last.note,
                occurredAt: last.occurredAt,
            });
        }
    }
    // Newest first, ties broken by id for a total, deterministic order.
    return notices.sort((a, b) => {
        if (a.occurredAt !== b.occurredAt) {
            return a.occurredAt < b.occurredAt ? 1 : -1;
        }
        return a.showcaseId < b.showcaseId ? -1 : a.showcaseId > b.showcaseId ? 1 : 0;
    });
}
