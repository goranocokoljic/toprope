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
 * The providers are the REAL classes over a `fetch` stub, not mocks: a mock provider would assert
 * only that the fixture sets the field.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import {createGitProvider} from '../../../../src/connectors/git/providers/factory';
import {
    GIT_PROVIDER_TYPES,
    type GitProviderConfig,
    type GitProviderType,
} from '../../../../src/connectors/git/providers/types';

const AUTHOR_EMAIL = 'alice@example.com';
const COMMIT_DATE = '2024-01-15T10:00:00.000Z';
const SHAS = ['sha-aaa', 'sha-bbb', 'sha-ccc'];
const REPO = 'repo1';
const SINCE = '2024-01-01T00:00:00.000Z';
const UNTIL = '2024-02-01T00:00:00.000Z';

interface Route {
    match: RegExp;
    body?: unknown;
    /** For an endpoint whose response must echo something from the URL (GitHub's commit detail). */
    bodyFor?: (url: string) => unknown;
}

/**
 * Routes `fetch` by URL. An unrouted URL resolves to an empty page rather than throwing, so a
 * provider's unrelated paging does not have to be modelled — but every route a fixture DOES
 * declare must be hit, which the per-commit assertions below establish indirectly (a commit
 * only exists if its list route answered, and its `diffs` are only populated if its diff route
 * did).
 */
function stubFetch(routes: Route[]): {urls: string[]} {
    const urls: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
            const u = String(url);
            urls.push(u);
            const route = routes.find((r) => r.match.test(u));
            const body = route ? (route.bodyFor ? route.bodyFor(u) : route.body) : {values: []};
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: new Headers({}),
                json: () => Promise.resolve(body),
                text: () => Promise.resolve(JSON.stringify(body)),
            } as unknown as Response);
        }),
    );
    return {urls};
}

interface ProviderFixture {
    config: GitProviderConfig;
    /** The commit-list + per-commit-diff endpoints, enough for `getCommits` to complete. */
    routes: Route[];
    /**
     * The file paths the stubbed diff endpoint describes, in the order the provider yields them.
     * Asserted so a provider that returns a well-formed but EMPTY `diffs` — which reads as "no
     * file-level detail is obtainable" and silently zeroes every churn metric — cannot pass an
     * `Array.isArray` check and look conformant.
     */
    expectedPaths: string[];
}

/**
 * One fixture per provider type. A `Record` keyed by {@link GitProviderType} so a new member of
 * the union is a compile error here — but tests are excluded from `tsconfig.json` and vitest
 * transpiles without type-checking, so that is a hint, NOT the enforcement. The enforcement is
 * the runtime lookup in the `it.each` below, driven off `GIT_PROVIDER_TYPES`.
 */
const FIXTURES: Record<GitProviderType, ProviderFixture> = {
    github: {
        config: {type: 'github', org: 'test-org', auth: {type: 'token', api_token: 'tok'}},
        routes: [
            {match: /\/repos\/test-org\/repo1\/commits\?/, body: SHAS.map((sha) => ({sha}))},
            {
                // The detail endpoint — no `?`, which is what distinguishes it from the list URL.
                match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
                bodyFor: (url: string): Record<string, unknown> => ({
                    sha: url.split('/').pop(),
                    commit: {
                        author: {name: 'Alice', email: AUTHOR_EMAIL, date: COMMIT_DATE},
                        message: 'feat: work',
                    },
                    author: {login: 'alice-gh'},
                    stats: {additions: 40, deletions: 5, total: 45},
                    files: [
                        {filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                        {filename: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
                    ],
                }),
            },
        ],
        expectedPaths: ['src/foo.ts', 'src/bar.ts'],
    },
    bitbucket: {
        config: {
            type: 'bitbucket',
            workspace: 'test-ws',
            auth: {type: 'access_token', token: 'tok'},
        },
        routes: [
            {
                match: /\/repositories\/test-ws\/repo1\/commits\?/,
                body: {
                    values: SHAS.map((hash) => ({
                        hash,
                        author: {raw: `Alice <${AUTHOR_EMAIL}>`, user: {nickname: 'alice-bb'}},
                        date: COMMIT_DATE,
                        message: 'feat: work',
                    })),
                },
            },
            {
                match: /\/repositories\/test-ws\/repo1\/diffstat\//,
                body: {
                    values: [
                        {
                            status: 'modified',
                            lines_added: 30,
                            lines_removed: 5,
                            new: {path: 'src/foo.ts'},
                            old: {path: 'src/foo.ts'},
                        },
                        {
                            status: 'added',
                            lines_added: 10,
                            lines_removed: 0,
                            new: {path: 'src/bar.ts'},
                            old: null,
                        },
                    ],
                },
            },
        ],
        expectedPaths: ['src/foo.ts', 'src/bar.ts'],
    },
    gitlab: {
        config: {
            type: 'gitlab',
            group: 'test-group',
            auth: {type: 'personal_access_token', token: 'tok'},
        },
        routes: [
            {
                match: /\/repository\/commits\?/,
                body: SHAS.map((id) => ({
                    id,
                    author_name: 'Alice',
                    author_email: AUTHOR_EMAIL,
                    authored_date: COMMIT_DATE,
                    message: 'feat: work',
                })),
            },
            {
                match: /\/repository\/commits\/[^/]+\/diff\?/,
                body: [
                    {
                        old_path: 'src/foo.ts',
                        new_path: 'src/foo.ts',
                        new_file: false,
                        renamed_file: false,
                        deleted_file: false,
                        diff: '@@ -1,2 +1,4 @@\n a\n+b\n+c\n-d\n',
                    },
                ],
            },
        ],
        expectedPaths: ['src/foo.ts'],
    },
};

describe('#280 GitCommit.diffs conformance across every provider type', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        // `restoreAllMocks` does NOT undo `stubGlobal`, and `unstubGlobals` is not set in
        // vitest.config.ts — without this the last stubbed `fetch` leaks into the next test.
        vi.unstubAllGlobals();
    });

    /**
     * The gate that makes the table self-maintaining. Without it a provider type added to
     * `GIT_PROVIDER_TYPES` with no fixture would make `FIXTURES[type]` `undefined` and the
     * per-type test throw a bare `TypeError` — a failure, but one that reads as a broken test
     * rather than as "your new provider is unverified".
     */
    it('has a fixture for every provider type createGitProvider supports', () => {
        expect(Object.keys(FIXTURES).sort()).toEqual([...GIT_PROVIDER_TYPES].sort());
    });

    it.each(GIT_PROVIDER_TYPES)(
        '%s: getCommits returns every commit with a populated diffs array',
        async (type) => {
            const fixture = FIXTURES[type];
            expect(fixture, `no #280 conformance fixture for provider type "${type}"`).toBeDefined();

            stubFetch(fixture.routes);
            const provider = createGitProvider(fixture.config);
            const commits = await provider.getCommits(REPO, SINCE, UNTIL);

            // Guards the assertions below against being vacuous: a fixture whose commit-list
            // route stopped matching would return `[]` and every `for` below would pass.
            expect(commits.map((c) => c.sha)).toEqual(SHAS);

            for (const commit of commits) {
                // The contract itself. `undefined` here is what sends the sync loop back to
                // `getCommitDiff` for a diff the provider already fetched.
                expect(Array.isArray(commit.diffs), `${type}/${commit.sha} supplied no diffs`).toBe(
                    true,
                );
                // …and it must be the REAL diff, not an empty array. `[]` is a legal value of
                // the field, but it means "no file-level detail is obtainable" — a provider
                // that returned it for a commit the stub gave files for has lost the diff.
                expect(commit.diffs?.map((d) => d.path)).toEqual(fixture.expectedPaths);
            }
        },
    );

    /**
     * The reuse path only saves a request if the provider's own diff walk was the LAST one. This
     * pins the count at the provider boundary — `diff-fetch-dedup.test.ts` pins it end-to-end
     * through the sync loop, but that file enumerates the three providers by hand, so only this
     * table would catch a fourth one that double-fetches inside `getCommits`.
     */
    it.each(GIT_PROVIDER_TYPES)(
        '%s: getCommits walks the per-commit diff endpoint at most once per commit',
        async (type) => {
            const fixture = FIXTURES[type];
            const {urls} = stubFetch(fixture.routes);

            await createGitProvider(fixture.config).getCommits(REPO, SINCE, UNTIL);

            for (const sha of SHAS) {
                // The per-commit endpoint differs per provider (GitHub's commit detail,
                // Bitbucket's diffstat, GitLab's diff), but all three embed the sha, and the
                // commit LIST url does not — so counting sha-bearing urls counts exactly the
                // per-commit fan-out.
                const perCommit = urls.filter((u) => u.includes(sha));
                expect(perCommit.length, `${type} fanned out ${perCommit.length}× for ${sha}`).toBe(
                    1,
                );
            }
        },
    );
});
