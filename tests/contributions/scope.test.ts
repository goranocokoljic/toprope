import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {makeTestDb} from '../dashboard/fixtures';
import {runMigrations} from '../../src/storage/migrator';
import {createContribution, listReviewEvents} from '../../src/contributions/store';
import {
    ScopeError,
    getHiddenContributionIdsForTeam,
    hideOrgItemForTeam,
    isHiddenForTeam,
    isInViewerScope,
    isVisibleToViewer,
    listHidesForContribution,
    listVisibleForViewer,
    resolveVisible,
    unhideOrgItemForTeam,
    type ScopedContribution,
} from '../../src/contributions/scope';
import type {NewContribution} from '../../src/contributions/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(name, T1);
}

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        T1,
    );
}

/** Create an org-wide contribution and return its id. */
function makeOrg(db: Database.Database, title: string, ts = T1): string {
    const input: NewContribution = {
        contentType: 'best_practice',
        title,
        authorId: 'alice',
        scope: 'org',
        scopeTarget: null,
        body: JSON.stringify({markdown: title}),
        timestamp: ts,
    };
    return createContribution(db, input).id;
}

/** Create a team-scoped contribution for `team` and return its id. */
function makeTeam(db: Database.Database, title: string, team: string, ts = T1): string {
    const input: NewContribution = {
        contentType: 'best_practice',
        title,
        authorId: 'alice',
        scope: 'team',
        scopeTarget: team,
        body: JSON.stringify({markdown: title}),
        timestamp: ts,
    };
    return createContribution(db, input).id;
}

// A small structural fixture for the pure resolvers (no DB needed).
const orgItem: ScopedContribution = {id: 'o1', scope: 'org', scopeTarget: null};
const engItem: ScopedContribution = {id: 't1', scope: 'team', scopeTarget: 'eng'};
const designItem: ScopedContribution = {id: 't2', scope: 'team', scopeTarget: 'design'};

describe('scope resolution — pure visibility rule (Task 6.1.4)', () => {
    describe('isInViewerScope', () => {
        it('org content is visible to every team', () => {
            expect(isInViewerScope(orgItem, 'eng')).toBe(true);
            expect(isInViewerScope(orgItem, 'design')).toBe(true);
        });

        it('org content is visible to a viewer with no team', () => {
            expect(isInViewerScope(orgItem, null)).toBe(true);
            expect(isInViewerScope(orgItem, undefined)).toBe(true);
        });

        it('team content is visible only to its own team', () => {
            expect(isInViewerScope(engItem, 'eng')).toBe(true);
            expect(isInViewerScope(engItem, 'design')).toBe(false);
        });

        it('team content is invisible to a teamless viewer', () => {
            expect(isInViewerScope(engItem, null)).toBe(false);
            expect(isInViewerScope(engItem, undefined)).toBe(false);
        });

        it('fail-closed: a team-scoped row with a null target is visible to no one', () => {
            const malformed: ScopedContribution = {id: 'x', scope: 'team', scopeTarget: null};
            expect(isInViewerScope(malformed, 'eng')).toBe(false);
            expect(isInViewerScope(malformed, null)).toBe(false);
        });
    });

    describe('isVisibleToViewer (with per-team hides)', () => {
        it('hides an org item for the viewer whose team hid it', () => {
            const hidden = new Set(['o1']);
            expect(isVisibleToViewer(orgItem, 'eng', hidden)).toBe(false);
        });

        it('a hide does not affect other teams', () => {
            const hiddenForEng = new Set(['o1']);
            // design viewer's hidden set would be empty; org item stays visible.
            expect(isVisibleToViewer(orgItem, 'design', new Set())).toBe(true);
            // even passing eng's set, the rule only matters for the team it was built for —
            // here we assert the org item is gone only when its id is in the set.
            expect(isVisibleToViewer(orgItem, 'eng', hiddenForEng)).toBe(false);
        });

        it('a hide never applies to a team-scoped item even if its id is in the set', () => {
            const hidden = new Set(['t1']);
            expect(isVisibleToViewer(engItem, 'eng', hidden)).toBe(true);
        });

        it('an empty hidden set leaves all in-scope content visible', () => {
            expect(isVisibleToViewer(orgItem, 'eng')).toBe(true);
            expect(isVisibleToViewer(engItem, 'eng')).toBe(true);
        });
    });

    describe('resolveVisible — org-only, team-only, and mixed sets', () => {
        it('org-only set: every viewer sees all of it', () => {
            const set = [orgItem, {id: 'o2', scope: 'org', scopeTarget: null} as ScopedContribution];
            expect(resolveVisible(set, 'eng').map((c) => c.id)).toEqual(['o1', 'o2']);
            expect(resolveVisible(set, 'design').map((c) => c.id)).toEqual(['o1', 'o2']);
            expect(resolveVisible(set, null).map((c) => c.id)).toEqual(['o1', 'o2']);
        });

        it('team-only set: a viewer sees only their own team rows', () => {
            const set = [engItem, designItem];
            expect(resolveVisible(set, 'eng').map((c) => c.id)).toEqual(['t1']);
            expect(resolveVisible(set, 'design').map((c) => c.id)).toEqual(['t2']);
            expect(resolveVisible(set, null)).toEqual([]);
        });

        it('mixed set: org rows for all, team rows only for the matching team, hides subtracted', () => {
            const set = [orgItem, engItem, designItem];
            // eng viewer: org + eng team, but not design
            expect(resolveVisible(set, 'eng').map((c) => c.id)).toEqual(['o1', 't1']);
            // design viewer with the org item hidden: only their team row remains
            expect(resolveVisible(set, 'design', new Set(['o1'])).map((c) => c.id)).toEqual(['t2']);
        });

        it('preserves input order', () => {
            const set = [designItem, orgItem, engItem];
            expect(resolveVisible(set, 'eng').map((c) => c.id)).toEqual(['o1', 't1']);
        });

        it('a viewer never sees content outside their scope', () => {
            const set = [engItem, designItem];
            // No matter the team, a viewer only ever gets rows whose scope admits them.
            for (const team of ['eng', 'design', 'other']) {
                for (const c of resolveVisible(set, team)) {
                    expect(isInViewerScope(c, team)).toBe(true);
                }
            }
        });
    });
});

describe('scope resolution — migration 034 (per-team hides)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => db.close());

    it('creates the contribution_team_hides table with the expected columns', () => {
        const cols = (db.prepare('PRAGMA table_info(contribution_team_hides)').all() as {name: string}[])
            .map((r) => r.name)
            .sort();
        expect(cols).toEqual(['contribution_id', 'hidden_at', 'hidden_by', 'team'].sort());
    });

    it('is idempotent — re-running migrations applies nothing new', () => {
        expect(runMigrations(db, MIGRATIONS_DIR)).toBe(0);
    });
});

describe('scope resolution — hide/unhide governance (Task 6.1.4)', () => {
    let db: Database.Database;
    let orgId: string;

    beforeEach(() => {
        db = makeTestDb();
        seedTeam(db, 'eng');
        seedTeam(db, 'design');
        seedDeveloper(db, 'alice', 'eng');
        orgId = makeOrg(db, 'Org practice');
    });

    afterEach(() => db.close());

    describe('hideOrgItemForTeam', () => {
        it('records a hide and a "hidden" audit event when permitted', () => {
            const changed = hideOrgItemForTeam(db, {
                contributionId: orgId,
                team: 'eng',
                actorId: 'alice',
                permitted: true,
                timestamp: T1,
            });
            expect(changed).toBe(true);
            expect(isHiddenForTeam(db, orgId, 'eng')).toBe(true);
            const events = listReviewEvents(db, orgId);
            expect(events.map((e) => e.event)).toContain('hidden');
            const hide = events.find((e) => e.event === 'hidden');
            expect(hide?.actorId).toBe('alice');
            expect(hide?.occurredAt).toBe(T1);
        });

        it('is rejected with not_permitted when hiding is not allowed — and writes nothing', () => {
            expect(() =>
                hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: false}),
            ).toThrow(ScopeError);
            try {
                hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: false});
            } catch (e) {
                expect((e as ScopeError).code).toBe('not_permitted');
            }
            // No row, no audit event was written.
            expect(isHiddenForTeam(db, orgId, 'eng')).toBe(false);
            expect(listReviewEvents(db, orgId)).toHaveLength(0);
        });

        it('is idempotent: a second hide is a no-op (no duplicate row or event)', () => {
            expect(hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: true})).toBe(
                true,
            );
            expect(hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: true})).toBe(
                false,
            );
            const hides = listReviewEvents(db, orgId).filter((e) => e.event === 'hidden');
            expect(hides).toHaveLength(1);
        });

        it('refuses to hide a team-scoped item (not_org_scoped)', () => {
            const teamId = makeTeam(db, 'Eng-only practice', 'eng');
            try {
                hideOrgItemForTeam(db, {contributionId: teamId, team: 'eng', actorId: 'alice', permitted: true});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ScopeError).code).toBe('not_org_scoped');
            }
        });

        it('throws not_found for an unknown contribution', () => {
            try {
                hideOrgItemForTeam(db, {contributionId: 'nope', team: 'eng', actorId: 'alice', permitted: true});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ScopeError).code).toBe('not_found');
            }
        });

        it('rejects a blank actor and a blank team before touching permission', () => {
            try {
                hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: '  ', permitted: true});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ScopeError).code).toBe('invalid_actor');
            }
            try {
                hideOrgItemForTeam(db, {contributionId: orgId, team: '', actorId: 'alice', permitted: true});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ScopeError).code).toBe('invalid_team');
            }
        });

        it('hides per-team only — another team still sees the org item', () => {
            hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: true});
            expect(getHiddenContributionIdsForTeam(db, 'eng').has(orgId)).toBe(true);
            expect(getHiddenContributionIdsForTeam(db, 'design').has(orgId)).toBe(false);
            // isHiddenForTeam discriminates by team too: hidden for eng, not for design.
            expect(isHiddenForTeam(db, orgId, 'eng')).toBe(true);
            expect(isHiddenForTeam(db, orgId, 'design')).toBe(false);
        });

        it('getHiddenContributionIdsForTeam is self-defending: a stray team-scoped hide row is excluded', () => {
            // The mutation path forbids hiding a team item, so force the only way a
            // non-org hide could exist — a raw insert — and assert the accessor's
            // JOIN to scope = 'org' keeps it out of the hidden set (so a direct
            // consumer can never treat it as a meaningful hide).
            const teamId = makeTeam(db, 'Eng-only practice', 'eng');
            db.prepare(
                `INSERT INTO contribution_team_hides (contribution_id, team, hidden_by, hidden_at)
                 VALUES (?, ?, ?, ?)`,
            ).run(teamId, 'eng', 'alice', T1);
            expect(getHiddenContributionIdsForTeam(db, 'eng').has(teamId)).toBe(false);
        });
    });

    describe('unhideOrgItemForTeam', () => {
        it('removes the hide and records an "unhidden" event — without needing permission', () => {
            hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: true});
            // No `permitted` flag here: un-hide restores the default and is never gated.
            const changed = unhideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', timestamp: T2});
            expect(changed).toBe(true);
            expect(isHiddenForTeam(db, orgId, 'eng')).toBe(false);
            expect(listReviewEvents(db, orgId).map((e) => e.event)).toContain('unhidden');
        });

        it('is a no-op (false) when there was nothing hidden', () => {
            expect(unhideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice'})).toBe(false);
            expect(listReviewEvents(db, orgId).filter((e) => e.event === 'unhidden')).toHaveLength(0);
        });

        it('rejects a blank actor', () => {
            try {
                unhideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: ''});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ScopeError).code).toBe('invalid_actor');
            }
        });
    });

    describe('listHidesForContribution', () => {
        it('lists every team that hid the item', () => {
            hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: true, timestamp: T1});
            hideOrgItemForTeam(db, {contributionId: orgId, team: 'design', actorId: 'alice', permitted: true, timestamp: T2});
            const hides = listHidesForContribution(db, orgId);
            expect(hides.map((h) => h.team).sort()).toEqual(['design', 'eng']);
            expect(hides.every((h) => h.contributionId === orgId)).toBe(true);
            // Ordering is newest-first (hidden_at DESC): design (T2) before eng (T1).
            expect(hides.map((h) => h.team)).toEqual(['design', 'eng']);
        });
    });
});

describe('scope resolution — listVisibleForViewer (DB-backed) (Task 6.1.4)', () => {
    let db: Database.Database;
    let orgId: string;
    let engId: string;
    let designId: string;

    beforeEach(() => {
        db = makeTestDb();
        seedTeam(db, 'eng');
        seedTeam(db, 'design');
        seedDeveloper(db, 'alice', 'eng');
        orgId = makeOrg(db, 'Org practice', T1);
        engId = makeTeam(db, 'Eng practice', 'eng', T2);
        designId = makeTeam(db, 'Design practice', 'design', T2);
    });

    afterEach(() => db.close());

    it('an eng viewer sees the org item and the eng item, never the design item', () => {
        const ids = listVisibleForViewer(db, 'eng').map((c) => c.id);
        expect(ids).toContain(orgId);
        expect(ids).toContain(engId);
        expect(ids).not.toContain(designId);
    });

    it('a teamless viewer sees only org content', () => {
        const ids = listVisibleForViewer(db, null).map((c) => c.id);
        expect(ids).toEqual([orgId]);
    });

    it('subtracts a per-team hide when hides are permitted', () => {
        hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: true});
        const ids = listVisibleForViewer(db, 'eng', {hidesPermitted: true}).map((c) => c.id);
        expect(ids).not.toContain(orgId);
        expect(ids).toContain(engId);
        // The hide is per-team: a design viewer still sees the org item.
        expect(listVisibleForViewer(db, 'design').map((c) => c.id)).toContain(orgId);
    });

    it('ignores stored hides when hiding is not permitted (override stops being honored)', () => {
        hideOrgItemForTeam(db, {contributionId: orgId, team: 'eng', actorId: 'alice', permitted: true});
        const ids = listVisibleForViewer(db, 'eng', {hidesPermitted: false}).map((c) => c.id);
        expect(ids).toContain(orgId);
    });

    it('composes a store filter (state) with scope resolution', () => {
        // Only the org item is published; the eng item stays draft.
        db.prepare("UPDATE contributions SET state = 'published' WHERE id = ?").run(orgId);
        const ids = listVisibleForViewer(db, 'eng', {filters: {state: 'published'}}).map((c) => c.id);
        expect(ids).toEqual([orgId]);
    });
});
