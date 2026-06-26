import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {createContribution, getContribution, listReviewEvents} from '../../src/contributions/store';
import {
    approveAsDeveloper,
    draftSelfPublish,
    publishShowcase,
    ShowcasePublishError,
    submitForReview,
} from '../../src/showcase/publishPaths';
import {confirmManualReview} from '../../src/showcase/manualReview';
import {
    isShowcaseInTeam,
    listShowcaseRemovalsForAuthor,
    removeShowcaseAsLead,
    unpublishOwnShowcase,
    UnitGovernanceError,
} from '../../src/showcase/unitGovernance';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const ALICE = 'alice'; // eng
const BOB = 'bob'; // data
const LEAD = 'lead-user-id'; // the acting lead's user id (recorded as actor)

const CONVERSATION = '[{"id":"t0","role":"user","text":"hi"},{"id":"t1","role":"assistant","text":"yo"}]';

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        '2026-06-20T00:00:00.000Z',
    );
}

interface PublishOpts {
    developerId?: string;
    title?: string;
    scope?: 'org' | 'team';
    scopeTarget?: string | null;
    timestamp?: string;
}

/** Publish a showcase through the real flow and return its id. */
function publishShowcaseFixture(db: Database.Database, opts: PublishOpts = {}): string {
    const developerId = opts.developerId ?? ALICE;
    const scope = opts.scope ?? 'org';
    const {contribution} = draftSelfPublish(db, {
        developerId,
        title: opts.title ?? 'Session',
        conversation: CONVERSATION,
        curatorsNote: 'note',
        scope,
        scopeTarget: opts.scopeTarget ?? null,
        timestamp: opts.timestamp,
    });
    submitForReview(db, {contributionId: contribution.id, actorId: developerId});
    approveAsDeveloper(db, {contributionId: contribution.id, developerId, visibilityScope: scope});
    confirmManualReview(db, {contributionId: contribution.id, actorId: developerId});
    publishShowcase(db, {contributionId: contribution.id, actorId: developerId});
    return contribution.id;
}

function eventTypes(db: Database.Database, id: string): string[] {
    return listReviewEvents(db, id).map((e) => e.event);
}

describe('showcase unit governance (6.3.9 / #172)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run('eng', '2026-06-20T00:00:00.000Z');
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run('data', '2026-06-20T00:00:00.000Z');
        seedDeveloper(db, ALICE, 'eng');
        seedDeveloper(db, BOB, 'data');
    });

    afterEach(() => {
        db.close();
    });

    // --- AC: owner unpublish works ------------------------------------------

    it('the author unpublishes their own showcase (published → unpublished, logged)', () => {
        const id = publishShowcaseFixture(db, {developerId: ALICE});
        const updated = unpublishOwnShowcase(db, {showcaseId: id, developerId: ALICE});
        expect(updated.state).toBe('unpublished');
        expect(eventTypes(db, id)).toContain('unpublished');
    });

    it('a non-author cannot unpublish someone else’s showcase', () => {
        const id = publishShowcaseFixture(db, {developerId: ALICE});
        expect(() => unpublishOwnShowcase(db, {showcaseId: id, developerId: BOB})).toThrow(UnitGovernanceError);
        try {
            unpublishOwnShowcase(db, {showcaseId: id, developerId: BOB});
        } catch (err) {
            expect((err as UnitGovernanceError).code).toBe('not_author');
        }
        // Untouched.
        expect(getContribution(db, id)?.state).toBe('published');
    });

    it('unpublishing an already-unpublished showcase is rejected (cannot resurrect/double-act)', () => {
        const id = publishShowcaseFixture(db, {developerId: ALICE});
        unpublishOwnShowcase(db, {showcaseId: id, developerId: ALICE});
        try {
            unpublishOwnShowcase(db, {showcaseId: id, developerId: ALICE});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as UnitGovernanceError).code).toBe('not_published');
        }
    });

    it('unpublish rejects a non-showcase id and a missing id', () => {
        const practice = createContribution(db, {
            contentType: 'best_practice',
            title: 'p',
            authorId: ALICE,
            scope: 'org',
            scopeTarget: null,
            state: 'published',
            body: '{}',
        });
        try {
            unpublishOwnShowcase(db, {showcaseId: practice.id, developerId: ALICE});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as UnitGovernanceError).code).toBe('not_a_showcase');
        }
        try {
            unpublishOwnShowcase(db, {showcaseId: 'nope', developerId: ALICE});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as UnitGovernanceError).code).toBe('not_found');
        }
    });

    // --- AC: lead remove works (scoped to their team) -----------------------

    it('a lead removes a team-scoped showcase from their own team (→ removed, logged)', () => {
        const id = publishShowcaseFixture(db, {developerId: ALICE, scope: 'team', scopeTarget: 'eng'});
        const removed = removeShowcaseAsLead(db, {
            showcaseId: id,
            team: 'eng',
            removedByUserId: LEAD,
            reason: 'off-topic',
        });
        expect(removed.state).toBe('removed');
        const events = listReviewEvents(db, id).filter((e) => e.event === 'removed');
        expect(events).toHaveLength(1);
        expect(events[0].actorId).toBe(LEAD);
        expect(events[0].note).toBe('off-topic');
    });

    it('a lead can remove an org-wide showcase contributed by a member of their team', () => {
        // org-scoped, authored by alice (eng) → in eng's gallery via author membership.
        const id = publishShowcaseFixture(db, {developerId: ALICE, scope: 'org'});
        expect(isShowcaseInTeam(db, getContribution(db, id)!, 'eng')).toBe(true);
        const removed = removeShowcaseAsLead(db, {showcaseId: id, team: 'eng', removedByUserId: LEAD, reason: null});
        expect(removed.state).toBe('removed');
    });

    it('a lead cannot remove a showcase outside their team', () => {
        // team-scoped to data, authored by bob (data) — not in eng's gallery at all.
        const id = publishShowcaseFixture(db, {developerId: BOB, scope: 'team', scopeTarget: 'data'});
        try {
            removeShowcaseAsLead(db, {showcaseId: id, team: 'eng', removedByUserId: LEAD, reason: null});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as UnitGovernanceError).code).toBe('not_team_showcase');
        }
        expect(getContribution(db, id)?.state).toBe('published');
    });

    it('removing a draft showcase is rejected (it was never in a gallery)', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: ALICE,
            title: 'draft',
            conversation: CONVERSATION,
            curatorsNote: 'note',
            scope: 'team',
            scopeTarget: 'eng',
        });
        try {
            removeShowcaseAsLead(db, {showcaseId: contribution.id, team: 'eng', removedByUserId: LEAD, reason: null});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as UnitGovernanceError).code).toBe('not_removable');
        }
    });

    it('a removed showcase is terminal — it cannot be removed again', () => {
        const id = publishShowcaseFixture(db, {developerId: ALICE, scope: 'team', scopeTarget: 'eng'});
        removeShowcaseAsLead(db, {showcaseId: id, team: 'eng', removedByUserId: LEAD, reason: null});
        try {
            removeShowcaseAsLead(db, {showcaseId: id, team: 'eng', removedByUserId: LEAD, reason: null});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as UnitGovernanceError).code).toBe('not_removable');
        }
    });

    it('a lead can remove an unpublished showcase (still in/recently in the gallery)', () => {
        const id = publishShowcaseFixture(db, {developerId: ALICE, scope: 'team', scopeTarget: 'eng'});
        unpublishOwnShowcase(db, {showcaseId: id, developerId: ALICE});
        const removed = removeShowcaseAsLead(db, {showcaseId: id, team: 'eng', removedByUserId: LEAD, reason: null});
        expect(removed.state).toBe('removed');
    });

    // --- AC: lead CANNOT publish on a developer's behalf (carry Phase 5) -----

    it('a non-author (e.g. a manager) cannot satisfy the consent gate — publish stays blocked', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: ALICE,
            title: 'joint?',
            conversation: CONVERSATION,
            curatorsNote: 'note',
            scope: 'org',
        });
        submitForReview(db, {contributionId: contribution.id, actorId: ALICE});
        // The manager/lead is NOT the author — their "approval" is refused.
        expect(() =>
            approveAsDeveloper(db, {contributionId: contribution.id, developerId: BOB, visibilityScope: 'org'}),
        ).toThrow(ShowcasePublishError);
        // With no developer approval, publish cannot proceed.
        expect(() => publishShowcase(db, {contributionId: contribution.id, actorId: BOB})).toThrow();
        expect(getContribution(db, contribution.id)?.state).toBe('submitted');
    });

    // --- AC: removal logged + author notified -------------------------------

    it('the author’s removal feed surfaces lead removals, newest first, author-scoped', () => {
        const a1 = publishShowcaseFixture(db, {
            developerId: ALICE,
            title: 'A first',
            scope: 'team',
            scopeTarget: 'eng',
            timestamp: '2026-06-20T00:00:00.000Z',
        });
        const a2 = publishShowcaseFixture(db, {
            developerId: ALICE,
            title: 'A second',
            scope: 'team',
            scopeTarget: 'eng',
            timestamp: '2026-06-21T00:00:00.000Z',
        });
        const bobShowcase = publishShowcaseFixture(db, {
            developerId: BOB,
            title: 'Bobs',
            scope: 'team',
            scopeTarget: 'data',
        });

        removeShowcaseAsLead(db, {showcaseId: a1, team: 'eng', removedByUserId: LEAD, reason: 'r1'});
        // Pin explicit, distinct removal timestamps so the newest-first ordering is
        // deterministic regardless of wall-clock resolution between the two calls.
        db.prepare("UPDATE contribution_review_events SET occurred_at = ? WHERE contribution_id = ? AND event = 'removed'").run(
            '2026-06-25T00:00:00.000Z',
            a1,
        );
        removeShowcaseAsLead(db, {showcaseId: a2, team: 'eng', removedByUserId: LEAD, reason: 'r2'});
        db.prepare("UPDATE contribution_review_events SET occurred_at = ? WHERE contribution_id = ? AND event = 'removed'").run(
            '2026-06-26T00:00:00.000Z',
            a2,
        );
        removeShowcaseAsLead(db, {showcaseId: bobShowcase, team: 'data', removedByUserId: LEAD, reason: 'rb'});

        const feed = listShowcaseRemovalsForAuthor(db, ALICE);
        // Author-scoped: bob's removal is NOT in alice's feed.
        expect(feed.map((n) => n.showcaseId)).toEqual([a2, a1]); // newest first
        expect(feed[0]).toMatchObject({title: 'A second', removedBy: LEAD, reason: 'r2'});
        expect(feed[1]).toMatchObject({title: 'A first', removedBy: LEAD, reason: 'r1'});

        // Bob's feed has only his own.
        expect(listShowcaseRemovalsForAuthor(db, BOB).map((n) => n.showcaseId)).toEqual([bobShowcase]);
    });

    it('a never-removed showcase produces no removal notice', () => {
        publishShowcaseFixture(db, {developerId: ALICE});
        expect(listShowcaseRemovalsForAuthor(db, ALICE)).toEqual([]);
    });
});
