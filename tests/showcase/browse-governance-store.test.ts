import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    insertShowcaseExample,
    browseShowcaseExamples,
    getShowcaseExampleForViewer,
    getShowcaseExampleById,
    unpublishOwnExample,
    markExampleRemoved,
    insertShowcaseRemoval,
    listShowcaseRemovalsForAuthor,
    acknowledgeShowcaseRemoval,
    listPublishedExamples,
} from '../../src/showcase/store';
import type {ShowcaseExample, ShowcasePublishRecord} from '../../src/showcase/types';

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

function pub(db: Database.Database, overrides: Partial<ShowcasePublishRecord> = {}): ShowcaseExample {
    return insertShowcaseExample(db, record(overrides));
}

describe('showcase browse + governance store (Task 5.9)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        for (const t of ['eng', 'design']) {
            db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(t, NOW);
        }
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
        seedDeveloper(db, 'carol', 'design');
    });

    afterEach(() => {
        db.close();
    });

    // --- Access-scoped browse ---------------------------------------------

    it('shows org-scoped examples to everyone and team-scoped only within the team', () => {
        pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng', title: 'eng-team'});
        pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-team'});
        pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null, title: 'org-wide'});

        const engView = browseShowcaseExamples(db, 'eng').map((e) => e.title);
        expect(engView.sort()).toEqual(['eng-team', 'org-wide']);

        const designView = browseShowcaseExamples(db, 'design').map((e) => e.title);
        expect(designView.sort()).toEqual(['design-team', 'org-wide']);

        // A team-scoped example is NEVER visible outside its team.
        expect(engView).not.toContain('design-team');
        expect(designView).not.toContain('eng-team');
    });

    it('shows a viewer with no team only org-scoped examples', () => {
        pub(db, {scope: 'team', scopeTarget: 'eng', title: 'eng-team'});
        pub(db, {scope: 'org', scopeTarget: null, title: 'org-wide'});
        expect(browseShowcaseExamples(db, null).map((e) => e.title)).toEqual(['org-wide']);
    });

    it('excludes unpublished and removed examples from browse', () => {
        const a = pub(db, {scope: 'org', scopeTarget: null, title: 'live'});
        const b = pub(db, {scope: 'org', scopeTarget: null, title: 'gone-unpub'});
        const c = pub(db, {scope: 'org', scopeTarget: null, title: 'gone-removed'});
        unpublishOwnExample(db, 'alice', b.id);
        markExampleRemoved(db, c.id);
        expect(browseShowcaseExamples(db, 'eng').map((e) => e.title)).toEqual(['live']);
        // _a unused beyond seeding visible row
        expect(a.status).toBe('published');
    });

    it('orders browse newest-first', () => {
        pub(db, {scope: 'org', scopeTarget: null, title: 'older', publishedAt: '2026-06-10T00:00:00.000Z'});
        pub(db, {scope: 'org', scopeTarget: null, title: 'newer', publishedAt: '2026-06-12T00:00:00.000Z'});
        expect(browseShowcaseExamples(db, 'eng').map((e) => e.title)).toEqual(['newer', 'older']);
    });

    // --- Filters -----------------------------------------------------------

    it('filters by task_type, tool, scope, and team — each narrowing within access scope', () => {
        pub(db, {scope: 'org', scopeTarget: null, title: 'org-debug-claude', taskType: 'debugging', tool: 'claude_code'});
        pub(db, {scope: 'org', scopeTarget: null, title: 'org-refactor-copilot', taskType: 'refactor', tool: 'copilot'});
        pub(db, {scope: 'team', scopeTarget: 'eng', title: 'eng-debug-copilot', taskType: 'debugging', tool: 'copilot'});

        expect(browseShowcaseExamples(db, 'eng', {taskType: 'debugging'}).map((e) => e.title).sort()).toEqual([
            'eng-debug-copilot',
            'org-debug-claude',
        ]);
        expect(browseShowcaseExamples(db, 'eng', {tool: 'copilot'}).map((e) => e.title).sort()).toEqual([
            'eng-debug-copilot',
            'org-refactor-copilot',
        ]);
        expect(browseShowcaseExamples(db, 'eng', {scope: 'org'}).map((e) => e.title).sort()).toEqual([
            'org-debug-claude',
            'org-refactor-copilot',
        ]);
        expect(browseShowcaseExamples(db, 'eng', {team: 'eng'}).map((e) => e.title)).toEqual(['eng-debug-copilot']);
    });

    it('a team filter cannot widen visibility into another team', () => {
        pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-only'});
        // An eng viewer asking for team=design still sees nothing — access scope is applied first.
        expect(browseShowcaseExamples(db, 'eng', {team: 'design'})).toHaveLength(0);
    });

    // --- getShowcaseExampleForViewer --------------------------------------

    it('returns a single example only when the viewer may see it', () => {
        const engTeam = pub(db, {scope: 'team', scopeTarget: 'eng', title: 'eng-team'});
        const designTeam = pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-team'});

        expect(getShowcaseExampleForViewer(db, 'eng', engTeam.id)?.title).toBe('eng-team');
        // Outside-team example is indistinguishable from not-found.
        expect(getShowcaseExampleForViewer(db, 'eng', designTeam.id)).toBeUndefined();
    });

    it('does not return an unpublished/removed example to a viewer', () => {
        const ex = pub(db, {scope: 'org', scopeTarget: null});
        unpublishOwnExample(db, 'alice', ex.id);
        expect(getShowcaseExampleForViewer(db, 'eng', ex.id)).toBeUndefined();
    });

    // --- Owner unpublish ---------------------------------------------------

    it('owner unpublish flips status, is author-scoped, and never resurrects a removed example', () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null});

        // Wrong author cannot unpublish.
        expect(unpublishOwnExample(db, 'bob', ex.id)).toBeUndefined();
        expect(getShowcaseExampleById(db, ex.id)?.status).toBe('published');

        // Owner can.
        expect(unpublishOwnExample(db, 'alice', ex.id)?.status).toBe('unpublished');

        // A second unpublish is a no-op (already not published).
        expect(unpublishOwnExample(db, 'alice', ex.id)).toBeUndefined();

        // A removed example can't be flipped back to unpublished via this path.
        const removed = pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null});
        markExampleRemoved(db, removed.id);
        expect(unpublishOwnExample(db, 'alice', removed.id)).toBeUndefined();
        expect(getShowcaseExampleById(db, removed.id)?.status).toBe('removed');
    });

    // --- Removal audit + notification feed --------------------------------

    it('records a removal and surfaces it in the author’s feed, joined to the example title', () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng', title: 'My example'});
        markExampleRemoved(db, ex.id);
        const removalId = insertShowcaseRemoval(db, {
            exampleId: ex.id,
            authorDeveloperId: 'alice',
            removedByUserId: 'lead-user',
            removedByEmail: 'lead@test.com',
            team: 'eng',
            reason: 'off-topic',
            occurredAt: NOW,
        });

        const feed = listShowcaseRemovalsForAuthor(db, 'alice');
        expect(feed).toHaveLength(1);
        expect(feed[0]).toMatchObject({
            id: removalId,
            exampleId: ex.id,
            exampleTitle: 'My example',
            removedByEmail: 'lead@test.com',
            team: 'eng',
            reason: 'off-topic',
            acknowledgedAt: null,
        });

        // The feed is author-scoped — another developer never sees it.
        expect(listShowcaseRemovalsForAuthor(db, 'bob')).toHaveLength(0);
    });

    it('acknowledging a removal is author-scoped and idempotent on the timestamp', () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null});
        const removalId = insertShowcaseRemoval(db, {
            exampleId: ex.id,
            authorDeveloperId: 'alice',
            removedByUserId: 'lead-user',
            removedByEmail: 'lead@test.com',
            team: 'eng',
            reason: null,
            occurredAt: NOW,
        });

        // Another developer cannot acknowledge it.
        expect(acknowledgeShowcaseRemoval(db, 'bob', removalId, '2026-06-13T01:00:00.000Z')).toBe(false);

        const firstAck = '2026-06-13T02:00:00.000Z';
        expect(acknowledgeShowcaseRemoval(db, 'alice', removalId, firstAck)).toBe(true);
        // A second acknowledge is a no-op and does not overwrite the original time.
        expect(acknowledgeShowcaseRemoval(db, 'alice', removalId, '2026-06-13T03:00:00.000Z')).toBe(false);
        expect(listShowcaseRemovalsForAuthor(db, 'alice')[0].acknowledgedAt).toBe(firstAck);
    });

    // --- Moderation list (unscoped by viewer) ------------------------------

    it('listPublishedExamples returns every published example regardless of team', () => {
        pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng', title: 'eng-team'});
        pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-team'});
        const removed = pub(db, {scope: 'org', scopeTarget: null, title: 'removed'});
        markExampleRemoved(db, removed.id);

        const all = listPublishedExamples(db).map((e) => e.title).sort();
        expect(all).toEqual(['design-team', 'eng-team']); // removed excluded
        expect(listPublishedExamples(db, {scope: 'team', tool: 'claude_code'}).length).toBe(2);
    });
});
