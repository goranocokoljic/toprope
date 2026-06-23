/**
 * Data-access layer for the contribution spine (Task 6.1.1 / #151).
 *
 * CRUD over the four spine tables — contributions, contribution_versions,
 * contribution_tags, contribution_review_events — and nothing feature-specific.
 * The store never interprets a version `body` (opaque JSON) and never encodes
 * which lifecycle transition is legal (that is 6.1.2's job): it only persists and
 * reads the spine.
 *
 * Two invariants are kept here so callers can rely on them:
 *   1. Every contribution has at least version 1 — `createContribution` writes the
 *      spine row and version 1 in one transaction.
 *   2. `contributions.current_version` always points at the highest existing
 *      version — `addContributionVersion` bumps it atomically with the insert.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {
    isContributionScope,
    isContributionState,
    type Contribution,
    type ContributionFilters,
    type ContributionReviewEvent,
    type ContributionVersion,
    type NewContribution,
    type NewContributionVersion,
    type NewReviewEvent,
} from './types';

function nowIso(): string {
    return new Date().toISOString();
}

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

interface VersionRow {
    id: string;
    contribution_id: string;
    version: number;
    body: string;
    author_id: string;
    change_note: string | null;
    created_at: string;
}

interface ReviewEventRow {
    id: string;
    contribution_id: string;
    event: string;
    actor_id: string;
    note: string | null;
    occurred_at: string;
}

/**
 * Decode the scope column. The write path only stores a validated value and the
 * DB CHECK enforces it, so an unrecognized value means corruption or a future
 * enum migration; warn (mirroring the showcase decoder) and fall back to the
 * narrower 'team' rather than over-broaden a row to org-wide.
 */
function decodeScope(raw: string): Contribution['scope'] {
    if (isContributionScope(raw)) {
        return raw;
    }
    console.warn(`[contributions] unrecognized scope '${raw}'; defaulting to team`);
    return 'team';
}

/** Decode the state column with the same defensive posture; default to the safe terminal 'removed'. */
function decodeState(raw: string): Contribution['state'] {
    if (isContributionState(raw)) {
        return raw;
    }
    console.warn(`[contributions] unrecognized state '${raw}'; defaulting to removed`);
    return 'removed';
}

function rowToContribution(row: ContributionRow): Contribution {
    return {
        id: row.id,
        contentType: row.content_type,
        title: row.title,
        authorId: row.author_id,
        scope: decodeScope(row.scope),
        scopeTarget: row.scope_target,
        state: decodeState(row.state),
        currentVersion: row.current_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToVersion(row: VersionRow): ContributionVersion {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        version: row.version,
        body: row.body,
        authorId: row.author_id,
        changeNote: row.change_note,
        createdAt: row.created_at,
    };
}

function rowToReviewEvent(row: ReviewEventRow): ContributionReviewEvent {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        event: row.event,
        actorId: row.actor_id,
        note: row.note,
        occurredAt: row.occurred_at,
    };
}

// --- Contributions ----------------------------------------------------------

/**
 * Create a contribution and its version 1 atomically, returning the spine row.
 * Both writes happen in one transaction so a contribution can never exist
 * without the version its `currentVersion` (= 1) points at.
 */
export function createContribution(db: Database.Database, input: NewContribution): Contribution {
    const id = randomUUID();
    const ts = input.timestamp ?? nowIso();
    const state = input.state ?? 'draft';
    const scopeTarget = input.scopeTarget ?? null;

    db.transaction(() => {
        db.prepare(
            `INSERT INTO contributions
             (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(id, input.contentType, input.title, input.authorId, input.scope, scopeTarget, state, ts, ts);
        db.prepare(
            `INSERT INTO contribution_versions
             (id, contribution_id, version, body, author_id, change_note, created_at)
             VALUES (?, ?, 1, ?, ?, ?, ?)`,
        ).run(randomUUID(), id, input.body, input.authorId, input.changeNote ?? null, ts);
    })();

    return {
        id,
        contentType: input.contentType,
        title: input.title,
        authorId: input.authorId,
        scope: input.scope,
        scopeTarget,
        state,
        currentVersion: 1,
        createdAt: ts,
        updatedAt: ts,
    };
}

/** One contribution by id, or undefined when it does not exist. */
export function getContribution(db: Database.Database, id: string): Contribution | undefined {
    const row = db.prepare('SELECT * FROM contributions WHERE id = ?').get(id) as ContributionRow | undefined;
    return row ? rowToContribution(row) : undefined;
}

/**
 * List contributions, newest first, narrowed by any combination of the optional
 * filters. Every filter binds via `?` (values only, never columns), and an
 * omitted filter simply isn't applied — passing `{}` lists everything.
 */
export function listContributions(db: Database.Database, filters: ContributionFilters = {}): Contribution[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.contentType !== undefined) {
        clauses.push('content_type = ?');
        params.push(filters.contentType);
    }
    if (filters.scope !== undefined) {
        clauses.push('scope = ?');
        params.push(filters.scope);
    }
    if (filters.scopeTarget !== undefined) {
        clauses.push('scope_target = ?');
        params.push(filters.scopeTarget);
    }
    if (filters.state !== undefined) {
        clauses.push('state = ?');
        params.push(filters.state);
    }
    if (filters.authorId !== undefined) {
        clauses.push('author_id = ?');
        params.push(filters.authorId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
        .prepare(`SELECT * FROM contributions ${where} ORDER BY created_at DESC, id DESC`)
        .all(...params) as ContributionRow[];
    return rows.map(rowToContribution);
}

/**
 * Transition a contribution to a new `state` and stamp `updated_at`. Returns the
 * updated contribution, or undefined when no row matched the id. This is the
 * spine's mechanical state write — it does NOT police whether the transition is
 * legal (the 6.1.2 state machine owns that); a bad `state` is still rejected by
 * the DB CHECK.
 */
export function updateContributionState(
    db: Database.Database,
    id: string,
    state: Contribution['state'],
    updatedAt?: string,
): Contribution | undefined {
    const res = db
        .prepare('UPDATE contributions SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, updatedAt ?? nowIso(), id);
    if (res.changes === 0) {
        return undefined;
    }
    return getContribution(db, id);
}

/**
 * Hard-delete a contribution and, via ON DELETE CASCADE, all of its versions,
 * tags, and review events. Returns true when a row was removed. Note: the normal
 * lifecycle uses the `removed` STATE (a soft remove that preserves the audit
 * trail); this is for genuine erasure. Requires `PRAGMA foreign_keys = ON` for
 * the cascade — which the app and tests both set.
 */
export function deleteContribution(db: Database.Database, id: string): boolean {
    const res = db.prepare('DELETE FROM contributions WHERE id = ?').run(id);
    return res.changes > 0;
}

// --- Versions ---------------------------------------------------------------

/**
 * Append a new version to an existing contribution and point `current_version`
 * at it, atomically. The new version number is `max(version) + 1` for that
 * contribution, computed inside the transaction so concurrent writers can't
 * collide (the UNIQUE(contribution_id, version) constraint is the backstop).
 * Returns the new version, or undefined when the contribution does not exist.
 */
export function addContributionVersion(
    db: Database.Database,
    contributionId: string,
    input: NewContributionVersion,
): ContributionVersion | undefined {
    const ts = input.timestamp ?? nowIso();
    return db.transaction((): ContributionVersion | undefined => {
        const exists = db.prepare('SELECT current_version FROM contributions WHERE id = ?').get(contributionId) as
            | {current_version: number}
            | undefined;
        if (exists === undefined) {
            return undefined;
        }
        const maxRow = db
            .prepare('SELECT MAX(version) AS max FROM contribution_versions WHERE contribution_id = ?')
            .get(contributionId) as {max: number | null};
        const nextVersion = (maxRow.max ?? 0) + 1;
        const id = randomUUID();
        db.prepare(
            `INSERT INTO contribution_versions
             (id, contribution_id, version, body, author_id, change_note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, contributionId, nextVersion, input.body, input.authorId, input.changeNote ?? null, ts);
        db.prepare('UPDATE contributions SET current_version = ?, updated_at = ? WHERE id = ?').run(
            nextVersion,
            ts,
            contributionId,
        );
        return {
            id,
            contributionId,
            version: nextVersion,
            body: input.body,
            authorId: input.authorId,
            changeNote: input.changeNote ?? null,
            createdAt: ts,
        };
    })();
}

/** One specific version of a contribution, or undefined when that version doesn't exist. */
export function getContributionVersion(
    db: Database.Database,
    contributionId: string,
    version: number,
): ContributionVersion | undefined {
    const row = db
        .prepare('SELECT * FROM contribution_versions WHERE contribution_id = ? AND version = ?')
        .get(contributionId, version) as VersionRow | undefined;
    return row ? rowToVersion(row) : undefined;
}

/**
 * The live version of a contribution — the row its `current_version` points at.
 * Undefined when the contribution doesn't exist. Reads `current_version` and the
 * matching version together so the two can't drift in the result.
 */
export function getCurrentContributionVersion(
    db: Database.Database,
    contributionId: string,
): ContributionVersion | undefined {
    const row = db
        .prepare(
            `SELECT v.* FROM contribution_versions v
             JOIN contributions c ON c.id = v.contribution_id AND c.current_version = v.version
             WHERE c.id = ?`,
        )
        .get(contributionId) as VersionRow | undefined;
    return row ? rowToVersion(row) : undefined;
}

/** Every version of a contribution, oldest first (version ascending). */
export function listContributionVersions(db: Database.Database, contributionId: string): ContributionVersion[] {
    const rows = db
        .prepare('SELECT * FROM contribution_versions WHERE contribution_id = ? ORDER BY version ASC')
        .all(contributionId) as VersionRow[];
    return rows.map(rowToVersion);
}

// --- Tags -------------------------------------------------------------------

/**
 * Attach a tag to a contribution. Idempotent: re-adding an existing tag is a
 * no-op (the composite PK dedups), so this returns true only when the tag was
 * newly added.
 */
export function addContributionTag(db: Database.Database, contributionId: string, tag: string): boolean {
    const res = db
        .prepare('INSERT OR IGNORE INTO contribution_tags (contribution_id, tag) VALUES (?, ?)')
        .run(contributionId, tag);
    return res.changes > 0;
}

/** Remove a tag from a contribution. Returns true when a tag was actually removed. */
export function removeContributionTag(db: Database.Database, contributionId: string, tag: string): boolean {
    const res = db
        .prepare('DELETE FROM contribution_tags WHERE contribution_id = ? AND tag = ?')
        .run(contributionId, tag);
    return res.changes > 0;
}

/** A contribution's tags, sorted alphabetically for a stable order. */
export function getContributionTags(db: Database.Database, contributionId: string): string[] {
    const rows = db
        .prepare('SELECT tag FROM contribution_tags WHERE contribution_id = ? ORDER BY tag ASC')
        .all(contributionId) as {tag: string}[];
    return rows.map((r) => r.tag);
}

// --- Review events (audit trail) --------------------------------------------

/**
 * Append one governance/lifecycle action to a contribution's audit trail and
 * return the stored event. The trail is append-only — there is no update or
 * delete for events, mirroring the append-only posture of the rest of GovProxy.
 */
export function addReviewEvent(db: Database.Database, input: NewReviewEvent): ContributionReviewEvent {
    const id = randomUUID();
    const occurredAt = input.occurredAt ?? nowIso();
    const note = input.note ?? null;
    db.prepare(
        `INSERT INTO contribution_review_events
         (id, contribution_id, event, actor_id, note, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.contributionId, input.event, input.actorId, note, occurredAt);
    return {
        id,
        contributionId: input.contributionId,
        event: input.event,
        actorId: input.actorId,
        note,
        occurredAt,
    };
}

/**
 * A contribution's audit trail in chronological order (oldest first). Ties on
 * `occurred_at` fall back to insertion order (rowid) so events recorded in the
 * same instant still read back in the order they were appended.
 */
export function listReviewEvents(db: Database.Database, contributionId: string): ContributionReviewEvent[] {
    const rows = db
        .prepare(
            `SELECT * FROM contribution_review_events
             WHERE contribution_id = ?
             ORDER BY occurred_at ASC, rowid ASC`,
        )
        .all(contributionId) as ReviewEventRow[];
    return rows.map(rowToReviewEvent);
}
