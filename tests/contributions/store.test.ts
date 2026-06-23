import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    addContributionTag,
    addContributionVersion,
    addReviewEvent,
    createContribution,
    deleteContribution,
    getContribution,
    getContributionTags,
    getContributionVersion,
    getCurrentContributionVersion,
    listContributions,
    listContributionVersions,
    listReviewEvents,
    removeContributionTag,
    updateContributionState,
} from '../../src/contributions/store';
import type {NewContribution} from '../../src/contributions/types';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';
const T3 = '2026-06-22T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        T1,
    );
}

function newContribution(overrides: Partial<NewContribution> = {}): NewContribution {
    return {
        contentType: 'best_practice',
        title: 'Use prepared statements',
        authorId: 'alice',
        scope: 'team',
        scopeTarget: 'eng',
        body: JSON.stringify({markdown: 'Always parameterize queries.'}),
        changeNote: 'initial draft',
        timestamp: T1,
        ...overrides,
    };
}

describe('contribution spine store (Task 6.1.1)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', T1);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    describe('createContribution', () => {
        it('creates the spine row at version 1 with a server id and defaults', () => {
            const c = createContribution(db, newContribution());
            expect(c.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            expect(c.currentVersion).toBe(1);
            expect(c.state).toBe('draft');
            expect(c.contentType).toBe('best_practice');
            expect(c.scope).toBe('team');
            expect(c.scopeTarget).toBe('eng');
            expect(c.createdAt).toBe(T1);
            expect(c.updatedAt).toBe(T1);
        });

        it('atomically establishes version 1 carrying the initial body', () => {
            const c = createContribution(db, newContribution());
            const v1 = getContributionVersion(db, c.id, 1);
            expect(v1).toBeDefined();
            expect(v1?.version).toBe(1);
            expect(v1?.body).toBe(JSON.stringify({markdown: 'Always parameterize queries.'}));
            expect(v1?.changeNote).toBe('initial draft');
            expect(v1?.authorId).toBe('alice');
        });

        it('defaults state to draft and scopeTarget to null when omitted', () => {
            const c = createContribution(
                db,
                newContribution({scope: 'org', scopeTarget: undefined, state: undefined}),
            );
            expect(c.scopeTarget).toBeNull();
            expect(c.state).toBe('draft');
        });

        it('accepts an open content_type the spine has never seen', () => {
            const c = createContribution(db, newContribution({contentType: 'future_kind'}));
            expect(getContribution(db, c.id)?.contentType).toBe('future_kind');
        });

        it('rejects a contribution whose author is not a known developer (FK)', () => {
            expect(() => createContribution(db, newContribution({authorId: 'ghost'}))).toThrow();
            // The failed transaction must leave no partial spine row behind.
            expect(listContributions(db).length).toBe(0);
        });
    });

    describe('read & list', () => {
        it('getContribution returns undefined for an unknown id', () => {
            expect(getContribution(db, 'nope')).toBeUndefined();
        });

        it('lists newest-first and filters by content_type, scope, state, and author', () => {
            const a = createContribution(db, newContribution({title: 'older', timestamp: T1}));
            const b = createContribution(
                db,
                newContribution({title: 'newer', timestamp: T2, contentType: 'showcase_example', authorId: 'bob'}),
            );
            expect(listContributions(db).map((c) => c.id)).toEqual([b.id, a.id]);
            expect(listContributions(db, {contentType: 'showcase_example'}).map((c) => c.id)).toEqual([b.id]);
            expect(listContributions(db, {authorId: 'alice'}).map((c) => c.id)).toEqual([a.id]);
            expect(listContributions(db, {state: 'draft'}).length).toBe(2);
            expect(listContributions(db, {state: 'published'}).length).toBe(0);
        });

        it('filters by scope and scopeTarget without leaking other teams', () => {
            createContribution(db, newContribution({scope: 'team', scopeTarget: 'eng'}));
            createContribution(db, newContribution({scope: 'org', scopeTarget: undefined}));
            expect(listContributions(db, {scope: 'team', scopeTarget: 'eng'}).length).toBe(1);
            expect(listContributions(db, {scope: 'team', scopeTarget: 'design'}).length).toBe(0);
            expect(listContributions(db, {scope: 'org'}).length).toBe(1);
        });

        it('selects org-wide rows with scopeTarget: null (IS NULL, not = NULL)', () => {
            const team = createContribution(db, newContribution({scope: 'team', scopeTarget: 'eng'}));
            const org = createContribution(db, newContribution({scope: 'org', scopeTarget: undefined}));
            // Explicit null must match the org rows (scope_target IS NULL) — and
            // must NOT silently match nothing the way `scope_target = NULL` would.
            expect(listContributions(db, {scopeTarget: null}).map((c) => c.id)).toEqual([org.id]);
            // A team-target filter still excludes the org row.
            expect(listContributions(db, {scopeTarget: 'eng'}).map((c) => c.id)).toEqual([team.id]);
        });
    });

    describe('updateContributionState', () => {
        it('transitions state and stamps updated_at, returning the updated row', () => {
            const c = createContribution(db, newContribution());
            const updated = updateContributionState(db, c.id, 'submitted', T2);
            expect(updated?.state).toBe('submitted');
            expect(updated?.updatedAt).toBe(T2);
            expect(getContribution(db, c.id)?.state).toBe('submitted');
        });

        it('returns undefined when the contribution does not exist', () => {
            expect(updateContributionState(db, 'nope', 'submitted', T2)).toBeUndefined();
        });

        it('rejects a state outside the closed lifecycle set (DB CHECK)', () => {
            const c = createContribution(db, newContribution());
            expect(() => updateContributionState(db, c.id, 'archived' as never, T2)).toThrow();
        });
    });

    describe('versions', () => {
        it('appends a version, bumps current_version, and stamps updated_at atomically', () => {
            const c = createContribution(db, newContribution());
            const v2 = addContributionVersion(db, c.id, {body: '{"v":2}', authorId: 'bob', changeNote: 'edit', timestamp: T2});
            expect(v2?.version).toBe(2);
            const reread = getContribution(db, c.id);
            expect(reread?.currentVersion).toBe(2);
            expect(reread?.updatedAt).toBe(T2);
        });

        it('numbers versions monotonically and lists them oldest-first', () => {
            const c = createContribution(db, newContribution());
            addContributionVersion(db, c.id, {body: '{"v":2}', authorId: 'alice', timestamp: T2});
            addContributionVersion(db, c.id, {body: '{"v":3}', authorId: 'alice', timestamp: T3});
            expect(listContributionVersions(db, c.id).map((v) => v.version)).toEqual([1, 2, 3]);
        });

        it('getCurrentContributionVersion follows current_version', () => {
            const c = createContribution(db, newContribution());
            addContributionVersion(db, c.id, {body: '{"v":2}', authorId: 'alice', timestamp: T2});
            const current = getCurrentContributionVersion(db, c.id);
            expect(current?.version).toBe(2);
            expect(current?.body).toBe('{"v":2}');
        });

        it('returns undefined when adding a version to a missing contribution', () => {
            expect(addContributionVersion(db, 'nope', {body: '{}', authorId: 'alice'})).toBeUndefined();
        });

        it('getContributionVersion / getCurrentContributionVersion are undefined for unknown ids', () => {
            expect(getContributionVersion(db, 'nope', 1)).toBeUndefined();
            expect(getCurrentContributionVersion(db, 'nope')).toBeUndefined();
        });
    });

    describe('tags', () => {
        it('attaches tags, dedups idempotently, and reads them sorted', () => {
            const c = createContribution(db, newContribution());
            expect(addContributionTag(db, c.id, 'sql')).toBe(true);
            expect(addContributionTag(db, c.id, 'security')).toBe(true);
            // Re-adding an existing tag is a no-op.
            expect(addContributionTag(db, c.id, 'sql')).toBe(false);
            expect(getContributionTags(db, c.id)).toEqual(['security', 'sql']);
        });

        it('removes a tag and reports whether one was removed', () => {
            const c = createContribution(db, newContribution());
            addContributionTag(db, c.id, 'sql');
            expect(removeContributionTag(db, c.id, 'sql')).toBe(true);
            expect(removeContributionTag(db, c.id, 'sql')).toBe(false);
            expect(getContributionTags(db, c.id)).toEqual([]);
        });
    });

    describe('review events (audit trail)', () => {
        it('accumulates events on a contribution in chronological order', () => {
            const c = createContribution(db, newContribution());
            addReviewEvent(db, {contributionId: c.id, event: 'submitted', actorId: 'alice', occurredAt: T1});
            addReviewEvent(db, {contributionId: c.id, event: 'approved', actorId: 'bob', note: 'lgtm', occurredAt: T2});
            addReviewEvent(db, {contributionId: c.id, event: 'published', actorId: 'bob', occurredAt: T3});
            const trail = listReviewEvents(db, c.id);
            expect(trail.map((e) => e.event)).toEqual(['submitted', 'approved', 'published']);
            expect(trail[1].note).toBe('lgtm');
            expect(trail[1].actorId).toBe('bob');
        });

        it('orders same-instant events by insertion order (rowid tiebreak)', () => {
            const c = createContribution(db, newContribution());
            addReviewEvent(db, {contributionId: c.id, event: 'submitted', actorId: 'alice', occurredAt: T1});
            addReviewEvent(db, {contributionId: c.id, event: 'redacted', actorId: 'alice', occurredAt: T1});
            expect(listReviewEvents(db, c.id).map((e) => e.event)).toEqual(['submitted', 'redacted']);
        });

        it('accepts an open event type and defaults note to null', () => {
            const c = createContribution(db, newContribution());
            const e = addReviewEvent(db, {contributionId: c.id, event: 'escalated', actorId: 'bob', occurredAt: T2});
            expect(e.event).toBe('escalated');
            expect(e.note).toBeNull();
        });

        it('returns an empty trail for a contribution with no events', () => {
            const c = createContribution(db, newContribution());
            expect(listReviewEvents(db, c.id)).toEqual([]);
        });

        it('rejects an event for a non-existent contribution (FK keeps the trail un-orphaned)', () => {
            expect(() =>
                addReviewEvent(db, {contributionId: 'ghost', event: 'submitted', actorId: 'alice', occurredAt: T1}),
            ).toThrow();
        });
    });

    describe('deleteContribution (cascade)', () => {
        it('hard-deletes the contribution and cascades versions, tags, and events', () => {
            const c = createContribution(db, newContribution());
            addContributionVersion(db, c.id, {body: '{"v":2}', authorId: 'alice', timestamp: T2});
            addContributionTag(db, c.id, 'sql');
            addReviewEvent(db, {contributionId: c.id, event: 'submitted', actorId: 'alice', occurredAt: T1});

            expect(deleteContribution(db, c.id)).toBe(true);
            expect(getContribution(db, c.id)).toBeUndefined();
            expect(listContributionVersions(db, c.id)).toEqual([]);
            expect(getContributionTags(db, c.id)).toEqual([]);
            expect(listReviewEvents(db, c.id)).toEqual([]);
        });

        it('returns false when deleting a contribution that does not exist', () => {
            expect(deleteContribution(db, 'nope')).toBe(false);
        });

        it('cascades from a deleted developer down to their contributions and children', () => {
            const c = createContribution(db, newContribution());
            addContributionTag(db, c.id, 'sql');
            db.prepare('DELETE FROM developers WHERE id = ?').run('alice');
            expect(getContribution(db, c.id)).toBeUndefined();
            expect(getContributionTags(db, c.id)).toEqual([]);
        });
    });
});
