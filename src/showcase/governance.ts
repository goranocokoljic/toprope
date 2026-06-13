/**
 * Showcase governance service (Task 5.9 / #130) — the team-lead REMOVAL path.
 *
 * This module is the one home for the governance privacy contract:
 *
 *   * Moderation can REMOVE an example from a team's showcase, but the verbs stop
 *     there. There is no promote, no publish, no edit here and no caller that
 *     reaches into prompt_captures — removal only flips a published example to
 *     `removed` and records that it happened. The "moderation can never publish on
 *     a developer's behalf" guarantee is structural: publishing lives solely under
 *     /api/me keyed off the developer's OWN session + retrospective, and nothing in
 *     this manager-facing path can create or alter a showcase example's content.
 *
 *   * The action is SCOPED to a named team, not gated by a per-team-lead identity.
 *     GovProxy's role model is binary (admin | developer) with no team-lead role,
 *     so `team` is the team whose showcase the removal is scoped to — it bounds
 *     WHICH examples may be touched, not WHO may moderate. An example belongs to
 *     team T's showcase when it is team-scoped to T, OR its author is currently on
 *     team T (T's contribution to the org-wide showcase); a removal scoped to T is
 *     refused for any other team's team-scoped example. (A future scoped team-lead
 *     role would add an actor-membership check on top; the recorded team is a scope
 *     label, not an authorization fact.)
 *
 *   * Every removal is LOGGED and the author NOTIFIED, atomically with the status
 *     flip — the transition and its audit/notification row commit together, so a
 *     removal can never happen without a trail the author can see.
 */

import type Database from 'better-sqlite3';
import {getDeveloperById} from '../registry/developers';
import {getShowcaseExampleById, insertShowcaseRemoval, markExampleRemoved} from './store';
import type {ShowcaseExample} from './types';

/** Stable error codes the route maps to HTTP statuses without string-matching messages. */
export type ShowcaseGovernanceErrorCode = 'example_not_found' | 'not_team_showcase' | 'not_published';

/** A typed failure from the governance flow, carrying a code the route can switch on. */
export class ShowcaseGovernanceError extends Error {
    constructor(
        readonly code: ShowcaseGovernanceErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ShowcaseGovernanceError';
    }
}

/**
 * Whether an example belongs to team `team`'s showcase — the boundary a removal
 * scoped to that team may touch. True when the example is team-scoped to that
 * team, or when its author is currently on that team (so the team owns its
 * org-wide contribution too). The moderation LIST scopes by the same rule, but in
 * SQL (see listPublishedExamples) to avoid a per-row lookup; this single-example
 * form is what the removal path checks.
 */
export function isExampleInTeamShowcase(db: Database.Database, example: ShowcaseExample, team: string): boolean {
    if (example.scope === 'team' && example.scopeTarget === team) {
        return true;
    }
    const author = getDeveloperById(db, example.authorDeveloperId);
    return author?.team === team;
}

export interface RemoveExampleInput {
    exampleId: string;
    /** The team whose showcase the lead is acting for — bounds their authority. */
    team: string;
    /** The acting team lead, from their session — recorded so the actor is never anonymous. */
    removedByUserId: string;
    removedByEmail: string;
    /** Optional reason shown to the author. */
    reason: string | null;
}

/** The result of a successful removal: the audit/notification id and the now-removed example. */
export interface RemoveExampleResult {
    removalId: string;
    example: ShowcaseExample;
}

/**
 * Remove an example from a team's showcase as a team lead. Validates existence,
 * that it is currently published, and that it is within the lead's team, THEN —
 * in a single transaction — flips the status to `removed` and writes the
 * audit/notification row, so the trail is inseparable from the action.
 */
export function removeExampleAsTeamLead(db: Database.Database, input: RemoveExampleInput): RemoveExampleResult {
    const example = getShowcaseExampleById(db, input.exampleId);
    if (!example) {
        throw new ShowcaseGovernanceError('example_not_found', 'Showcase example not found.');
    }
    // Authorization before state: a lead outside this example's team learns only
    // that it isn't theirs to remove, and an already-gone example is reported as
    // such rather than silently re-removed.
    if (!isExampleInTeamShowcase(db, example, input.team)) {
        throw new ShowcaseGovernanceError(
            'not_team_showcase',
            `This example is not part of team '${input.team}' showcase; a team lead can only remove their own team's examples.`,
        );
    }
    if (example.status !== 'published') {
        throw new ShowcaseGovernanceError('not_published', `Example is already ${example.status}; nothing to remove.`);
    }

    const occurredAt = new Date().toISOString();
    const removalId = db.transaction(() => {
        // The status flip and its audit/notification row commit together, so a
        // removal is never recorded without the transition (or vice versa).
        // markExampleRemoved only changes a still-published row, so the guard also
        // means the (re-read) status check above can't lead to a double-log.
        if (!markExampleRemoved(db, input.exampleId)) {
            throw new ShowcaseGovernanceError('not_published', 'Example is no longer published; nothing to remove.');
        }
        return insertShowcaseRemoval(db, {
            exampleId: input.exampleId,
            authorDeveloperId: example.authorDeveloperId,
            removedByUserId: input.removedByUserId,
            removedByEmail: input.removedByEmail,
            team: input.team,
            reason: input.reason,
            occurredAt,
        });
    })();

    return {removalId, example: {...example, status: 'removed'}};
}
