/**
 * Showcase governance service (Task 5.9 / #130) — the team-lead REMOVAL path.
 *
 * This module is the one home for the governance privacy contract:
 *
 *   * A team lead can REMOVE an example from THEIR team's showcase, but the verbs
 *     stop there. There is no promote, no publish, no edit here and no caller that
 *     reaches into prompt_captures — removal only flips a published example to
 *     `removed` and records that it happened. The "a lead can never publish on a
 *     developer's behalf" guarantee is structural: publishing lives solely under
 *     /api/me keyed off the developer's OWN session + retrospective, and nothing in
 *     this manager-facing path can create or alter a showcase example's content.
 *
 *   * "Their team's showcase" is enforced, not assumed. An example belongs to team
 *     T's showcase when it is team-scoped to T, OR its author is currently on team
 *     T (T's contribution to the org-wide showcase). A lead acting for T cannot
 *     remove another team's team-scoped example.
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
 * Whether an example belongs to team `team`'s showcase — the boundary of a lead's
 * removal authority. True when the example is team-scoped to that team, or when
 * its author is currently on that team (so the team owns its org-wide
 * contribution too). Exported so the moderation LIST can show a lead exactly the
 * examples they could act on, using the same rule the removal enforces.
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
        // Re-check the transition inside the txn: markExampleRemoved only changes a
        // still-published row, so a concurrent unpublish/remove can't double-log.
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
