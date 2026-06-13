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
import {isShowcaseScope, isShowcaseStatus, type ShowcaseExample, type ShowcasePublishRecord} from './types';

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
