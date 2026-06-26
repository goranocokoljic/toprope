import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {getContribution} from '../../src/contributions/store';
import {hideOrgItemForTeam} from '../../src/contributions/scope';
import {
    approveAsDeveloper,
    draftSelfPublish,
    publishShowcase,
    submitForReview,
} from '../../src/showcase/publishPaths';
import {addShowcaseAnnotation} from '../../src/showcase/annotations';
import {confirmManualReview} from '../../src/showcase/manualReview';
import {linkShowcaseToPractice} from '../../src/showcase/crossLink';
import {createContribution} from '../../src/contributions/store';
import {browseShowcases, getShowcaseDetail, isShowcaseVisibleToViewer} from '../../src/showcase/browse';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const ALICE = 'alice';
const BOB = 'bob';

// A two-turn conversation; turn ids let annotations anchor by id.
const CONVERSATION = '[{"id":"t0","role":"user","text":"how do I refactor"},{"id":"t1","role":"assistant","text":"write a test first"}]';

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
    outcomeLink?: string | null;
    aiAnnotation?: string | null;
    annotation?: {turnRef: string; body: string};
    timestamp?: string;
}

/**
 * Drive a showcase all the way to `published` through the REAL publish flow (draft →
 * annotate → submit → developer-approve → manual-review → publish), so the FTS index,
 * the unit payload, and the consent/review gates are all exercised exactly as in
 * production rather than hand-inserted.
 */
function publishShowcaseFixture(db: Database.Database, opts: PublishOpts = {}): string {
    const developerId = opts.developerId ?? ALICE;
    const scope = opts.scope ?? 'org';
    const {contribution} = draftSelfPublish(db, {
        developerId,
        title: opts.title ?? 'Refactor with tests',
        conversation: CONVERSATION,
        curatorsNote: 'Take away: drive the refactor from a failing test.',
        scope,
        scopeTarget: opts.scopeTarget ?? null,
        outcomeLink: opts.outcomeLink ?? null,
        aiAnnotation: opts.aiAnnotation ?? null,
        timestamp: opts.timestamp,
    });
    if (opts.annotation) {
        addShowcaseAnnotation(db, {
            contributionId: contribution.id,
            authorId: developerId,
            turnRef: opts.annotation.turnRef,
            body: opts.annotation.body,
        });
    }
    submitForReview(db, {contributionId: contribution.id, actorId: developerId});
    approveAsDeveloper(db, {
        contributionId: contribution.id,
        developerId,
        visibilityScope: scope,
    });
    confirmManualReview(db, {contributionId: contribution.id, actorId: developerId});
    const published = publishShowcase(db, {contributionId: contribution.id, actorId: developerId});
    expect(published.state).toBe('published');
    return contribution.id;
}

describe('showcase browse + detail service (6.3.9 / #172)', () => {
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

    // --- AC: gallery browse/search/filter works within scope ----------------

    it('lists published showcases the viewer may see, newest first', () => {
        publishShowcaseFixture(db, {title: 'First', timestamp: '2026-06-20T00:00:00.000Z'});
        publishShowcaseFixture(db, {title: 'Second', timestamp: '2026-06-22T00:00:00.000Z'});

        const list = browseShowcases(db, 'eng');
        expect(list.map((s) => s.title)).toEqual(['Second', 'First']);
    });

    it('omits non-published showcases from the gallery', () => {
        // A draft that never reaches published must not appear.
        draftSelfPublish(db, {
            developerId: ALICE,
            title: 'Still a draft',
            conversation: CONVERSATION,
            curatorsNote: 'note',
            scope: 'org',
        });
        publishShowcaseFixture(db, {title: 'Published one'});

        expect(browseShowcases(db, 'eng').map((s) => s.title)).toEqual(['Published one']);
    });

    it('a free-text query filters the gallery (drives the real FTS MATCH)', () => {
        publishShowcaseFixture(db, {title: 'Churn reduction walkthrough'});
        publishShowcaseFixture(db, {title: 'Prompt tightening session'});

        const hits = browseShowcases(db, 'eng', {text: 'churn'});
        expect(hits.map((s) => s.title)).toEqual(['Churn reduction walkthrough']);
    });

    it('the scope filter narrows to org or team', () => {
        publishShowcaseFixture(db, {title: 'Org one', scope: 'org'});
        publishShowcaseFixture(db, {title: 'Eng one', scope: 'team', scopeTarget: 'eng'});

        expect(browseShowcases(db, 'eng', {scope: 'org'}).map((s) => s.title)).toEqual(['Org one']);
        expect(browseShowcases(db, 'eng', {scope: 'team'}).map((s) => s.title)).toEqual(['Eng one']);
    });

    it('enforces viewer scope: a team-scoped showcase never leaks to another team', () => {
        publishShowcaseFixture(db, {title: 'Eng only', scope: 'team', scopeTarget: 'eng'});

        // Positive control: the eng viewer sees it.
        expect(browseShowcases(db, 'eng').map((s) => s.title)).toEqual(['Eng only']);
        // The data-team viewer does NOT.
        expect(browseShowcases(db, 'data')).toEqual([]);
        // A teamless viewer sees only org content — nothing here.
        expect(browseShowcases(db, null)).toEqual([]);
    });

    it('the team filter cannot widen past the viewer scope', () => {
        publishShowcaseFixture(db, {title: 'Data only', scope: 'team', scopeTarget: 'data', developerId: BOB});
        // An eng viewer asking for team=data still sees nothing — the scope tail wins.
        expect(browseShowcases(db, 'eng', {team: 'data'})).toEqual([]);
    });

    it('respects per-team hides of an org showcase', () => {
        const id = publishShowcaseFixture(db, {title: 'Hidden org tip', scope: 'org'});
        hideOrgItemForTeam(db, {contributionId: id, team: 'eng', actorId: 'lead', permitted: true});

        // Hidden for eng, still visible to data.
        expect(browseShowcases(db, 'eng')).toEqual([]);
        expect(browseShowcases(db, 'data').map((s) => s.title)).toEqual(['Hidden org tip']);
    });

    it('the limit caps the gallery size', () => {
        for (let i = 0; i < 3; i++) {
            publishShowcaseFixture(db, {title: `S${i}`, timestamp: `2026-06-2${i}T00:00:00.000Z`});
        }
        expect(browseShowcases(db, 'eng', {limit: 2})).toHaveLength(2);
    });

    it('summarises provenance + heft on each card', () => {
        const id = publishShowcaseFixture(db, {
            title: 'Annotated',
            outcomeLink: 'https://example/pr/1',
            annotation: {turnRef: 't1', body: 'this is the key move'},
        });
        const [card] = browseShowcases(db, 'eng');
        expect(card.id).toBe(id);
        expect(card.publishPath).toBe('self_publish');
        expect(card.hasOutcomeLink).toBe(true);
        expect(card.annotationCount).toBe(1);
        expect(card.authorName).toBe('alice Dev');
    });

    // --- AC: detail view renders all unit components -------------------------

    it('assembles the full unit detail: note, outcome, annotated turns, cross-links', () => {
        const practice = createContribution(db, {
            contentType: 'best_practice',
            title: 'Test-first',
            authorId: ALICE,
            scope: 'org',
            scopeTarget: null,
            state: 'published',
            body: '{}',
        });
        const id = publishShowcaseFixture(db, {
            title: 'Great session',
            outcomeLink: 'https://example/pr/9',
            annotation: {turnRef: 't1', body: 'notice the test-first move'},
        });
        linkShowcaseToPractice(db, id, practice.id);

        const detail = getShowcaseDetail(db, 'eng', ALICE, id);
        expect(detail).toBeDefined();
        expect(detail!.curatorsNote).toContain('failing test');
        expect(detail!.outcomeLink).toBe('https://example/pr/9');
        expect(detail!.hasOutcomeLink).toBe(true);
        // The annotated conversation body is present, with the annotation beside its turn.
        const annotated = detail!.display.turns.flatMap((t) => t.annotations.map((a) => a.body));
        expect(annotated).toContain('notice the test-first move');
        // The clearly-AI annotation slot is always present, marked not-present here.
        expect(detail!.aiAnnotation.present).toBe(false);
        // The cross-linked practice surfaces.
        expect(detail!.practices.map((p) => p.title)).toEqual(['Test-first']);
        // The author may unpublish their own.
        expect(detail!.canUnpublish).toBe(true);
    });

    it('canUnpublish is false for a non-author viewer', () => {
        const id = publishShowcaseFixture(db, {title: 'Org tip', scope: 'org', developerId: ALICE});
        const detail = getShowcaseDetail(db, 'data', BOB, id);
        expect(detail).toBeDefined();
        expect(detail!.canUnpublish).toBe(false);
    });

    it('detail is a uniform 404 (undefined) for an out-of-scope showcase', () => {
        const id = publishShowcaseFixture(db, {title: 'Eng only', scope: 'team', scopeTarget: 'eng'});
        // The data viewer cannot read it — indistinguishable from missing.
        expect(getShowcaseDetail(db, 'data', BOB, id)).toBeUndefined();
        expect(isShowcaseVisibleToViewer(db, 'data', id)).toBe(false);
        // Positive control: the eng viewer can.
        expect(getShowcaseDetail(db, 'eng', ALICE, id)).toBeDefined();
        expect(isShowcaseVisibleToViewer(db, 'eng', id)).toBe(true);
    });

    it('detail is undefined for a non-showcase id and a missing id', () => {
        const practice = createContribution(db, {
            contentType: 'best_practice',
            title: 'Not a showcase',
            authorId: ALICE,
            scope: 'org',
            scopeTarget: null,
            state: 'published',
            body: '{}',
        });
        expect(getShowcaseDetail(db, 'eng', ALICE, practice.id)).toBeUndefined();
        expect(getShowcaseDetail(db, 'eng', ALICE, 'no-such-id')).toBeUndefined();
    });

    it('an unpublished showcase is not browseable nor detail-visible', () => {
        const id = publishShowcaseFixture(db, {title: 'Was published'});
        // Flip it to unpublished directly via the live state (simulate an owner unpublish).
        db.prepare("UPDATE contributions SET state = 'unpublished' WHERE id = ?").run(id);
        expect(browseShowcases(db, 'eng')).toEqual([]);
        expect(getShowcaseDetail(db, 'eng', ALICE, id)).toBeUndefined();
        // Sanity: the row still exists, it is just not published.
        expect(getContribution(db, id)?.state).toBe('unpublished');
    });
});
