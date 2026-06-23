/**
 * Versioning primitive for the contribution spine (Task 6.1.3 / #153).
 *
 * The feature-agnostic engine for a contribution's LINEAR version history. It owns
 * the editing/history/revert semantics the spine store (6.1.1) deliberately leaves
 * as raw primitives, and nothing the state machine (6.1.2) owns:
 *
 *   * edit    — append a new version of the body; `current_version` advances to it.
 *   * history — every version retained, oldest → newest, nothing destroyed.
 *   * revert  — recreate a prior body as a NEW version (history is preserved, never
 *               rewritten); the lineage only ever grows.
 *   * current — the live version is what read paths serve by default.
 *
 * Linear only: there is no branching or merging (out of scope per the issue) — a
 * contribution has exactly one chain of versions and one `current_version` at its
 * head.
 *
 * Where the record lives: a version row (author, change_note, created_at, body) is
 * itself the append-only, immutable "who changed what, when" record for a content
 * edit — that is the design's version lineage (Phase 6 Design §3.2). It is distinct
 * from the contribution_review_events audit trail, which the state machine (6.1.2)
 * uses for LIFECYCLE/governance transitions (submitted/approved/published/…).
 * Editing or reverting does not change lifecycle state, so it is recorded in the
 * version lineage, not the review-event trail — keeping each record where it
 * belongs rather than duplicating an edit into both.
 *
 * Feature-agnostic: the `body` is an opaque JSON string this engine never
 * interprets, exactly as in the store. Nothing here knows what a best practice or a
 * showcase example is.
 *
 * Concurrency: like the store's version writer and the state machine, this assumes a
 * single writer. better-sqlite3 is synchronous and single-threaded, so within one
 * process nothing interleaves. A revert reads its target version (immutable once
 * written — versions are append-only) just before appending, so no wrapping
 * transaction is needed for it to be consistent; the append itself is atomic in the
 * store. Cross-process concurrent appends are out of scope (the store's
 * UNIQUE(contribution_id, version) turns a race into a retryable error, not
 * corruption).
 */

import type Database from 'better-sqlite3';
import {addContributionVersion, getContribution, getContributionVersion, getCurrentContributionVersion, listContributionVersions} from './store';
import type {ContributionVersion} from './types';

/** Stable error codes the caller (route/service) can switch on without matching message text. */
export type VersioningErrorCode = 'not_found' | 'version_not_found' | 'contribution_removed' | 'empty_body' | 'invalid_actor';

/** A typed failure from the versioning engine, carrying a code the caller can map to an HTTP status. */
export class VersioningError extends Error {
    constructor(
        readonly code: VersioningErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'VersioningError';
    }
}

/** Fields needed to append a new version (an edit) to an existing contribution. */
export interface EditInput {
    /** The acting developer — recorded as the new version's author. */
    actorId: string;
    /** The new version payload, an opaque JSON string the spine does not interpret. */
    body: string;
    /** Optional note describing the change. */
    changeNote?: string | null;
    /** UTC ISO timestamp for the new version; defaults to now. */
    timestamp?: string;
}

/** Fields needed to revert a contribution to a prior version. */
export interface RevertInput {
    /** The acting developer — recorded as the author of the revert version. */
    actorId: string;
    /**
     * Optional note for the revert version. When omitted a descriptive default is
     * recorded (`Reverted to version N`) so the lineage is self-explaining.
     */
    changeNote?: string | null;
    /** UTC ISO timestamp for the new version; defaults to now. */
    timestamp?: string;
}

/**
 * Reject a missing or blank actor. A version row's `author_id` is the "who" of the
 * "who changed what, when" record; an empty string would satisfy the NOT NULL column
 * yet leave an effectively anonymous edit, so the engine enforces a non-blank actor
 * here rather than trusting the caller (mirroring the state machine's `requireActor`).
 */
function requireActor(actorId: string): void {
    if (actorId.trim() === '') {
        throw new VersioningError('invalid_actor', 'A non-empty actorId is required to create a version.');
    }
}

/**
 * Load the contribution and refuse versioning when it is missing or `removed`.
 * `removed` is the terminal tombstone (the state machine's soft delete) — appending
 * a version to it would grow a misleading history on something that has been taken
 * down, so versioning is fail-closed there. Returns nothing; throws a typed error
 * otherwise. Callers use this before any append so the guard is consistent.
 */
function requireVersionable(db: Database.Database, contributionId: string): void {
    const contribution = getContribution(db, contributionId);
    if (!contribution) {
        throw new VersioningError('not_found', `Contribution '${contributionId}' not found.`);
    }
    if (contribution.state === 'removed') {
        throw new VersioningError(
            'contribution_removed',
            `Contribution '${contributionId}' is removed; no further versions can be created.`,
        );
    }
}

/**
 * Edit a contribution by appending a new version of its body. The store advances
 * `current_version` to the new version atomically, so the next default read serves
 * the edit. Works in any live lifecycle state (a draft is versioned as it is
 * authored; a published item is versioned when edited) — it is refused only on a
 * `removed` contribution.
 *
 * Returns the newly created version. Throws `invalid_actor` for a blank actor,
 * `empty_body` for an empty body, `not_found` when the contribution does not exist,
 * or `contribution_removed` when it has been removed.
 */
export function editContribution(db: Database.Database, contributionId: string, input: EditInput): ContributionVersion {
    requireActor(input.actorId);
    if (input.body === '') {
        throw new VersioningError('empty_body', 'A version body cannot be empty.');
    }
    requireVersionable(db, contributionId);

    const version = addContributionVersion(db, contributionId, {
        body: input.body,
        authorId: input.actorId,
        changeNote: input.changeNote ?? null,
        timestamp: input.timestamp,
    });
    // requireVersionable already proved the contribution exists and is single-writer
    // safe, so a missing return here would be a genuine invariant break, not a normal
    // not-found — surface it loudly rather than handing back undefined.
    if (!version) {
        throw new VersioningError('not_found', `Contribution '${contributionId}' not found.`);
    }
    return version;
}

/**
 * Revert a contribution to a prior version by appending a NEW version whose body
 * equals that target version's body. History is preserved, never rewritten: the old
 * versions stay exactly as they were and the chain grows by one. The new version's
 * author is the actor performing the revert (not the original author), and its
 * change_note defaults to `Reverted to version N` when none is given.
 *
 * Reverting to the current version is allowed and is a meaningful no-content-change
 * checkpoint (a new version with identical body) rather than an error — the engine
 * does not special-case it.
 *
 * Returns the newly created version (its `version` is the new head, not `target`).
 * Throws `invalid_actor` for a blank actor, `contribution_removed` when the
 * contribution is removed, or `version_not_found` when the target version (or the
 * contribution) does not exist.
 */
export function revertToVersion(
    db: Database.Database,
    contributionId: string,
    target: number,
    input: RevertInput,
): ContributionVersion {
    requireActor(input.actorId);
    requireVersionable(db, contributionId);

    const source = getContributionVersion(db, contributionId, target);
    if (!source) {
        throw new VersioningError(
            'version_not_found',
            `Version ${target} of contribution '${contributionId}' does not exist.`,
        );
    }

    const version = addContributionVersion(db, contributionId, {
        body: source.body,
        authorId: input.actorId,
        changeNote: input.changeNote ?? `Reverted to version ${target}`,
        timestamp: input.timestamp,
    });
    // The contribution existed a moment ago (requireVersionable) and this is a single
    // writer, so a missing append is an invariant break, not an ordinary not-found.
    if (!version) {
        throw new VersioningError('not_found', `Contribution '${contributionId}' not found.`);
    }
    return version;
}

/**
 * The full version history of a contribution, oldest first (version ascending).
 * Returns an empty array for an unknown contribution — a history read is a safe,
 * non-mutating query, so it does not throw on not-found (callers that need to
 * distinguish "no such contribution" from "no versions" can pair it with a
 * contribution lookup; in practice every contribution has at least version 1).
 */
export function getVersionHistory(db: Database.Database, contributionId: string): ContributionVersion[] {
    return listContributionVersions(db, contributionId);
}

/**
 * The current (live) version a default read should serve — the one
 * `current_version` points at. Returns undefined when the contribution does not
 * exist (or, only under externally-corrupted data, points at an absent version).
 */
export function getCurrentVersion(db: Database.Database, contributionId: string): ContributionVersion | undefined {
    return getCurrentContributionVersion(db, contributionId);
}
