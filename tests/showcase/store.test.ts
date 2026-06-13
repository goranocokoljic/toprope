import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    insertShowcaseExample,
    listShowcaseExamplesByAuthor,
    getShowcaseExampleForAuthor,
} from '../../src/showcase/store';
import type {ShowcasePublishRecord} from '../../src/showcase/types';

const NOW = '2026-06-13T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

function record(overrides: Partial<ShowcasePublishRecord> = {}): ShowcasePublishRecord {
    return {
        authorDeveloperId: 'alice',
        publishedAt: NOW,
        scope: 'team',
        scopeTarget: 'eng',
        title: 'A great refactor session',
        taskType: 'refactor',
        tool: 'claude_code',
        content: 'redacted conversation content',
        authorNote: 'why this is good',
        ...overrides,
    };
}

describe('showcase store (Task 5.8)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    it('inserts a published example and returns it with a server id + status published', () => {
        const ex = insertShowcaseExample(db, record());
        expect(ex.id).toMatch(/[0-9a-f-]{36}/);
        expect(ex.status).toBe('published');
        expect(ex.createdAt.length).toBeGreaterThan(0);
        expect(ex.content).toBe('redacted conversation content');
        expect(ex.scope).toBe('team');
        expect(ex.scopeTarget).toBe('eng');
    });

    it('persists into showcase_examples — a store SEPARATE from prompt_captures', () => {
        insertShowcaseExample(db, record());
        const showcaseCount = (db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number}).n;
        const captureCount = (db.prepare('SELECT COUNT(*) AS n FROM prompt_captures').get() as {n: number}).n;
        expect(showcaseCount).toBe(1);
        // Publishing writes ONLY to the shared store; nothing lands in the private store.
        expect(captureCount).toBe(0);
    });

    it('lists a developer’s own examples, newest first', () => {
        insertShowcaseExample(db, record({title: 'older', publishedAt: '2026-06-10T00:00:00.000Z'}));
        insertShowcaseExample(db, record({title: 'newer', publishedAt: '2026-06-12T00:00:00.000Z'}));
        const list = listShowcaseExamplesByAuthor(db, 'alice');
        expect(list.map((e) => e.title)).toEqual(['newer', 'older']);
    });

    it('scopes reads to the author — another developer’s id never returns the row', () => {
        const ex = insertShowcaseExample(db, record({authorDeveloperId: 'alice'}));
        expect(getShowcaseExampleForAuthor(db, 'alice', ex.id)?.id).toBe(ex.id);
        expect(getShowcaseExampleForAuthor(db, 'bob', ex.id)).toBeUndefined();
        expect(listShowcaseExamplesByAuthor(db, 'bob')).toHaveLength(0);
    });

    it('stores org-scoped examples with a null scope_target', () => {
        const ex = insertShowcaseExample(db, record({scope: 'org', scopeTarget: null}));
        expect(ex.scope).toBe('org');
        expect(ex.scopeTarget).toBeNull();
        expect(getShowcaseExampleForAuthor(db, 'alice', ex.id)?.scopeTarget).toBeNull();
    });

    it('cascades: deleting the author removes their published examples (no orphans)', () => {
        const ex = insertShowcaseExample(db, record());
        db.prepare('DELETE FROM developers WHERE id = ?').run('alice');
        expect(getShowcaseExampleForAuthor(db, 'alice', ex.id)).toBeUndefined();
        expect((db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number}).n).toBe(0);
    });
});
