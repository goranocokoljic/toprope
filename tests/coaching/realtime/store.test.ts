import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../../dashboard/fixtures';
import {
    dismissNudgeEvent,
    insertLoopEvent,
    insertNudgeEvent,
    listLoopEventsForDeveloper,
    listLoopEventsForSession,
    listNudgeEventsForDeveloper,
} from '../../../src/coaching/realtime/store';

const NOW = '2026-06-15T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(`team-${id}`, NOW);
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, `team-${id}`, NOW);
}

describe('realtime coaching store (Task 5.6)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice');
        seedDeveloper(db, 'bob');
    });

    afterEach(() => db.close());

    it('persists loop-event metadata and reads it back for the owner', () => {
        insertLoopEvent(db, 'alice', {sessionId: 's1', detectedAt: NOW, similarPromptCount: 3});
        const events = listLoopEventsForDeveloper(db, 'alice');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({developerId: 'alice', sessionId: 's1', similarPromptCount: 3});
    });

    it('lists loop events for one session, scoped to the owner', () => {
        insertLoopEvent(db, 'alice', {sessionId: 's1', detectedAt: NOW, similarPromptCount: 3});
        insertLoopEvent(db, 'alice', {sessionId: 's2', detectedAt: NOW, similarPromptCount: 4});
        insertLoopEvent(db, 'bob', {sessionId: 's1', detectedAt: NOW, similarPromptCount: 9});
        const s1 = listLoopEventsForSession(db, 'alice', 's1');
        expect(s1).toHaveLength(1);
        expect(s1[0]).toMatchObject({developerId: 'alice', sessionId: 's1', similarPromptCount: 3});
        // Another developer's same-named session is never returned.
        expect(listLoopEventsForSession(db, 'alice', 's1').some((e) => e.developerId === 'bob')).toBe(false);
        expect(listLoopEventsForSession(db, 'alice', 'unknown')).toHaveLength(0);
    });

    it('persists nudge events (un-dismissed) and supports dismissal', () => {
        const ev = insertNudgeEvent(db, 'alice', {sessionId: 's1', nudgeType: 'short_prompt', deliveredAt: NOW});
        expect(ev.dismissed).toBe(false);
        expect(dismissNudgeEvent(db, 'alice', ev.id)).toBe(true);
        expect(listNudgeEventsForDeveloper(db, 'alice')[0].dismissed).toBe(true);
    });

    it('dismissal is owner-scoped: another developer cannot dismiss your nudge', () => {
        const ev = insertNudgeEvent(db, 'alice', {sessionId: 's1', nudgeType: 'missing_error', deliveredAt: NOW});
        expect(dismissNudgeEvent(db, 'bob', ev.id)).toBe(false);
        expect(listNudgeEventsForDeveloper(db, 'alice')[0].dismissed).toBe(false);
    });

    it('listing is developer-scoped: a developer only sees their own events', () => {
        insertLoopEvent(db, 'alice', {sessionId: 's1', detectedAt: NOW, similarPromptCount: 3});
        insertNudgeEvent(db, 'bob', {sessionId: 's2', nudgeType: 'short_prompt', deliveredAt: NOW});
        expect(listLoopEventsForDeveloper(db, 'bob')).toHaveLength(0);
        expect(listNudgeEventsForDeveloper(db, 'alice')).toHaveLength(0);
    });

    it('the schema has NO column that could hold prompt content (metadata only)', () => {
        const loopCols = (db.prepare('PRAGMA table_info(loop_events)').all() as {name: string}[]).map((c) => c.name);
        const nudgeCols = (db.prepare('PRAGMA table_info(nudge_events)').all() as {name: string}[]).map((c) => c.name);
        const forbidden = ['prompt', 'prompts', 'text', 'content', 'message', 'messages', 'plaintext', 'ciphertext', 'body'];
        for (const col of [...loopCols, ...nudgeCols]) {
            expect(forbidden).not.toContain(col);
        }
        // Positively: exactly the expected metadata columns.
        expect(loopCols.sort()).toEqual(['created_at', 'detected_at', 'developer_id', 'id', 'session_id', 'similar_prompt_count']);
        expect(nudgeCols.sort()).toEqual(
            ['created_at', 'delivered_at', 'developer_id', 'dismissed', 'id', 'nudge_type', 'session_id'].sort(),
        );
    });

    it('the nudge_type CHECK rejects an out-of-set value at the DB layer', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO nudge_events (id, developer_id, session_id, nudge_type, delivered_at, dismissed, created_at)
                     VALUES ('x', 'alice', 's1', 'totally_made_up', ?, 0, ?)`,
                )
                .run(NOW, NOW),
        ).toThrow();
    });
});
