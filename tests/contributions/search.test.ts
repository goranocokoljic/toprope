import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    buildMatchExpression,
    searchContributions,
    type ContributionSearchResult,
} from '../../src/contributions/search';
import {
    addContributionTag,
    createContribution,
    deleteContribution,
    removeContributionTag,
    updateContributionState,
} from '../../src/contributions/store';
import {editContribution, revertToVersion} from '../../src/contributions/versioning';
import {hideOrgItemForTeam} from '../../src/contributions/scope';
import type {NewContribution} from '../../src/contributions/types';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';
const T3 = '2026-06-22T00:00:00.000Z';

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

/** Body helper — the spine stores opaque JSON; we wrap prose in a markdown field. */
function body(markdown: string): string {
    return JSON.stringify({markdown});
}

interface MakeOpts {
    contentType?: string;
    scope?: 'org' | 'team';
    scopeTarget?: string | null;
    state?: 'draft' | 'submitted' | 'published' | 'unpublished' | 'removed';
    bodyText?: string;
    ts?: string;
    tags?: string[];
}

function make(db: Database.Database, title: string, opts: MakeOpts = {}): string {
    const input: NewContribution = {
        contentType: opts.contentType ?? 'best_practice',
        title,
        authorId: 'alice',
        scope: opts.scope ?? 'org',
        scopeTarget: opts.scopeTarget ?? null,
        state: opts.state ?? 'published',
        body: body(opts.bodyText ?? title),
        timestamp: opts.ts ?? T1,
    };
    const id = createContribution(db, input).id;
    for (const tag of opts.tags ?? []) {
        addContributionTag(db, id, tag);
    }
    return id;
}

function ids(results: ContributionSearchResult[]): string[] {
    return results.map((r) => r.contribution.id);
}

describe('contribution search', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedTeam(db, 'frontend');
        seedTeam(db, 'backend');
        seedDeveloper(db, 'alice', 'frontend');
    });

    afterEach(() => {
        db.close();
    });

    // --- buildMatchExpression (the FTS-injection-safe query builder) -------------

    describe('buildMatchExpression', () => {
        it('quotes and prefix-marks each token, ANDed by space', () => {
            expect(buildMatchExpression('churn review')).toBe('"churn"* "review"*');
        });

        it('strips FTS operators and quotes so user input cannot inject syntax', () => {
            // Bare AND/OR/NOT, quotes, stars, colons, parens, carets must not reach MATCH raw.
            expect(buildMatchExpression('foo* OR "bar" (baz)')).toBe('"foo"* "OR"* "bar"* "baz"*');
        });

        it('returns null when nothing usable survives sanitization', () => {
            expect(buildMatchExpression('   ')).toBeNull();
            expect(buildMatchExpression('* ^ : ( )')).toBeNull();
            expect(buildMatchExpression('')).toBeNull();
        });

        it('keeps unicode letters and digits', () => {
            expect(buildMatchExpression('café 42')).toBe('"café"* "42"*');
        });

        it('the sanitized expression actually executes against MATCH without error', () => {
            // The unit cases above assert the STRING; this proves that string is
            // genuinely MATCH-safe by driving an operator/quote/paren-laden query
            // through the real FTS query (search.ts: `contribution_search MATCH ?`).
            // A regression that leaked a bare *, ", OR or ( would throw SQLITE_ERROR.
            const hit = make(db, 'Operators', {bodyText: 'foo or bar baz together'});
            make(db, 'Other', {bodyText: 'completely unrelated prose'});

            let res: ContributionSearchResult[] = [];
            expect(() => {
                res = searchContributions(db, {text: 'foo* OR "bar" (baz)'});
            }).not.toThrow();
            // The four surviving tokens (foo, OR, bar, baz) AND-match only the doc
            // that contains all of them.
            expect(ids(res)).toEqual([hit]);
        });
    });

    // --- Free-text search returns relevant content (AC1) ------------------------

    describe('free-text search', () => {
        it('finds content by a word in the title', () => {
            make(db, 'Reviewing AI suggestions', {bodyText: 'general guidance'});
            make(db, 'Unrelated topic', {bodyText: 'nothing here'});
            const res = searchContributions(db, {text: 'reviewing'});
            expect(ids(res)).toEqual([expect.any(String)]);
            expect(res[0].contribution.title).toBe('Reviewing AI suggestions');
        });

        it('finds content by a word in the body', () => {
            const id = make(db, 'Generic title', {bodyText: 'always inspect churn before accepting code'});
            make(db, 'Other', {bodyText: 'unrelated prose'});
            const res = searchContributions(db, {text: 'churn'});
            expect(ids(res)).toEqual([id]);
        });

        it('finds content by tag text', () => {
            const id = make(db, 'Tagged item', {bodyText: 'body', tags: ['security']});
            make(db, 'Untagged', {bodyText: 'body'});
            const res = searchContributions(db, {text: 'security'});
            expect(ids(res)).toEqual([id]);
        });

        it('matches by prefix so a partial term finds the word', () => {
            const id = make(db, 'Refactoring patterns', {bodyText: 'body'});
            const res = searchContributions(db, {text: 'refac'});
            expect(ids(res)).toEqual([id]);
        });

        it('ANDs multiple terms — all must appear', () => {
            const both = make(db, 'churn and review', {bodyText: 'discusses churn and review'});
            make(db, 'churn only', {bodyText: 'just churn'});
            const res = searchContributions(db, {text: 'churn review'});
            expect(ids(res)).toEqual([both]);
        });

        it('ranks title above body above tags (all three bm25 weights exercised)', () => {
            // One hit per column so each bm25 weight (title=10, body=4, tags=2) is
            // isolated. This asserts the FULL three-way ordering — not just title>body
            // — so it would fail if the weights were misaligned (e.g. the leading
            // UNINDEXED column shifting them) and tags slipped to the default weight.
            const tagOnly = make(db, 'Generic A', {bodyText: 'unrelated prose', tags: ['churn']});
            const bodyOnly = make(db, 'Generic B', {bodyText: 'a passing mention of churn somewhere'});
            const titleHit = make(db, 'Churn reduction guide', {bodyText: 'unrelated prose'});
            const res = searchContributions(db, {text: 'churn'});
            expect(ids(res)).toEqual([titleHit, bodyOnly, tagOnly]);
            // Lower bm25 score == more relevant; scores must be strictly increasing
            // title → body → tags.
            expect(res[0].score).toBeLessThan(res[1].score);
            expect(res[1].score).toBeLessThan(res[2].score);
        });

        it('returns empty for a term that matches nothing', () => {
            make(db, 'Alpha', {bodyText: 'beta'});
            expect(searchContributions(db, {text: 'nonexistentterm'})).toEqual([]);
        });

        it('does not throw on FTS-special characters and treats them as no-text', () => {
            const a = make(db, 'Alpha', {bodyText: 'beta', ts: T1});
            const b = make(db, 'Gamma', {bodyText: 'delta', ts: T2});
            // Pure punctuation sanitizes to null → behaves like a text-less browse.
            const res = searchContributions(db, {text: '*:^()'});
            expect(ids(res)).toEqual([b, a]); // newest-first
        });
    });

    // --- Filters work and combine (AC2) -----------------------------------------

    describe('filters', () => {
        it('filters by content_type', () => {
            const bp = make(db, 'A practice', {contentType: 'best_practice'});
            make(db, 'An example', {contentType: 'showcase_example'});
            const res = searchContributions(db, {filters: {contentType: 'best_practice'}});
            expect(ids(res)).toEqual([bp]);
        });

        it('filters by scope = org', () => {
            const org = make(db, 'Org item', {scope: 'org'});
            make(db, 'Team item', {scope: 'team', scopeTarget: 'frontend'});
            const res = searchContributions(db, {filters: {scope: 'org'}});
            expect(ids(res)).toEqual([org]);
        });

        it('filters by team (scopeTarget) and by org via explicit null', () => {
            make(db, 'Org item', {scope: 'org'});
            const teamItem = make(db, 'FE item', {scope: 'team', scopeTarget: 'frontend'});
            make(db, 'BE item', {scope: 'team', scopeTarget: 'backend'});

            // A frontend viewer can see frontend-scoped content; the scopeTarget
            // filter then narrows to exactly that team's items.
            const feOnly = searchContributions(db, {viewerTeam: 'frontend', filters: {scopeTarget: 'frontend'}});
            expect(ids(feOnly)).toEqual([teamItem]);

            const orgOnly = searchContributions(db, {filters: {scopeTarget: null}});
            expect(orgOnly).toHaveLength(1);
            expect(orgOnly[0].contribution.title).toBe('Org item');
        });

        it('filters by state', () => {
            const pub = make(db, 'Published', {state: 'published'});
            make(db, 'Draft', {state: 'draft'});
            const res = searchContributions(db, {filters: {state: 'published'}});
            expect(ids(res)).toEqual([pub]);
        });

        it('filters by tag', () => {
            const tagged = make(db, 'Tagged', {tags: ['perf', 'ai']});
            make(db, 'Other', {tags: ['security']});
            const res = searchContributions(db, {tag: 'perf'});
            expect(ids(res)).toEqual([tagged]);
        });

        it('combines text + tag + content_type + scope (all ANDed)', () => {
            const target = make(db, 'Churn guide', {
                contentType: 'best_practice',
                scope: 'org',
                bodyText: 'reduce churn',
                tags: ['quality'],
            });
            // Misses one criterion each — none should come back.
            make(db, 'Churn guide', {contentType: 'showcase_example', bodyText: 'reduce churn', tags: ['quality']});
            make(db, 'Churn guide', {contentType: 'best_practice', scope: 'team', scopeTarget: 'frontend', bodyText: 'reduce churn', tags: ['quality']});
            make(db, 'Unrelated', {contentType: 'best_practice', bodyText: 'nothing', tags: ['quality']});
            make(db, 'Churn guide', {contentType: 'best_practice', bodyText: 'reduce churn', tags: ['other']});

            const res = searchContributions(db, {
                text: 'churn',
                tag: 'quality',
                filters: {contentType: 'best_practice', scope: 'org'},
            });
            expect(ids(res)).toEqual([target]);
        });

        it('applies limit after ranking — keeps the most relevant, not just the first N', () => {
            // The title hit is most relevant; the two body hits are seeded so the
            // title hit is NOT created first, so a limit applied before ranking would
            // drop it. Asserting the identities (not just the length) proves the cap
            // keeps the top-ranked results.
            make(db, 'body one', {bodyText: 'churn mention'});
            const titleHit = make(db, 'Churn guide', {bodyText: 'unrelated'});
            make(db, 'body two', {bodyText: 'churn mention'});
            const res = searchContributions(db, {text: 'churn', limit: 2});
            expect(res).toHaveLength(2);
            expect(res[0].contribution.id).toBe(titleHit);
        });
    });

    // --- Scope enforcement: no out-of-scope leakage (AC3) -----------------------

    describe('scope enforcement', () => {
        beforeEach(() => {
            make(db, 'Org wide', {scope: 'org', bodyText: 'shared knowledge'});
            make(db, 'Frontend only', {scope: 'team', scopeTarget: 'frontend', bodyText: 'shared knowledge'});
            make(db, 'Backend only', {scope: 'team', scopeTarget: 'backend', bodyText: 'shared knowledge'});
        });

        it('a frontend viewer sees org + frontend, never backend', () => {
            const res = searchContributions(db, {text: 'shared', viewerTeam: 'frontend'});
            const titles = res.map((r) => r.contribution.title).sort();
            expect(titles).toEqual(['Frontend only', 'Org wide']);
        });

        it('a teamless viewer sees only org content', () => {
            const res = searchContributions(db, {text: 'shared', viewerTeam: null});
            expect(res.map((r) => r.contribution.title)).toEqual(['Org wide']);
        });

        it('scope enforcement holds even when a filter would otherwise expose a team item', () => {
            // Explicitly filtering for backend's content as a frontend viewer must
            // still return nothing — the viewer-scope step is the last word.
            const res = searchContributions(db, {
                text: 'shared',
                viewerTeam: 'frontend',
                filters: {scopeTarget: 'backend'},
            });
            expect(res).toEqual([]);
        });

        it('a per-team hide removes an org item for that team only', () => {
            const orgId = searchContributions(db, {text: 'shared', filters: {scope: 'org'}})[0].contribution.id;
            hideOrgItemForTeam(db, {contributionId: orgId, team: 'frontend', actorId: 'alice', permitted: true});

            const fe = searchContributions(db, {text: 'shared', viewerTeam: 'frontend'});
            expect(fe.map((r) => r.contribution.title)).toEqual(['Frontend only']);

            // Backend still sees the org item.
            const be = searchContributions(db, {text: 'shared', viewerTeam: 'backend'});
            expect(be.map((r) => r.contribution.title).sort()).toEqual(['Backend only', 'Org wide']);
        });

        it('hidesPermitted=false ignores a stored hide (org item resurfaces)', () => {
            const orgId = searchContributions(db, {text: 'shared', filters: {scope: 'org'}})[0].contribution.id;
            hideOrgItemForTeam(db, {contributionId: orgId, team: 'frontend', actorId: 'alice', permitted: true});
            const fe = searchContributions(db, {text: 'shared', viewerTeam: 'frontend', hidesPermitted: false});
            expect(fe.map((r) => r.contribution.title).sort()).toEqual(['Frontend only', 'Org wide']);
        });

        it('limit is applied AFTER scope so out-of-scope rows that sort first cannot steal the cap', () => {
            // The design hinges on scope-then-limit. Seed backend (out-of-scope) rows
            // NEWEST so they sort ahead of the in-scope rows on the recency tiebreak;
            // a limit pushed into SQL (before scope) would spend the cap on backend
            // rows and silently drop the frontend viewer's real results.
            make(db, 'Org leak', {scope: 'org', bodyText: 'leaktest', ts: T1});
            make(db, 'Frontend leak', {scope: 'team', scopeTarget: 'frontend', bodyText: 'leaktest', ts: T2});
            make(db, 'Backend leak A', {scope: 'team', scopeTarget: 'backend', bodyText: 'leaktest', ts: T3});
            make(db, 'Backend leak B', {scope: 'team', scopeTarget: 'backend', bodyText: 'leaktest', ts: T3});

            const res = searchContributions(db, {text: 'leaktest', viewerTeam: 'frontend', limit: 2});
            const titles = res.map((r) => r.contribution.title).sort();
            // Both in-scope rows survive (not crowded out by the newer backend rows)
            // and no backend row leaks through despite sorting ahead.
            expect(titles).toEqual(['Frontend leak', 'Org leak']);
        });
    });

    // --- Index freshness (AC4) --------------------------------------------------

    describe('index freshness', () => {
        it('a newly created contribution is immediately searchable', () => {
            const id = make(db, 'Brand new', {bodyText: 'fresh content about caching'});
            expect(ids(searchContributions(db, {text: 'caching'}))).toEqual([id]);
        });

        it('editing the body re-indexes: old text gone, new text found', () => {
            const id = make(db, 'Evolving', {bodyText: 'discusses churn'});
            expect(ids(searchContributions(db, {text: 'churn'}))).toEqual([id]);

            editContribution(db, id, {actorId: 'alice', body: body('now discusses caching instead'), timestamp: T2});

            expect(searchContributions(db, {text: 'churn'})).toEqual([]);
            expect(ids(searchContributions(db, {text: 'caching'}))).toEqual([id]);
        });

        it('reverting re-indexes the body of the version it restores', () => {
            // Revert bumps current_version to point at an OLDER body — a distinct
            // trigger path from edit. The index must follow it back.
            const id = make(db, 'Evolving', {bodyText: 'discusses churn'});
            editContribution(db, id, {actorId: 'alice', body: body('now about caching'), timestamp: T2});
            expect(searchContributions(db, {text: 'churn'})).toEqual([]);

            revertToVersion(db, id, 1, {actorId: 'alice', timestamp: T3});

            // v1's "churn" body is current again; the edited "caching" body is not.
            expect(ids(searchContributions(db, {text: 'churn'}))).toEqual([id]);
            expect(searchContributions(db, {text: 'caching'})).toEqual([]);
        });

        it('adding then removing a tag updates what tag text matches', () => {
            const id = make(db, 'Item', {bodyText: 'body'});
            expect(searchContributions(db, {text: 'observability'})).toEqual([]);

            addContributionTag(db, id, 'observability');
            expect(ids(searchContributions(db, {text: 'observability'}))).toEqual([id]);

            removeContributionTag(db, id, 'observability');
            expect(searchContributions(db, {text: 'observability'})).toEqual([]);
        });

        it('unpublishing is reflected through the live state filter', () => {
            const id = make(db, 'Published item', {bodyText: 'churn guidance', state: 'published'});
            expect(ids(searchContributions(db, {text: 'churn', filters: {state: 'published'}}))).toEqual([id]);

            updateContributionState(db, id, 'unpublished', T2);
            expect(searchContributions(db, {text: 'churn', filters: {state: 'published'}})).toEqual([]);
            expect(ids(searchContributions(db, {text: 'churn', filters: {state: 'unpublished'}}))).toEqual([id]);
        });

        it('hard-deleting a contribution drops it from the index', () => {
            const id = make(db, 'Doomed', {bodyText: 'transient churn note'});
            expect(ids(searchContributions(db, {text: 'churn'}))).toEqual([id]);

            deleteContribution(db, id);
            expect(searchContributions(db, {text: 'churn'})).toEqual([]);
        });
    });

    // --- Pure-filter browse (no text) -------------------------------------------

    describe('text-less browse', () => {
        it('lists everything (scoped) newest-first when no text is given', () => {
            const a = make(db, 'Oldest', {ts: T1});
            const b = make(db, 'Middle', {ts: T2});
            const c = make(db, 'Newest', {ts: T3});
            const res = searchContributions(db, {});
            expect(ids(res)).toEqual([c, b, a]);
            // No text query → score is 0 for every hit.
            expect(res.every((r) => r.score === 0)).toBe(true);
        });

        it('returns EVERY lifecycle state by default — state is opt-in, not implied', () => {
            // The primitive is deliberately state-agnostic: it returns drafts and
            // removed/unpublished rows unless the caller narrows with a state filter
            // (a consumer surface forces e.g. {state:'published'}). Pin this so a
            // regression that started silently hiding non-published rows is caught.
            const draft = make(db, 'A draft', {state: 'draft', ts: T1});
            const removed = make(db, 'A tombstone', {state: 'removed', ts: T2});
            const published = make(db, 'A published', {state: 'published', ts: T3});

            expect(ids(searchContributions(db, {})).sort()).toEqual([draft, removed, published].sort());
            // The state filter narrows to exactly the published row.
            expect(ids(searchContributions(db, {filters: {state: 'published'}}))).toEqual([published]);
        });
    });
});
