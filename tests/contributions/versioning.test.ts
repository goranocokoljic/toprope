import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {createContribution, getContribution, listReviewEvents, updateContributionState} from '../../src/contributions/store';
import {
    editContribution,
    getCurrentVersion,
    getVersionHistory,
    revertToVersion,
    VersioningError,
} from '../../src/contributions/versioning';
import type {NewContribution} from '../../src/contributions/types';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';
const T3 = '2026-06-22T00:00:00.000Z';
const T4 = '2026-06-23T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        T1,
    );
}

function body(text: string): string {
    return JSON.stringify({markdown: text});
}

function newContribution(overrides: Partial<NewContribution> = {}): NewContribution {
    return {
        contentType: 'best_practice',
        title: 'Use prepared statements',
        authorId: 'alice',
        scope: 'team',
        scopeTarget: 'eng',
        body: body('v1: parameterize queries'),
        changeNote: 'initial draft',
        timestamp: T1,
        ...overrides,
    };
}

/** Create a contribution, publish it (mechanically), and return its id. */
function makePublished(db: Database.Database, overrides: Partial<NewContribution> = {}): string {
    const id = createContribution(db, newContribution(overrides)).id;
    updateContributionState(db, id, 'published', T1);
    return id;
}

describe('contribution versioning (Task 6.1.3)', () => {
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

    // --- AC1: Editing published content creates a new version, increments current_version
    describe('editContribution', () => {
        it('appends a new version of published content and advances current_version', () => {
            const id = makePublished(db);
            expect(getContribution(db, id)!.currentVersion).toBe(1);

            const v2 = editContribution(db, id, {actorId: 'bob', body: body('v2: also use ORMs carefully'), changeNote: 'expand', timestamp: T2});

            expect(v2.version).toBe(2);
            expect(v2.authorId).toBe('bob');
            expect(v2.changeNote).toBe('expand');
            expect(v2.createdAt).toBe(T2);
            expect(v2.body).toBe(body('v2: also use ORMs carefully'));
            // current_version now points at the new version
            expect(getContribution(db, id)!.currentVersion).toBe(2);
        });

        it('keeps the contribution published (editing is not a lifecycle transition)', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            expect(getContribution(db, id)!.state).toBe('published');
        });

        it('does not move a submitted contribution or write a review event (governance boundary)', () => {
            // An edit is a content change, not a lifecycle transition: it must leave the
            // state at 'submitted' and add no review event, so it neither advances nor
            // disturbs the review gate. The duty to re-gate after an edit belongs to the
            // consuming feature, not this primitive.
            const id = createContribution(db, newContribution()).id;
            updateContributionState(db, id, 'submitted', T1);
            editContribution(db, id, {actorId: 'bob', body: body('v2: edited after submit'), timestamp: T2});
            expect(getContribution(db, id)!.state).toBe('submitted');
            expect(listReviewEvents(db, id)).toHaveLength(0);
            // the edit did land as a new version
            expect(getCurrentVersion(db, id)!.body).toBe(body('v2: edited after submit'));
        });

        it('works on a draft too — each edit advances the head through the chain', () => {
            const id = createContribution(db, newContribution()).id; // draft, v1
            const v2 = editContribution(db, id, {actorId: 'alice', body: body('v2'), timestamp: T2});
            const v3 = editContribution(db, id, {actorId: 'alice', body: body('v3'), timestamp: T3});
            expect([v2.version, v3.version]).toEqual([2, 3]);
            expect(getContribution(db, id)!.currentVersion).toBe(3);
        });

        it('defaults a missing change note to null', () => {
            const id = makePublished(db);
            const v2 = editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            expect(v2.changeNote).toBeNull();
        });

        it('rejects a blank actor', () => {
            const id = makePublished(db);
            expect(() => editContribution(db, id, {actorId: '   ', body: body('v2')})).toThrowError(VersioningError);
            try {
                editContribution(db, id, {actorId: '', body: body('v2')});
            } catch (e) {
                expect((e as VersioningError).code).toBe('invalid_actor');
            }
            // nothing was appended — assert the chain itself, not just the head pointer
            expect(getContribution(db, id)!.currentVersion).toBe(1);
            expect(getVersionHistory(db, id)).toHaveLength(1);
        });

        it('rejects an empty body', () => {
            const id = makePublished(db);
            try {
                editContribution(db, id, {actorId: 'bob', body: ''});
                expect.unreachable('empty body must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('empty_body');
            }
            expect(getContribution(db, id)!.currentVersion).toBe(1);
            expect(getVersionHistory(db, id)).toHaveLength(1);
        });

        it('rejects a whitespace-only body (not just the literal empty string)', () => {
            const id = makePublished(db);
            for (const blank of ['   ', '\n', '\t']) {
                try {
                    editContribution(db, id, {actorId: 'bob', body: blank});
                    expect.unreachable(`whitespace-only body ${JSON.stringify(blank)} must throw`);
                } catch (e) {
                    expect((e as VersioningError).code).toBe('empty_body');
                }
            }
            // no blank version laundered into the append-only lineage
            expect(getVersionHistory(db, id)).toHaveLength(1);
        });

        it('throws not_found for an unknown contribution', () => {
            try {
                editContribution(db, 'does-not-exist', {actorId: 'bob', body: body('v2')});
                expect.unreachable('unknown contribution must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('not_found');
            }
        });

        it('refuses to version a removed contribution', () => {
            const id = makePublished(db);
            updateContributionState(db, id, 'removed', T2);
            try {
                editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T3});
                expect.unreachable('removed contribution must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('contribution_removed');
            }
            // no version was appended to the tombstone
            expect(getVersionHistory(db, id)).toHaveLength(1);
        });
    });

    // --- AC2: All prior versions retained and viewable
    describe('getVersionHistory', () => {
        it('returns every version oldest-first after several edits', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            editContribution(db, id, {actorId: 'alice', body: body('v3'), timestamp: T3});

            const history = getVersionHistory(db, id);
            expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
            expect(history.map((v) => v.body)).toEqual([body('v1: parameterize queries'), body('v2'), body('v3')]);
            expect(history.map((v) => v.authorId)).toEqual(['alice', 'bob', 'alice']);
        });

        it('returns the single v1 for a freshly created contribution', () => {
            const id = createContribution(db, newContribution()).id;
            expect(getVersionHistory(db, id).map((v) => v.version)).toEqual([1]);
        });

        it('returns an empty array for an unknown contribution', () => {
            expect(getVersionHistory(db, 'nope')).toEqual([]);
        });
    });

    // --- AC3: Revert produces a new version (history preserved, not rewritten)
    describe('revertToVersion', () => {
        it('creates a new version equal to the old body without destroying history', () => {
            const id = makePublished(db); // v1 = 'v1: parameterize queries'
            editContribution(db, id, {actorId: 'bob', body: body('v2: rewrite'), timestamp: T2});
            expect(getContribution(db, id)!.currentVersion).toBe(2);

            const reverted = revertToVersion(db, id, 1, {actorId: 'alice', timestamp: T3});

            // a NEW version (v3) whose body equals v1
            expect(reverted.version).toBe(3);
            expect(reverted.body).toBe(body('v1: parameterize queries'));
            expect(reverted.authorId).toBe('alice');
            expect(reverted.changeNote).toBe('Reverted to version 1');
            expect(getContribution(db, id)!.currentVersion).toBe(3);

            // history is preserved, not rewritten: v1 and v2 are untouched, chain grew
            const history = getVersionHistory(db, id);
            expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
            expect(history.map((v) => v.body)).toEqual([
                body('v1: parameterize queries'),
                body('v2: rewrite'),
                body('v1: parameterize queries'),
            ]);
        });

        it('serves the reverted body as the current version (default read)', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2: rewrite'), timestamp: T2});
            revertToVersion(db, id, 1, {actorId: 'alice', timestamp: T3});
            expect(getCurrentVersion(db, id)!.body).toBe(body('v1: parameterize queries'));
        });

        it('honors a custom change note', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            const reverted = revertToVersion(db, id, 1, {actorId: 'alice', changeNote: 'roll back regression', timestamp: T3});
            expect(reverted.changeNote).toBe('roll back regression');
        });

        it('allows reverting to the current version as a no-content-change checkpoint', () => {
            const id = makePublished(db); // v1
            const reverted = revertToVersion(db, id, 1, {actorId: 'bob', timestamp: T2});
            expect(reverted.version).toBe(2);
            expect(reverted.body).toBe(body('v1: parameterize queries'));
            expect(getVersionHistory(db, id).map((v) => v.version)).toEqual([1, 2]);
        });

        it('can revert again to an earlier revert target (chain keeps growing)', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            revertToVersion(db, id, 1, {actorId: 'alice', timestamp: T3}); // v3 == v1
            const second = revertToVersion(db, id, 2, {actorId: 'bob', timestamp: T4}); // v4 == v2
            expect(second.version).toBe(4);
            expect(second.body).toBe(body('v2'));
            expect(getVersionHistory(db, id).map((v) => v.version)).toEqual([1, 2, 3, 4]);
        });

        it('throws version_not_found for a target version that does not exist', () => {
            const id = makePublished(db);
            try {
                revertToVersion(db, id, 99, {actorId: 'alice', timestamp: T2});
                expect.unreachable('missing target version must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('version_not_found');
            }
            // no new version was created — prove the chain is untouched in length AND
            // content, not just the head pointer (a revert that mutated before validating
            // the target would slip past a length-only check)
            expect(getContribution(db, id)!.currentVersion).toBe(1);
            const history = getVersionHistory(db, id);
            expect(history).toHaveLength(1);
            expect(history[0].body).toBe(body('v1: parameterize queries'));
        });

        it('refuses to revert to a store-created empty version (empty_body, both paths agree)', () => {
            // The store permits an empty v1; reverting to it must not re-promote a blank
            // body to current, mirroring editContribution's empty-body guard.
            const id = createContribution(db, newContribution({body: ''})).id;
            editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            try {
                revertToVersion(db, id, 1, {actorId: 'alice', timestamp: T3});
                expect.unreachable('reverting to an empty body must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('empty_body');
            }
            // current stays at the non-empty v2; nothing appended
            expect(getContribution(db, id)!.currentVersion).toBe(2);
            expect(getVersionHistory(db, id)).toHaveLength(2);
        });

        it('reports contribution_removed (not version_not_found) when a removed item also has a bad target', () => {
            // Guard ordering: the removed-tombstone check runs before the target lookup,
            // so a removed contribution fails closed regardless of the target version.
            const id = makePublished(db);
            updateContributionState(db, id, 'removed', T2);
            try {
                revertToVersion(db, id, 99, {actorId: 'alice', timestamp: T3});
                expect.unreachable('removed contribution must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('contribution_removed');
            }
        });

        it('throws not_found for an unknown contribution', () => {
            try {
                revertToVersion(db, 'nope', 1, {actorId: 'alice'});
                expect.unreachable('unknown contribution must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('not_found');
            }
        });

        it('rejects a blank actor before touching history', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            try {
                revertToVersion(db, id, 1, {actorId: ''});
                expect.unreachable('blank actor must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('invalid_actor');
            }
            expect(getContribution(db, id)!.currentVersion).toBe(2);
        });

        it('refuses to revert a removed contribution', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2'), timestamp: T2});
            updateContributionState(db, id, 'removed', T3);
            try {
                revertToVersion(db, id, 1, {actorId: 'alice', timestamp: T4});
                expect.unreachable('removed contribution must throw');
            } catch (e) {
                expect((e as VersioningError).code).toBe('contribution_removed');
            }
            expect(getVersionHistory(db, id)).toHaveLength(2);
        });
    });

    // --- AC4: Default reads serve the current version
    describe('getCurrentVersion', () => {
        it('serves the latest version after edits', () => {
            const id = makePublished(db);
            editContribution(db, id, {actorId: 'bob', body: body('v2: newest'), timestamp: T2});
            const current = getCurrentVersion(db, id);
            expect(current!.version).toBe(2);
            expect(current!.body).toBe(body('v2: newest'));
        });

        it('returns undefined for an unknown contribution', () => {
            expect(getCurrentVersion(db, 'nope')).toBeUndefined();
        });
    });
});
