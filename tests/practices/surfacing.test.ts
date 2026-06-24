import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {addContributionTag, createContribution} from '../../src/contributions/store';
import {hideOrgItemForTeam} from '../../src/contributions/scope';
import type {NewContribution} from '../../src/contributions/types';
import {addMetricPin, recordFeedback, setPracticeEndorsed} from '../../src/practices/store';
import {setTeamSetting} from '../../src/settings/store';
import {CONTRIBUTION_MODEL_SETTING_KEY, type ContributionModel} from '../../src/practices/contributionModel';
import {
    resolveCurrentMetricOverrides,
    surfacePractices,
    type SurfacedPractice,
} from '../../src/practices/surfacing';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';

const TEAM = 'eng';
const OTHER_TEAM = 'data';

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

function body(markdown: string): string {
    return JSON.stringify({markdown});
}

interface MakeOpts {
    scope?: 'org' | 'team';
    scopeTarget?: string | null;
    state?: NewContribution['state'];
    tags?: string[];
    ts?: string;
    contentType?: string;
}

/** Create a practice (default: published, org-scoped) and return its id. */
function make(db: Database.Database, title: string, opts: MakeOpts = {}): string {
    const input: NewContribution = {
        contentType: opts.contentType ?? 'best_practice',
        title,
        authorId: 'alice',
        scope: opts.scope ?? 'org',
        scopeTarget: opts.scopeTarget ?? null,
        state: opts.state ?? 'published',
        body: body(title),
        timestamp: opts.ts ?? T1,
    };
    const id = createContribution(db, input).id;
    for (const tag of opts.tags ?? []) {
        addContributionTag(db, id, tag);
    }
    return id;
}

/**
 * Apply N helpful / M not_helpful votes from distinct developers to a practice.
 * Each voter is seeded first — practice_feedback.developer_id FKs to developers.
 */
function vote(db: Database.Database, contributionId: string, helpful: number, notHelpful: number): void {
    let n = 0;
    const castVote = (signal: 'helpful' | 'not_helpful'): void => {
        const developerId = `voter_${contributionId}_${n++}`;
        seedDeveloper(db, developerId, TEAM);
        recordFeedback(db, {contributionId, developerId, signal});
    };
    for (let i = 0; i < helpful; i++) {
        castVote('helpful');
    }
    for (let i = 0; i < notHelpful; i++) {
        castVote('not_helpful');
    }
}

function useModel(db: Database.Database, team: string, model: ContributionModel): void {
    setTeamSetting(db, team, CONTRIBUTION_MODEL_SETTING_KEY, model);
}

function ids(surfaced: SurfacedPractice[]): string[] {
    return surfaced.map((s) => s.contribution.id);
}

describe('tag-based auto-surfacing (Task 6.2.5 / #160)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedTeam(db, TEAM);
        seedTeam(db, OTHER_TEAM);
        seedDeveloper(db, 'alice', TEAM);
    });

    afterEach(() => {
        db.close();
    });

    // --- Tag match ---------------------------------------------------------

    describe('tag match', () => {
        it('a practice tagged `churn` surfaces against the churn metric', () => {
            const churn = make(db, 'Review AI suggestions before accepting', {tags: ['churn']});
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM});
            expect(ids(surfaced)).toEqual([churn]);
        });

        it('a practice tagged for a different metric does not surface', () => {
            make(db, 'Tighten prompts', {tags: ['acceptance_rate']});
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM});
            expect(surfaced).toEqual([]);
        });

        it('an untagged practice never surfaces', () => {
            make(db, 'Generic advice', {tags: []});
            expect(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM})).toEqual([]);
        });

        it('only published practices surface — a draft/submitted/unpublished tagged practice does not', () => {
            const published = make(db, 'Published churn tip', {tags: ['churn'], state: 'published'});
            make(db, 'Draft churn tip', {tags: ['churn'], state: 'draft'});
            make(db, 'Submitted churn tip', {tags: ['churn'], state: 'submitted'});
            make(db, 'Unpublished churn tip', {tags: ['churn'], state: 'unpublished'});
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM});
            expect(ids(surfaced)).toEqual([published]);
        });

        it('a blank metric surfaces nothing and never queries a tag', () => {
            make(db, 'Has an empty tag', {tags: ['']});
            expect(surfacePractices(db, {metric: '', viewerTeam: TEAM})).toEqual([]);
            expect(surfacePractices(db, {metric: '   ', viewerTeam: TEAM})).toEqual([]);
        });

        it('limit caps the surfaced set after ranking', () => {
            for (let i = 0; i < 3; i++) {
                make(db, `Tip ${i}`, {tags: ['churn']});
            }
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM, limit: 2});
            expect(surfaced).toHaveLength(2);
        });
    });

    // --- Scope filtering (6.1.4 / #154) ------------------------------------

    describe('scope filtering', () => {
        it('a team-scoped practice surfaces only to that team, not to another team', () => {
            make(db, 'Eng-only churn tip', {tags: ['churn'], scope: 'team', scopeTarget: TEAM});
            expect(ids(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM}))).toHaveLength(1);
            expect(surfacePractices(db, {metric: 'churn', viewerTeam: OTHER_TEAM})).toEqual([]);
        });

        it('a teamless viewer sees only org-scoped practices', () => {
            const org = make(db, 'Org churn tip', {tags: ['churn'], scope: 'org'});
            make(db, 'Team churn tip', {tags: ['churn'], scope: 'team', scopeTarget: TEAM});
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: null});
            expect(ids(surfaced)).toEqual([org]);
        });

        it('an org practice the team hid does not surface for that team (hides honored)', () => {
            const org = make(db, 'Org churn tip', {tags: ['churn'], scope: 'org'});
            hideOrgItemForTeam(db, {contributionId: org, team: TEAM, actorId: 'alice', permitted: true});
            expect(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM})).toEqual([]);
            // Other teams still see it.
            expect(ids(surfacePractices(db, {metric: 'churn', viewerTeam: OTHER_TEAM}))).toEqual([org]);
        });

        it('hidesPermitted=false ignores the hide so the org practice resurfaces', () => {
            const org = make(db, 'Org churn tip', {tags: ['churn'], scope: 'org'});
            hideOrgItemForTeam(db, {contributionId: org, team: TEAM, actorId: 'alice', permitted: true});
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM, hidesPermitted: false});
            expect(ids(surfaced)).toEqual([org]);
        });
    });

    // --- Suppression respect (6.2.6) ---------------------------------------

    describe('suppression respect', () => {
        it('a suppressed practice does not surface', () => {
            const a = make(db, 'Keep this', {tags: ['churn']});
            const b = make(db, 'Suppress this', {tags: ['churn']});
            addMetricPin(db, {contributionId: b, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: T1});
            expect(ids(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM}))).toEqual([a]);
        });

        it('suppression is metric-specific — suppressing for one metric leaves another untouched', () => {
            const p = make(db, 'Dual-tagged', {tags: ['churn', 'acceptance_rate']});
            addMetricPin(db, {contributionId: p, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: T1});
            expect(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM})).toEqual([]);
            expect(ids(surfacePractices(db, {metric: 'acceptance_rate', viewerTeam: TEAM}))).toEqual([p]);
        });

        it('a pin recorded AFTER a suppress cancels it (last-write-wins), so the practice surfaces again', () => {
            const p = make(db, 'Toggled', {tags: ['churn']});
            addMetricPin(db, {contributionId: p, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: T1});
            addMetricPin(db, {contributionId: p, metric: 'churn', action: 'pin', actorId: 'lead', createdAt: T2});
            expect(ids(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM}))).toEqual([p]);
        });

        it('a suppress recorded AFTER a pin wins, so the practice stays hidden', () => {
            const p = make(db, 'Toggled', {tags: ['churn']});
            addMetricPin(db, {contributionId: p, metric: 'churn', action: 'pin', actorId: 'lead', createdAt: T1});
            addMetricPin(db, {contributionId: p, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: T2});
            expect(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM})).toEqual([]);
        });
    });

    // --- resolveCurrentMetricOverrides (the reduction) ---------------------

    describe('resolveCurrentMetricOverrides', () => {
        it('reduces append-only rows to the latest decision per contribution', () => {
            const a = make(db, 'A', {tags: ['churn']});
            const b = make(db, 'B', {tags: ['churn']});
            const c = make(db, 'C', {tags: ['churn']});
            addMetricPin(db, {contributionId: a, metric: 'churn', action: 'pin', actorId: 'lead', createdAt: T1});
            addMetricPin(db, {contributionId: b, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: T1});
            // c flips suppress -> pin; the later pin wins.
            addMetricPin(db, {contributionId: c, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: T1});
            addMetricPin(db, {contributionId: c, metric: 'churn', action: 'pin', actorId: 'lead', createdAt: T2});
            const {pinned, suppressed} = resolveCurrentMetricOverrides(db, 'churn');
            expect(pinned).toEqual(new Set([a, c]));
            expect(suppressed).toEqual(new Set([b]));
        });

        it('returns empty sets for a blank metric without touching the DB', () => {
            const {pinned, suppressed} = resolveCurrentMetricOverrides(db, '  ');
            expect(pinned.size).toBe(0);
            expect(suppressed.size).toBe(0);
        });

        it('a contribution with no override row appears in neither set', () => {
            make(db, 'No override', {tags: ['churn']});
            const {pinned, suppressed} = resolveCurrentMetricOverrides(db, 'churn');
            expect(pinned.size).toBe(0);
            expect(suppressed.size).toBe(0);
        });
    });

    // --- Ranking (endorsed/helpful first; respects contribution model) -----

    describe('ranking', () => {
        it('bottom_up: more-helpful practice ranks ahead of a less-helpful one', () => {
            useModel(db, TEAM, 'bottom_up');
            const strong = make(db, 'Strong', {tags: ['churn'], ts: T1});
            const weak = make(db, 'Weak', {tags: ['churn'], ts: T2});
            vote(db, strong, 9, 1); // ~0.9 helpful
            vote(db, weak, 2, 8); // ~0.2 helpful
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM});
            expect(ids(surfaced)).toEqual([strong, weak]);
            // The ranking signals ride along for the consumer (6.2.7).
            expect(surfaced[0].ranking.helpful).toBe(9);
            expect(surfaced[0].ranking.rankScore).toBeGreaterThan(surfaced[1].ranking.rankScore);
        });

        it('hybrid: an endorsed practice is elevated above a higher-feedback un-endorsed one', () => {
            useModel(db, TEAM, 'hybrid');
            const endorsed = make(db, 'Endorsed', {tags: ['churn'], ts: T1});
            const popular = make(db, 'Popular', {tags: ['churn'], ts: T2});
            vote(db, endorsed, 1, 0); // weak feedback
            vote(db, popular, 20, 1); // strong feedback
            setPracticeEndorsed(db, endorsed, true);
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM});
            expect(ids(surfaced)).toEqual([endorsed, popular]);
            expect(surfaced[0].ranking.endorsed).toBe(true);
        });

        it('top_down: curated order is most-recent-first regardless of feedback', () => {
            // top_down is the default model (no setting needed).
            const older = make(db, 'Older', {tags: ['churn'], ts: T1});
            const newer = make(db, 'Newer', {tags: ['churn'], ts: T2});
            vote(db, older, 50, 0); // feedback must NOT reorder under top_down
            const surfaced = surfacePractices(db, {metric: 'churn', viewerTeam: TEAM});
            expect(ids(surfaced)).toEqual([newer, older]);
        });

        it('the active model follows the viewer team (different teams can rank differently)', () => {
            useModel(db, TEAM, 'bottom_up'); // eng ranks by feedback
            // data stays top_down (default) → recency.
            const a = make(db, 'A', {tags: ['churn'], scope: 'org', ts: T1});
            const b = make(db, 'B', {tags: ['churn'], scope: 'org', ts: T2});
            vote(db, a, 9, 0); // a is more helpful but older
            // eng (bottom_up): a first by feedback.
            expect(ids(surfacePractices(db, {metric: 'churn', viewerTeam: TEAM}))).toEqual([a, b]);
            // data (top_down): b first by recency.
            expect(ids(surfacePractices(db, {metric: 'churn', viewerTeam: OTHER_TEAM}))).toEqual([b, a]);
        });
    });
});
