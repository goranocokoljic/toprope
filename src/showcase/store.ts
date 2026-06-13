/**
 * Persistence for the showcase shared store (Task 5.8 / #129).
 *
 * This is the SEPARATE SHARED STORE — `showcase_examples` — deliberately distinct
 * from the private encrypted `prompt_captures`. The single write path here,
 * `insertShowcaseExample`, persists exactly the REDACTED content the owner chose
 * to publish; there is no path that copies a capture's plaintext in, so nothing
 * is ever auto-harvested. Read paths in this module are scoped to a single author
 * (the owner's "what have I published" view); the org-visible BROWSE read with
 * access scoping belongs to Task 5.9.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {
    isShowcaseScope,
    isShowcaseStatus,
    type ShowcaseBrowseFilters,
    type ShowcaseExample,
    type ShowcasePublishRecord,
    type ShowcaseRemovalNotice,
    type ShowcaseRemovalRecord,
} from './types';

interface ShowcaseRow {
    id: string;
    author_developer_id: string;
    published_at: string;
    scope: string;
    scope_target: string | null;
    title: string;
    task_type: string | null;
    tool: string | null;
    content: string;
    author_note: string | null;
    status: string;
    created_at: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Decode the scope column. The write path only stores a validated value and the
 * DB CHECK enforces it, so an unrecognized value means corruption or a future
 * enum migration; warn (mirroring the capture/retrospective decoders) and fall
 * back to the narrower 'team' rather than over-broaden a row to org-wide.
 */
function decodeScope(raw: string): ShowcaseExample['scope'] {
    if (isShowcaseScope(raw)) {
        return raw;
    }
    console.warn(`[showcase] unrecognized scope '${raw}'; defaulting to team`);
    return 'team';
}

/** Decode the status column with the same defensive posture; default to the safe 'removed'. */
function decodeStatus(raw: string): ShowcaseExample['status'] {
    if (isShowcaseStatus(raw)) {
        return raw;
    }
    console.warn(`[showcase] unrecognized status '${raw}'; defaulting to removed`);
    return 'removed';
}

function rowToExample(row: ShowcaseRow): ShowcaseExample {
    return {
        id: row.id,
        authorDeveloperId: row.author_developer_id,
        publishedAt: row.published_at,
        scope: decodeScope(row.scope),
        scopeTarget: row.scope_target,
        title: row.title,
        taskType: row.task_type,
        tool: row.tool,
        content: row.content,
        authorNote: row.author_note,
        status: decodeStatus(row.status),
        createdAt: row.created_at,
    };
}

/**
 * Persist one published example and return it with the server-assigned id +
 * created_at. status is always 'published' on insert — the governance states
 * (unpublished/removed) are transitions Task 5.9 owns.
 */
export function insertShowcaseExample(db: Database.Database, record: ShowcasePublishRecord): ShowcaseExample {
    const id = randomUUID();
    const createdAt = nowIso();
    db.prepare(
        `INSERT INTO showcase_examples
         (id, author_developer_id, published_at, scope, scope_target, title, task_type, tool, content, author_note, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
    ).run(
        id,
        record.authorDeveloperId,
        record.publishedAt,
        record.scope,
        record.scopeTarget,
        record.title,
        record.taskType,
        record.tool,
        record.content,
        record.authorNote,
        createdAt,
    );
    return {
        id,
        authorDeveloperId: record.authorDeveloperId,
        publishedAt: record.publishedAt,
        scope: record.scope,
        scopeTarget: record.scopeTarget,
        title: record.title,
        taskType: record.taskType,
        tool: record.tool,
        content: record.content,
        authorNote: record.authorNote,
        status: 'published',
        createdAt,
    };
}

/** Every example a developer has authored, newest first. The owner's own "what have I published" view. */
export function listShowcaseExamplesByAuthor(db: Database.Database, authorDeveloperId: string): ShowcaseExample[] {
    const rows = db
        .prepare(
            `SELECT * FROM showcase_examples
             WHERE author_developer_id = ?
             ORDER BY published_at DESC, created_at DESC`,
        )
        .all(authorDeveloperId) as ShowcaseRow[];
    return rows.map(rowToExample);
}

/**
 * One example by id, scoped to its author. 5.8 reads are owner-only (the author
 * confirming their own publish); the access-scoped org browse is Task 5.9. The
 * author_developer_id is part of the WHERE clause so a guessed id belonging to
 * another developer returns undefined here rather than leaking through this path.
 */
export function getShowcaseExampleForAuthor(
    db: Database.Database,
    authorDeveloperId: string,
    exampleId: string,
): ShowcaseExample | undefined {
    const row = db
        .prepare('SELECT * FROM showcase_examples WHERE id = ? AND author_developer_id = ?')
        .get(exampleId, authorDeveloperId) as ShowcaseRow | undefined;
    return row ? rowToExample(row) : undefined;
}

// --- Task 5.9: access-scoped browse, governance transitions, removal audit ---

/**
 * The SQL fragment + params that confine a browse read to what a viewer on
 * `viewerTeam` may see: org-scoped examples (visible to everyone) OR team-scoped
 * examples whose scope_target is the viewer's own team. A viewer with no team
 * (null) sees only org-scoped examples. This is the single home for the access
 * rule, so browse-list and browse-one can never drift apart — the team-scoped
 * "NOT visible outside the team" guarantee lives in exactly one place.
 */
function accessScopeClause(viewerTeam: string | null): {sql: string; params: unknown[]} {
    if (viewerTeam === null) {
        return {sql: "scope = 'org'", params: []};
    }
    return {sql: "(scope = 'org' OR (scope = 'team' AND scope_target = ?))", params: [viewerTeam]};
}

/**
 * Append the shared content filters (task_type / tool / scope) to a WHERE
 * clause/param list, in place. The one home for these three filters so the
 * access-scoped browse and the moderation list can't drift in how they apply
 * them. Each is bound via `?` — only the values are user-supplied, never columns.
 */
function appendContentFilters(
    clauses: string[],
    params: unknown[],
    filters: Pick<ShowcaseBrowseFilters, 'taskType' | 'tool' | 'scope'>,
): void {
    if (filters.taskType !== undefined) {
        clauses.push('task_type = ?');
        params.push(filters.taskType);
    }
    if (filters.tool !== undefined) {
        clauses.push('tool = ?');
        params.push(filters.tool);
    }
    if (filters.scope !== undefined) {
        clauses.push('scope = ?');
        params.push(filters.scope);
    }
}

/** Run a showcase SELECT with the given AND-combined clauses + bound params, newest first. */
function selectShowcase(db: Database.Database, clauses: string[], params: unknown[]): ShowcaseExample[] {
    const rows = db
        .prepare(
            `SELECT * FROM showcase_examples
             WHERE ${clauses.join(' AND ')}
             ORDER BY published_at DESC, created_at DESC`,
        )
        .all(...params) as ShowcaseRow[];
    return rows.map(rowToExample);
}

/**
 * Browse PUBLISHED examples a viewer may see, newest first, with optional
 * filters. Access scope is applied FIRST (see accessScopeClause) and the filters
 * only narrow within it — a `team` filter can never reveal another team's
 * team-scoped examples, because the access clause has already excluded them.
 * Only `status = 'published'` rows surface: unpublished/removed examples are gone
 * from browse entirely.
 */
export function browseShowcaseExamples(
    db: Database.Database,
    viewerTeam: string | null,
    filters: ShowcaseBrowseFilters = {},
): ShowcaseExample[] {
    const access = accessScopeClause(viewerTeam);
    const clauses = ["status = 'published'", access.sql];
    const params: unknown[] = [...access.params];
    appendContentFilters(clauses, params, filters);
    // A team filter narrows to that team's scope_target. Combined with the access
    // clause it is a no-op widening: org-scoped rows have a null scope_target and
    // so are excluded by it, leaving only that team's team-scoped examples — which
    // the access clause has already confirmed the viewer is allowed to see.
    if (filters.team !== undefined) {
        clauses.push('scope_target = ?');
        params.push(filters.team);
    }
    return selectShowcase(db, clauses, params);
}

/**
 * One PUBLISHED example by id IF the viewer may see it (same access scope as
 * browse). Returns undefined for an example outside the viewer's scope or one
 * that isn't published — so a guessed id for a team-scoped example in another
 * team, or an unpublished/removed one, is indistinguishable from "not found".
 */
export function getShowcaseExampleForViewer(
    db: Database.Database,
    viewerTeam: string | null,
    exampleId: string,
): ShowcaseExample | undefined {
    const access = accessScopeClause(viewerTeam);
    const row = db
        .prepare(
            `SELECT * FROM showcase_examples
             WHERE id = ? AND status = 'published' AND ${access.sql}`,
        )
        .get(exampleId, ...access.params) as ShowcaseRow | undefined;
    return row ? rowToExample(row) : undefined;
}

/** One example by id, UNSCOPED — for the governance surface, which needs to see any example regardless of viewer/author. */
export function getShowcaseExampleById(db: Database.Database, exampleId: string): ShowcaseExample | undefined {
    const row = db.prepare('SELECT * FROM showcase_examples WHERE id = ?').get(exampleId) as ShowcaseRow | undefined;
    return row ? rowToExample(row) : undefined;
}

/** Filters for the moderation list: the shared content filters plus a `team` that scopes to one team's showcase. */
export type ShowcaseModerationFilters = Pick<ShowcaseBrowseFilters, 'taskType' | 'tool' | 'scope'> & {team?: string};

/**
 * All PUBLISHED examples (UNSCOPED by viewer/author), newest first, with optional
 * content filters — the moderation surface for team leads/admins. Deliberately
 * NOT access-scoped: a lead moderates by team membership, not by their own browse
 * visibility. `status='published'` still holds, so already-removed/unpublished
 * examples never resurface here.
 *
 * A `team` filter narrows to that team's showcase IN SQL — team-scoped to the
 * team, OR authored by a current member of the team — the same membership rule
 * `isExampleInTeamShowcase` applies to a single example, kept here as one query
 * rather than a per-row developer lookup.
 */
export function listPublishedExamples(db: Database.Database, filters: ShowcaseModerationFilters = {}): ShowcaseExample[] {
    const clauses = ["status = 'published'"];
    const params: unknown[] = [];
    appendContentFilters(clauses, params, filters);
    if (filters.team !== undefined) {
        clauses.push(
            "((scope = 'team' AND scope_target = ?) OR author_developer_id IN (SELECT id FROM developers WHERE team = ?))",
        );
        params.push(filters.team, filters.team);
    }
    return selectShowcase(db, clauses, params);
}

/**
 * Transition the owner's OWN published example to `unpublished`. Author-scoped
 * AND guarded on the current status being 'published', so it is idempotent-safe
 * and can never resurrect a 'removed' example (a team-lead removal stays
 * removed). Returns the updated example, or undefined when nothing matched
 * (wrong author, missing id, or not currently published).
 */
export function unpublishOwnExample(
    db: Database.Database,
    authorDeveloperId: string,
    exampleId: string,
): ShowcaseExample | undefined {
    const res = db
        .prepare(
            `UPDATE showcase_examples SET status = 'unpublished'
             WHERE id = ? AND author_developer_id = ? AND status = 'published'`,
        )
        .run(exampleId, authorDeveloperId);
    if (res.changes === 0) {
        return undefined;
    }
    return getShowcaseExampleForAuthor(db, authorDeveloperId, exampleId);
}

/**
 * Mark an example `removed` (the team-lead governance state). UNSCOPED by author
 * because a lead acts on someone else's example; the caller (governance service)
 * has already authorized the action. Guarded on status='published' so a removal
 * is a real transition, not a no-op on an already-gone example. Returns true
 * when a row actually transitioned.
 */
export function markExampleRemoved(db: Database.Database, exampleId: string): boolean {
    const res = db
        .prepare("UPDATE showcase_examples SET status = 'removed' WHERE id = ? AND status = 'published'")
        .run(exampleId);
    return res.changes > 0;
}

/** Append one team-lead removal to the audit/notification trail and return its server id. */
export function insertShowcaseRemoval(db: Database.Database, record: ShowcaseRemovalRecord): string {
    const id = randomUUID();
    db.prepare(
        `INSERT INTO showcase_removals
         (id, example_id, author_developer_id, removed_by_user_id, removed_by_email, team, reason, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        record.exampleId,
        record.authorDeveloperId,
        record.removedByUserId,
        record.removedByEmail,
        record.team,
        record.reason,
        record.occurredAt,
    );
    return id;
}

interface RemovalRow {
    id: string;
    example_id: string;
    example_title: string;
    removed_by_email: string;
    team: string | null;
    reason: string | null;
    occurred_at: string;
    acknowledged_at: string | null;
}

/**
 * The author's removal-notification feed: every removal of one of their examples,
 * newest first, joined to the example title. Filtered strictly to the author's
 * own id so one developer can never read another's removals.
 */
export function listShowcaseRemovalsForAuthor(db: Database.Database, authorDeveloperId: string): ShowcaseRemovalNotice[] {
    const rows = db
        .prepare(
            `SELECT r.id, r.example_id, e.title AS example_title, r.removed_by_email,
                    r.team, r.reason, r.occurred_at, r.acknowledged_at
             FROM showcase_removals r
             JOIN showcase_examples e ON e.id = r.example_id
             WHERE r.author_developer_id = ?
             ORDER BY r.occurred_at DESC`,
        )
        .all(authorDeveloperId) as RemovalRow[];
    return rows.map((row) => ({
        id: row.id,
        exampleId: row.example_id,
        exampleTitle: row.example_title,
        removedByEmail: row.removed_by_email,
        team: row.team,
        reason: row.reason,
        occurredAt: row.occurred_at,
        acknowledgedAt: row.acknowledged_at,
    }));
}

/**
 * Mark one removal notice acknowledged (the author dismissed it). Author-scoped
 * so a developer can only dismiss their own notices, and guarded on
 * acknowledged_at IS NULL so a re-dismiss never rewrites the original timestamp.
 * Returns true when an unread notice was acknowledged by this call.
 */
export function acknowledgeShowcaseRemoval(
    db: Database.Database,
    authorDeveloperId: string,
    removalId: string,
    acknowledgedAt: string,
): boolean {
    const res = db
        .prepare(
            `UPDATE showcase_removals SET acknowledged_at = ?
             WHERE id = ? AND author_developer_id = ? AND acknowledged_at IS NULL`,
        )
        .run(acknowledgedAt, removalId, authorDeveloperId);
    return res.changes > 0;
}
