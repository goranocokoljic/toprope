import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {addContributionTag, createContribution} from '../../src/contributions/store';
import {editContribution} from '../../src/contributions/versioning';
import type {NewContribution} from '../../src/contributions/types';
import {recordFeedback, setPracticeEndorsed} from '../../src/practices/store';
import {setTeamSetting} from '../../src/settings/store';
import {CONTRIBUTION_MODEL_SETTING_KEY} from '../../src/practices/contributionModel';
import {
    browsePractices,
    getBrowsePracticeDetail,
    getBrowsePracticeHistory,
    isPracticeVisibleToViewer,
    linkedShowcasesForPractice,
} from '../../src/practices/browse';

const NOW = '2026-06-20T00:00:00.000Z';
const LATER = '2026-06-22T00:00:00.000Z';

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(name, NOW);
}

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        NOW,
    );
}

interface MakeOpts {
    scope?: 'org' | 'team';
    scopeTarget?: string | null;
    state?: NewContribution['state'];
    tags?: string[];
    authorId?: string;
    markdown?: string;
    contentType?: string;
}

/** Create a practice (default: published, org-scoped, authored by alice). Returns its id. */
function make(db: Database.Database, title: string, opts: MakeOpts = {}): string {
    const id = createContribution(db, {
        contentType: opts.contentType ?? 'best_practice',
        title,
        authorId: opts.authorId ?? 'alice',
        scope: opts.scope ?? 'org',
        scopeTarget: opts.scopeTarget ?? null,
        state: opts.state ?? 'published',
        body: JSON.stringify({markdown: opts.markdown ?? title}),
        timestamp: NOW,
    }).id;
    for (const tag of opts.tags ?? []) {
        addContributionTag(db, id, tag);
    }
    return id;
}

describe('Best-practice browse service (Task 6.2.8 / #163)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedTeam(db, 'eng');
        seedTeam(db, 'data');
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'data');
        seedDeveloper(db, 'carol', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    // --- browse + search + filter (AC1) ------------------------------------

    it('lists published practices the viewer may see, newest-first', () => {
        make(db, 'Older tip', {});
        const newer = createContribution(db, {
            contentType: 'best_practice',
            title: 'Newer tip',
            authorId: 'alice',
            scope: 'org',
            scopeTarget: null,
            state: 'published',
            body: JSON.stringify({markdown: 'Newer tip'}),
            timestamp: LATER,
        }).id;
        const rows = browsePractices(db, 'eng');
        expect(rows.map((r) => r.title)).toEqual(['Newer tip', 'Older tip']);
        expect(rows[0].id).toBe(newer);
        expect(rows[0].authorName).toBe('alice Dev');
    });

    it('excludes drafts and non-practice content types', () => {
        make(db, 'A published practice', {});
        make(db, 'A draft', {state: 'draft'});
        make(db, 'A showcase', {contentType: 'showcase_example'});
        const rows = browsePractices(db, 'eng');
        expect(rows.map((r) => r.title)).toEqual(['A published practice']);
    });

    it('free-text search matches the title', () => {
        make(db, 'Review AI suggestions carefully', {});
        make(db, 'Tighten your prompts', {});
        const rows = browsePractices(db, 'eng', {text: 'review'});
        expect(rows.map((r) => r.title)).toEqual(['Review AI suggestions carefully']);
    });

    it('the tag filter narrows to practices carrying that metric tag', () => {
        make(db, 'Churn tip', {tags: ['churn']});
        make(db, 'Acceptance tip', {tags: ['acceptance_rate']});
        const rows = browsePractices(db, 'eng', {tag: 'churn'});
        expect(rows.map((r) => r.title)).toEqual(['Churn tip']);
        expect(rows[0].metrics).toEqual(['churn']);
    });

    it('the scope filter narrows to org or team practices', () => {
        make(db, 'Org tip', {scope: 'org'});
        make(db, 'Eng tip', {scope: 'team', scopeTarget: 'eng'});
        expect(browsePractices(db, 'eng', {scope: 'org'}).map((r) => r.title)).toEqual(['Org tip']);
        expect(browsePractices(db, 'eng', {scope: 'team'}).map((r) => r.title)).toEqual(['Eng tip']);
    });

    it('filters combine (AND): tag + scope', () => {
        make(db, 'Org churn', {scope: 'org', tags: ['churn']});
        make(db, 'Eng churn', {scope: 'team', scopeTarget: 'eng', tags: ['churn']});
        make(db, 'Org acceptance', {scope: 'org', tags: ['acceptance_rate']});
        const rows = browsePractices(db, 'eng', {tag: 'churn', scope: 'org'});
        expect(rows.map((r) => r.title)).toEqual(['Org churn']);
    });

    it('the team filter narrows within scope and can never widen past it', () => {
        make(db, 'Eng tip', {scope: 'team', scopeTarget: 'eng'});
        make(db, 'Data tip', {scope: 'team', scopeTarget: 'data'});
        // An eng viewer filtering by their own team sees only the eng practice.
        expect(browsePractices(db, 'eng', {team: 'eng'}).map((r) => r.title)).toEqual(['Eng tip']);
        // Filtering by a team the viewer is not on cannot surface that team's practice —
        // the scope tail removes it, so the filter narrows to an empty set, never a leak.
        expect(browsePractices(db, 'eng', {team: 'data'})).toEqual([]);
    });

    it('caps the result set when a limit is given', () => {
        make(db, 'Tip A', {});
        make(db, 'Tip B', {});
        make(db, 'Tip C', {});
        expect(browsePractices(db, 'eng', {limit: 2})).toHaveLength(2);
        expect(browsePractices(db, 'eng')).toHaveLength(3);
    });

    it('never surfaces a team-scoped practice to another team (scope enforcement)', () => {
        make(db, 'Eng-only tip', {scope: 'team', scopeTarget: 'eng'});
        expect(browsePractices(db, 'eng').map((r) => r.title)).toEqual(['Eng-only tip']);
        expect(browsePractices(db, 'data')).toEqual([]);
        // A teamless viewer sees only org items — here, none.
        expect(browsePractices(db, null)).toEqual([]);
    });

    it('carries feedback counts, ratio, and the endorsed marker', () => {
        const id = make(db, 'Voted tip', {});
        recordFeedback(db, {contributionId: id, developerId: 'alice', signal: 'helpful', createdAt: NOW});
        recordFeedback(db, {contributionId: id, developerId: 'bob', signal: 'helpful', createdAt: NOW});
        recordFeedback(db, {contributionId: id, developerId: 'carol', signal: 'not_helpful', createdAt: NOW});
        setPracticeEndorsed(db, id, true);
        const [row] = browsePractices(db, 'eng');
        expect(row.feedback.helpful).toBe(2);
        expect(row.feedback.notHelpful).toBe(1);
        expect(row.feedback.helpfulRatio).toBeCloseTo(2 / 3, 5);
        expect(row.endorsed).toBe(true);
    });

    // --- detail view (AC2) -------------------------------------------------

    it('detail renders sanitized HTML and the viewer feedback state', () => {
        const id = make(db, 'Code review tip', {markdown: '# Heading\n\n```js\nconst x = 1;\n```'});
        recordFeedback(db, {contributionId: id, developerId: 'bob', signal: 'helpful', createdAt: NOW});
        const detail = getBrowsePracticeDetail(db, 'data', 'bob', id);
        expect(detail).toBeDefined();
        expect(detail?.html).toContain('<h1>Heading</h1>');
        expect(detail?.html).toContain('<pre>');
        expect(detail?.feedback.viewerSignal).toBe('helpful');
        expect(detail?.feedback.helpful).toBe(1);
        // No <script> can survive the sanitizer.
        expect(detail?.html).not.toContain('<script>');
    });

    it('viewerSignal is null when the viewer has not voted', () => {
        const id = make(db, 'Unvoted tip', {});
        const detail = getBrowsePracticeDetail(db, 'eng', 'alice', id);
        expect(detail?.feedback.viewerSignal).toBeNull();
    });

    it('canEdit is true only for the author', () => {
        const id = make(db, 'Alice tip', {authorId: 'alice'});
        expect(getBrowsePracticeDetail(db, 'eng', 'alice', id)?.canEdit).toBe(true);
        expect(getBrowsePracticeDetail(db, 'eng', 'carol', id)?.canEdit).toBe(false);
    });

    it('detail exposes the viewer-team active contribution model', () => {
        const id = make(db, 'Modeled tip', {});
        expect(getBrowsePracticeDetail(db, 'eng', 'alice', id)?.model).toBe('top_down');
        setTeamSetting(db, 'eng', CONTRIBUTION_MODEL_SETTING_KEY, 'hybrid');
        expect(getBrowsePracticeDetail(db, 'eng', 'alice', id)?.model).toBe('hybrid');
    });

    it('detail returns undefined for a practice outside the viewer scope', () => {
        const id = make(db, 'Eng-only', {scope: 'team', scopeTarget: 'eng'});
        expect(getBrowsePracticeDetail(db, 'data', 'bob', id)).toBeUndefined();
    });

    it('detail returns undefined for a draft, a non-practice, and a missing id', () => {
        const draft = make(db, 'Draft', {state: 'draft'});
        const showcase = make(db, 'Showcase', {contentType: 'showcase_example'});
        expect(getBrowsePracticeDetail(db, 'eng', 'alice', draft)).toBeUndefined();
        expect(getBrowsePracticeDetail(db, 'eng', 'alice', showcase)).toBeUndefined();
        expect(getBrowsePracticeDetail(db, 'eng', 'alice', 'no-such-id')).toBeUndefined();
    });

    it('showcase cross-links are empty until 6.3.8 (the affordance renders nothing)', () => {
        const id = make(db, 'Tip', {});
        expect(getBrowsePracticeDetail(db, 'eng', 'alice', id)?.showcases).toEqual([]);
        expect(linkedShowcasesForPractice(db, id, 'eng')).toEqual([]);
    });

    // --- version history access (AC2) --------------------------------------

    it('history returns each version oldest-first as lean metadata', () => {
        const id = make(db, 'Evolving tip', {markdown: 'v1'});
        editContribution(db, id, {actorId: 'alice', body: JSON.stringify({markdown: 'v2'}), changeNote: 'tweak'});
        const history = getBrowsePracticeHistory(db, 'eng', id);
        expect(history?.map((h) => h.version)).toEqual([1, 2]);
        expect(history?.[1].changeNote).toBe('tweak');
        expect(history?.[1].authorName).toBe('alice Dev');
        // Lean: no opaque body is exposed.
        expect(history?.[0]).not.toHaveProperty('body');
    });

    it('history returns undefined for a practice the viewer cannot see', () => {
        const id = make(db, 'Eng-only', {scope: 'team', scopeTarget: 'eng'});
        expect(getBrowsePracticeHistory(db, 'data', id)).toBeUndefined();
    });

    // --- visibility gate (shared by the feedback route) --------------------

    it('isPracticeVisibleToViewer reflects scope and publication', () => {
        const pub = make(db, 'Published org', {});
        const team = make(db, 'Eng-only', {scope: 'team', scopeTarget: 'eng'});
        const draft = make(db, 'Draft', {state: 'draft'});
        expect(isPracticeVisibleToViewer(db, 'data', pub)).toBe(true);
        expect(isPracticeVisibleToViewer(db, 'data', team)).toBe(false);
        expect(isPracticeVisibleToViewer(db, 'eng', team)).toBe(true);
        expect(isPracticeVisibleToViewer(db, 'eng', draft)).toBe(false);
    });
});
