/**
 * #280 — every provider `createGitProvider` can build honors the `GitCommit.diffs` contract.
 *
 * `GitProvider.getCommits`' doc says an implementation that fetches per-commit diff data MUST
 * expose it on `GitCommit.diffs`, but the field is OPTIONAL (deliberately — see the field's own
 * doc), the sync loop silently falls back to a second `getCommitDiff` request per commit, and a
 * TypeScript optional cannot fail a build. So before this file a fourth provider — or a refactor
 * that dropped the field from an existing one — reinstated the ~2N per-commit request volume
 * #271 removed, and the only symptom was a slower sync.
 *
 * The three per-provider assertions that pinned this before were hand-written in each provider's
 * own test file, so a new provider shipped with no such check BY CONSTRUCTION. This table is
 * driven off `GIT_PROVIDER_TYPES` — the same list `createGitProvider` switches on — so a new
 * member with no fixture FAILS rather than being silently skipped.
 *
 * The providers are the REAL classes over the shared `fetch` stub, not mocks: a mock provider
 * would assert only that the fixture sets the field.
 *
 * BOTH cache paths are covered. Production always hands `createGitProvider` a per-`(type,
 * container)` diffstat cache (#273), and on every run after the first the already-seen commits
 * take a cache-HIT branch that rebuilds the whole `GitCommit` from the memo row — a second,
 * independent place a provider can forget `diffs` (GitHub has two literal `commits.push` sites for
 * exactly this reason). Covering only the cold path would leave the warm path in the same
 * hand-enumerated state this file exists to replace.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../../src/storage/migrator';
import {createGitProvider} from '../../../../src/connectors/git/providers/factory';
import {createCommitDiffstatCache} from '../../../../src/connectors/git/diffstat-cache';
import {
    GIT_PROVIDER_TYPES,
    type GitProviderConfig,
    type GitProviderType,
} from '../../../../src/connectors/git/providers/types';
import {
    BITBUCKET_CONFIG,
    EXPECTED_DIFFS,
    GITHUB_CONFIG,
    GITLAB_CONFIG,
    REPO,
    SHAS,
    bitbucketRoutes,
    githubRoutes,
    gitlabRoutes,
    makeCountingFetch,
    type Route,
} from './provider-fetch-fixtures';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../src/storage/migrations');

const SINCE = '2024-01-01T00:00:00.000Z';
const UNTIL = '2024-02-01T00:00:00.000Z';

interface ProviderFixture {
    config: GitProviderConfig;
    /** The commit-list + per-commit-diff endpoints, enough for `getCommits` to complete. */
    routes: () => Route[];
}

/**
 * One fixture per provider type. A `Record` keyed by {@link GitProviderType} so a new member of
 * the union is a compile error here — but tests are excluded from `tsconfig.json` and vitest
 * transpiles without type-checking, so that is a hint, NOT the enforcement. The enforcement is
 * the runtime gate test below, driven off `GIT_PROVIDER_TYPES`.
 *
 * Route bodies and the expected normalized diffs both come from the shared fixture module, so a
 * provider's URL/payload shape is written down once for every test that drives the real classes.
 */
const FIXTURES: Record<GitProviderType, ProviderFixture> = {
    github: {config: GITHUB_CONFIG, routes: githubRoutes},
    bitbucket: {config: BITBUCKET_CONFIG, routes: bitbucketRoutes},
    gitlab: {config: GITLAB_CONFIG, routes: gitlabRoutes},
};

/**
 * Every URL that names a commit — the per-commit fan-out, whichever endpoint a provider reaches it
 * through (GitHub's commit detail, Bitbucket's diffstat, GitLab's diff). The commit LIST url names
 * no sha, so this counts exactly the O(commits) work.
 */
function perCommitRequests(urls: string[], sha: string): string[] {
    return urls.filter((u) => u.includes(sha));
}

describe('#280 GitCommit.diffs conformance across every provider type', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        // `restoreAllMocks` does NOT undo `stubGlobal`, and `unstubGlobals` is not set in
        // vitest.config.ts — without this the last stubbed `fetch` leaks into the next test.
        vi.unstubAllGlobals();
    });

    /**
     * The gate that makes the table self-maintaining, and the only RUNTIME enforcement here: a
     * provider type added to `GIT_PROVIDER_TYPES` with no fixture would otherwise make
     * `FIXTURES[type]` `undefined` and the per-type tests throw a bare `TypeError` — a failure,
     * but one that reads as a broken test rather than as "your new provider is unverified".
     */
    it('has a fixture for every provider type createGitProvider supports', () => {
        expect(Object.keys(FIXTURES).sort()).toEqual([...GIT_PROVIDER_TYPES].sort());
        // BOTH halves of the fixture, not just the routes: the per-commit assertions below
        // compare against `EXPECTED_DIFFS[type]`, so a new type with routes but no expectation
        // fails as `expected [...] to equal undefined` — the same illegible failure this gate
        // exists to replace.
        expect(Object.keys(EXPECTED_DIFFS).sort()).toEqual([...GIT_PROVIDER_TYPES].sort());
    });

    it.each(GIT_PROVIDER_TYPES)(
        '%s: getCommits returns every commit with a populated diffs array',
        async (type) => {
            const fixture = FIXTURES[type];
            const {fetchMock} = makeCountingFetch(fixture.routes());
            vi.stubGlobal('fetch', fetchMock);

            const commits = await createGitProvider(fixture.config).getCommits(REPO, SINCE, UNTIL);

            // Guards the assertions below against being vacuous: a fixture whose commit-list
            // route stopped matching would return `[]` and every `for` below would pass.
            expect(commits.map((c) => c.sha)).toEqual(SHAS);

            for (const commit of commits) {
                // The contract itself. `undefined` here is what sends the sync loop back to
                // `getCommitDiff` for a diff the provider already fetched.
                expect(Array.isArray(commit.diffs), `${type}/${commit.sha} supplied no diffs`).toBe(
                    true,
                );
                // …and the WHOLE entry, not just its path. `[]` is a legal value of the field, but
                // it means "no file-level detail is obtainable" — and the next failure along from
                // `[]` is a populated array of `{path}`-only entries, which passes any
                // shape/length check while silently zeroing `code_churn_rate` and
                // `ai_signature_score` (the only readers of `status` and of the per-file additions
                // distribution) for every one of that provider's snapshots.
                expect(commit.diffs, `${type}/${commit.sha} diffs`).toEqual(EXPECTED_DIFFS[type]);
            }
        },
    );

    /**
     * The reuse path only saves a request if the provider's own diff walk was the LAST one. This
     * pins the count at the provider boundary — `diff-fetch-dedup.test.ts` pins it end-to-end
     * through the sync loop, but that file enumerates the three providers by hand, so only this
     * table would catch a fourth one that double-fetches inside `getCommits`.
     *
     * `<= 1`, not `=== 1`: a provider whose commit-LIST response already carries file-level stats
     * would make ZERO per-commit requests, which is strictly better than the target and is the
     * direction #271 was heading. The first `it.each` is what stops a provider from making zero
     * requests AND supplying nothing.
     */
    it.each(GIT_PROVIDER_TYPES)(
        '%s: getCommits walks the per-commit diff endpoint at most once per commit',
        async (type) => {
            const fixture = FIXTURES[type];
            const {fetchMock, urls} = makeCountingFetch(fixture.routes());
            vi.stubGlobal('fetch', fetchMock);

            await createGitProvider(fixture.config).getCommits(REPO, SINCE, UNTIL);

            for (const sha of SHAS) {
                const perCommit = perCommitRequests(urls, sha);
                expect(
                    perCommit.length,
                    `${type} fanned out ${perCommit.length}× for ${sha}`,
                ).toBeLessThanOrEqual(1);
            }
        },
    );

    /**
     * The WARM path — the one production takes on every run after the first, and a second place a
     * provider can drop `diffs`.
     *
     * With a diffstat cache supplied, each provider's second `getCommits` over the same commits
     * serves them from the memo (`commit_diffstats`, #273) instead of re-walking the per-commit
     * endpoint. That branch rebuilds the whole `GitCommit`, so it must reach the same `diffs` —
     * otherwise a warm sync silently re-fans out ~2N requests forever via the fallback, which is
     * exactly the cost #271 removed and the state #280 exists to make impossible to ship.
     */
    it.each(GIT_PROVIDER_TYPES)(
        '%s: a cache-served getCommits still returns populated diffs, with no per-commit request',
        async (type) => {
            const fixture = FIXTURES[type];
            const db = new Database(':memory:');
            try {
                runMigrations(db, MIGRATIONS_DIR);
                const cache = createCommitDiffstatCache(db, type, 'test-container');
                const {fetchMock, urls} = makeCountingFetch(fixture.routes());
                vi.stubGlobal('fetch', fetchMock);

                // Pass 1 populates the memo (write-through happens inside the provider).
                const cold = createGitProvider(fixture.config, cache);
                await cold.getCommits(REPO, SINCE, UNTIL);
                const coldRequests = SHAS.flatMap((sha) => perCommitRequests(urls, sha)).length;
                // The positive control: pass 1 really did walk the endpoint, so "pass 2 walked it
                // zero times" is evidence of a cache hit and not of a dead fixture.
                expect(coldRequests).toBeGreaterThan(0);

                urls.length = 0;
                const warm = createGitProvider(fixture.config, cache);
                const commits = await warm.getCommits(REPO, SINCE, UNTIL);

                expect(commits.map((c) => c.sha)).toEqual(SHAS);
                for (const commit of commits) {
                    expect(
                        commit.diffs,
                        `${type}/${commit.sha} lost its diffs on the cache-hit path`,
                    ).toEqual(EXPECTED_DIFFS[type]);
                }
                expect(
                    SHAS.flatMap((sha) => perCommitRequests(urls, sha)),
                    `${type} re-walked the per-commit endpoint despite a warm cache`,
                ).toEqual([]);
            } finally {
                db.close();
            }
        },
    );
});
