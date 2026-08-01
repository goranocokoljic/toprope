import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {GitHubProvider} from '../../../../src/connectors/git/providers/github';
// Imported from `types`, where they are DECLARED — the provider only consumes them.
import {
    NO_AUTHOR_DATE_DROP_REASON,
    UNATTRIBUTABLE_DATE_DROP_REASON,
} from '../../../../src/connectors/git/providers/types';
import {
    GIT_REQUEST_TIMEOUT_MS,
    INTERACTIVE_REQUEST_POLICY,
    MAX_SERVER_ERROR_RETRIES,
    PROBE_SERVER_ERROR_RETRIES,
    isRetryableGitFetchError,
} from '../../../../src/connectors/git/providers/http-retry';
import type {GitHubProviderConfig} from '../../../../src/connectors/git/providers/types';

const CONFIG: GitHubProviderConfig = {
    type: 'github',
    org: 'test-org',
    auth: {type: 'token', api_token: 'ghp_test'},
};

// --- Fixture helpers ---

function makeRepoFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 1001,
        name: 'my-repo',
        full_name: 'test-org/my-repo',
        default_branch: 'main',
        archived: false,
        ...overrides,
    };
}

function makeCommitListFixture(sha: string): Record<string, unknown> {
    return {
        sha,
        commit: {
            author: {name: 'Alice', email: 'alice@example.com', date: '2024-01-15T10:00:00Z'},
            message: 'feat: add feature',
        },
        author: {login: 'alice'},
    };
}

function makeCommitDetailFixture(
    sha: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        sha,
        commit: {
            author: {name: 'Alice', email: 'alice@example.com', date: '2024-01-15T10:00:00Z'},
            message: 'feat: add feature',
        },
        // DISTINCT from the list fixture's `alice` on purpose (#275 review cycle 2, TST-4).
        // GitHub returns the same top-level `author` on both endpoints, so the two agreeing was
        // realistic but untestable: `username` is read from the LIST row on both the cache-hit
        // and the fetch path — deliberately, so a warm run and a cold run cannot resolve
        // different logins and split one author across two `raw_author_daily` identities — and
        // with identical fixtures a regression that read the detail's copy passed every test.
        author: {login: 'detail-alice'},
        // Deliberately SKEWED from the `files` sum below (35/7, not 40/10). GitHub caps
        // `files` at 300 per commit while `stats` covers the whole commit, so the totals must
        // come from `stats` and must never be re-derived from the file list — with the two
        // agreeing, a regression that summed `files` passed every assertion in this file
        // (#288 review cycle 2, TST-4).
        stats: {additions: 40, deletions: 10, total: 50},
        files: [
            {filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
            {filename: 'src/bar.ts', additions: 5, deletions: 2, status: 'added'},
        ],
        ...overrides,
    };
}

function makePRFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        number: 42,
        title: 'feat: add feature',
        user: {login: 'alice'},
        state: 'open',
        created_at: '2024-01-15T09:00:00Z',
        // Distinct from created_at so the mapping assertion pins updatedAt to
        // `updated_at`, not `created_at`/`merged_at` (#247 review TST-1).
        updated_at: '2024-01-16T09:00:00Z',
        merged_at: null,
        closed_at: null,
        requested_reviewers: [{login: 'bob'}],
        ...overrides,
    };
}

function makeReviewCommentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        user: {login: 'bob'},
        body: 'LGTM!',
        created_at: '2024-01-15T11:00:00Z',
        ...overrides,
    };
}

// --- Mock fetch helper ---

function makeFetchMock(responses: Array<{body: unknown; headers?: Record<string, string>}>) {
    let callIndex = 0;
    return vi.fn().mockImplementation(() => {
        const resp = responses[callIndex++] ?? {body: [], headers: {}};
        const headers = new Headers(resp.headers ?? {});
        return Promise.resolve({
            ok: true,
            status: 200,
            headers,
            json: () => Promise.resolve(resp.body),
            text: () => Promise.resolve(String(resp.body)),
        } as unknown as Response);
    });
}

describe('GitHubProvider', () => {
    let provider: GitHubProvider;

    beforeEach(() => {
        provider = new GitHubProvider(CONFIG);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    // --- listRepos ---

    describe('listRepos()', () => {
        it('returns repos mapped to GitRepo shape', async () => {
            const fetchMock = makeFetchMock([{body: [makeRepoFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0]).toEqual({
                id: '1001',
                name: 'my-repo',
                fullName: 'test-org/my-repo',
                defaultBranch: 'main',
                isArchived: false,
            });
        });

        it('normalizes a padded/mis-cased org into the request path (#266)', async () => {
            // The org is both the attribution key and the request path. `providerContainer`
            // normalizes the former; the constructor normalizes the latter from the same shared
            // helper, so a YAML `org: '  Test-ORG '` cannot attribute rows to `test-org` while
            // fetching `/orgs/%20%20Test-ORG%20`.
            const fetchMock = makeFetchMock([{body: [makeRepoFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);
            const p = new GitHubProvider({...CONFIG, org: '  Test-ORG '});

            await p.listRepos();

            expect(String(fetchMock.mock.calls[0][0])).toContain('/orgs/test-org/');
        });

        it('excludes archived repos by default', async () => {
            const fetchMock = makeFetchMock([
                {body: [makeRepoFixture({archived: false}), makeRepoFixture({id: 1002, name: 'archived-repo', archived: true})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('my-repo');
        });

        it('follows Link header pagination', async () => {
            const fetchMock = makeFetchMock([
                {
                    body: [makeRepoFixture({id: 1, name: 'repo-a'})],
                    headers: {link: '<https://api.github.com/orgs/test-org/repos?page=2>; rel="next"'},
                },
                {
                    body: [makeRepoFixture({id: 2, name: 'repo-b'})],
                },
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(2);
            expect(repos.map((r) => r.name)).toEqual(['repo-a', 'repo-b']);
        });

        it('returns empty array for empty org', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toEqual([]);
        });

        it('applies include list filter', async () => {
            const p = new GitHubProvider({...CONFIG, repos: ['keep-me']});
            const fetchMock = makeFetchMock([
                {body: [makeRepoFixture({name: 'keep-me'}), makeRepoFixture({id: 2, name: 'skip-me'})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos.map((r) => r.name)).toEqual(['keep-me']);
        });

        it('applies exclude glob pattern filter', async () => {
            const p = new GitHubProvider({...CONFIG, exclude_repos: ['archived-*']});
            const fetchMock = makeFetchMock([
                {body: [makeRepoFixture({name: 'keep-me'}), makeRepoFixture({id: 2, name: 'archived-old'})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos.map((r) => r.name)).toEqual(['keep-me']);
        });

        it('excludes repos matching exact exclude name', async () => {
            const p = new GitHubProvider({...CONFIG, exclude_repos: ['skip-me']});
            const fetchMock = makeFetchMock([
                {body: [makeRepoFixture({name: 'keep-me'}), makeRepoFixture({id: 2, name: 'skip-me'})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos.map((r) => r.name)).toEqual(['keep-me']);
        });
    });

    // --- getCommits ---

    describe('getCommits()', () => {
        it('returns commits mapped to GitCommit shape', async () => {
            const sha = 'abc123';
            const fetchMock = makeFetchMock([
                {body: [makeCommitListFixture(sha)]},
                {body: makeCommitDetailFixture(sha)},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toHaveLength(1);
            expect(commits[0]).toEqual({
                sha: 'abc123',
                author: {name: 'Alice', email: 'alice@example.com', username: 'alice'},
                date: '2024-01-15T10:00:00Z',
                message: 'feat: add feature',
                additions: 40,
                deletions: 10,
                // The detail response's file list, carried out so the sync loop does not
                // re-request the identical /commits/{sha} URL (#271).
                diffs: [
                    {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                    {path: 'src/bar.ts', additions: 5, deletions: 2, status: 'added'},
                ],
                // The detail carried real `stats`, so the totals above are an OBSERVATION
                // rather than zero-by-absence (#288). Asserted here, in the one exhaustive
                // shape test, so a regression that stopped setting the flag on the happy path
                // — which would make every commit look unobserved to the sync — fails loudly.
                churnObserved: true,
            });
        });

        // --- diff reuse (#271) ---

        it('exposes diffs byte-identical to what getCommitDiff would return for the same sha', async () => {
            // Both paths now go through `toFileDiffs`, so this is a REGRESSION guard, not
            // an independent check: it fails if someone re-inlines a divergent mapping in
            // either function. The other divergence vector — the two paths' URLs drifting
            // apart — is covered by the request-URL count in diff-fetch-dedup.test.ts.
            const sha = 'abc123';
            vi.stubGlobal(
                'fetch',
                makeFetchMock([{body: [makeCommitListFixture(sha)]}, {body: makeCommitDetailFixture(sha)}]),
            );
            const commits = await provider.getCommits('my-repo', '', '');

            vi.stubGlobal('fetch', makeFetchMock([{body: makeCommitDetailFixture(sha)}]));
            const viaFallback = await provider.getCommitDiff('my-repo', sha);

            expect(commits[0].diffs).toEqual(viaFallback);
        });

        it('sets diffs to [] — not undefined — when the detail carries no files', async () => {
            // `[]` is the true answer ("touched no files"); undefined would send the sync
            // loop back to the same endpoint for nothing (#271).
            const sha = 'nofiles';
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture(sha)]},
                    {body: makeCommitDetailFixture(sha, {files: undefined})},
                ]),
            );

            const commits = await provider.getCommits('my-repo', '', '');

            expect(commits).toHaveLength(1);
            // `toEqual([])` fails on undefined too — the distinction the sync loop
            // branches on is fully covered by this one assertion.
            expect(commits[0].diffs).toEqual([]);
        });

        it('keeps additions/deletions from stats, not summed from the (300-file-capped) file list', async () => {
            // GitHub truncates `files` at 300 but `stats` covers the whole commit, so the
            // totals must NOT be re-derived from `diffs` now that it is exposed (#271).
            const sha = 'truncated';
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture(sha)]},
                    {
                        body: makeCommitDetailFixture(sha, {
                            stats: {additions: 9999, deletions: 8888, total: 18887},
                        }),
                    },
                ]),
            );

            const commits = await provider.getCommits('my-repo', '', '');

            expect(commits[0].additions).toBe(9999);
            expect(commits[0].deletions).toBe(8888);
            // …while the exposed diffs remain just the (partial) file list, which sums to
            // LESS than the totals — the whole point of not re-deriving them.
            expect(commits[0].diffs?.reduce((s, d) => s + d.additions, 0)).toBe(35);
        });

        it('follows Link header pagination for commit list', async () => {
            const sha1 = 'aaa111';
            const sha2 = 'bbb222';
            const fetchMock = makeFetchMock([
                // Page 1 of commit list
                {
                    body: [makeCommitListFixture(sha1)],
                    headers: {link: '<https://api.github.com/repos/test-org/my-repo/commits?page=2>; rel="next"'},
                },
                // Page 2 of commit list
                {body: [makeCommitListFixture(sha2)]},
                // Detail for sha1
                {body: makeCommitDetailFixture(sha1)},
                // Detail for sha2
                {body: makeCommitDetailFixture(sha2)},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toHaveLength(2);
            expect(commits[0].sha).toBe(sha1);
            expect(commits[1].sha).toBe(sha2);
        });

        it('returns empty array for empty repo (no commits)', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('empty-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toEqual([]);
        });

        // --- onProgress (#270) ---

        it('reports one listing tick per commit-list page, then one per detail fetch', async () => {
            const fetchMock = makeFetchMock([
                {
                    body: [makeCommitListFixture('aaa111')],
                    headers: {link: '<https://api.github.com/repos/test-org/my-repo/commits?page=2>; rel="next"'},
                },
                {body: [makeCommitListFixture('bbb222')]},
                {body: makeCommitDetailFixture('aaa111')},
                {body: makeCommitDetailFixture('bbb222')},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            await provider.getCommits('my-repo', '', '', onProgress);

            // Listing reports a running discovered count (1 after page 1, 2 after page
            // 2) with NO total — it isn't knowable until the last page. Then the
            // detail fan-out reports real done/total, seeded at 0 so an observer
            // switches to done/total before the first (slow) request.
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null},
                {done: 2, total: null},
                {done: 0, total: 2},
                {done: 1, total: 2},
                {done: 2, total: 2},
            ]);
        });

        it('still reaches total when a commit is dropped for having no author date', async () => {
            // aaa111 and ccc333 map normally; bbb222 carries no author date on EITHER copy of
            // the embedded `commit` object and is dropped by the `continue`. Two GitCommits come
            // back, but the counter must still reach 3/3 — a counter that stops short of its
            // total is exactly the "hung" symptom of #270.
            //
            // That `continue` is the only lossy branch left in this loop, and since #275 it is
            // not silent: the sha is reported through `onDrop` so the sync can surface it. A
            // failed detail fetch takes the other channel entirely — it throws (#272, review
            // cycle 3) rather than being swallowed, so it never reaches the counter.
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                const ok = (body: unknown): Response =>
                    ({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve(body),
                        text: () => Promise.resolve(''),
                    }) as unknown as Response;
                if (url.includes('/commits/aaa111')) {
                    return Promise.resolve(ok(makeCommitDetailFixture('aaa111')));
                }
                if (url.includes('/commits/bbb222')) {
                    return Promise.resolve(ok({sha: 'bbb222', commit: {author: null, message: 'm'}}));
                }
                if (url.includes('/commits/ccc333')) {
                    return Promise.resolve(ok(makeCommitDetailFixture('ccc333')));
                }
                return Promise.resolve(
                    ok([
                        makeCommitListFixture('aaa111'),
                        // Dateless on the list row too — with a date here the #275 fallback
                        // recovers the commit and nothing is dropped.
                        {sha: 'bbb222', commit: {author: null, message: 'm'}, author: {login: 'alice'}},
                        makeCommitListFixture('ccc333'),
                    ]),
                );
            });
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const onDrop = vi.fn();
            const pending = provider.getCommits('my-repo', '', '', onProgress, onDrop);
            await vi.runAllTimersAsync();
            const commits = await pending;

            expect(commits.map((c) => c.sha)).toEqual(['aaa111', 'ccc333']);
            expect(onProgress).toHaveBeenLastCalledWith({done: 3, total: 3});
            // The commit the counter walked past is named, not merely counted.
            expect(onDrop.mock.calls.map((c) => c[0])).toEqual([
                {sha: 'bbb222', reason: NO_AUTHOR_DATE_DROP_REASON},
            ]);
        });

        // The list and the detail return the IDENTICAL embedded `commit` object — the identity
        // the #273 cache-hit path already depends on. So a shape anomaly in ONE of two copies
        // is not a reason to lose the commit (#275): the list row answers, with no extra
        // request.
        //
        // Run over EVERY shape that makes the detail's copy unusable, not just the easy one.
        // The predicate is `detail.commit?.author && isAttributableDate(...)`, and a narrowing
        // of it to `!detail.commit` — which drops the commit permanently whenever `commit` is
        // present but its date is not usable — passed a suite that only covered the
        // `commit`-absent case (#275 review TST-1).
        // One row per DISTINCT term of the predicate, rather than several rows that all fail
        // the same one (#275 review cycle 2, OR-3): the optional chain, the day-shape check,
        // and the `Date.parse` check. `9999-99-99T…` is the only shape that passes the regex
        // and fails the parse, so without it that conjunct could be deleted with the suite
        // still green.
        const unusableDetailCommit: Array<[string, unknown]> = [
            ['`commit` absent entirely', undefined],
            [
                '`commit.author` present, date not a timestamp at all',
                {author: {name: 'D', email: 'd@e.com', date: 'unknown'}, message: 'from the detail'},
            ],
            [
                '`commit.author` present, date shaped like a day but not a real one',
                {
                    author: {name: 'D', email: 'd@e.com', date: '9999-99-99T00:00:00Z'},
                    message: 'from the detail',
                },
            ],
        ];

        it.each(unusableDetailCommit)(
            'recovers from the list row already in hand when the detail has %s',
            async (_shape, commitField) => {
                // Every field is DISTINCT from `makeCommitDetailFixture`'s (and from the
                // detail's own decoy `commit` above), so these assertions can only pass if the
                // list row is what was actually read.
                const listRow = {
                    sha: 'aaa111',
                    commit: {
                        author: {
                            name: 'List Alice',
                            email: 'list-alice@example.com',
                            date: '2024-02-20T08:30:00Z',
                        },
                        message: 'fix: from the list row',
                    },
                    author: {login: 'list-alice'},
                };
                // Real stats/files, so the churn numbers still come from the detail while the
                // identity comes from the list row.
                const detail: Record<string, unknown> = {
                    sha: 'aaa111',
                    author: null,
                    stats: {additions: 7, deletions: 3, total: 10},
                    files: [{filename: 'src/x.ts', additions: 7, deletions: 3, status: 'modified'}],
                };
                if (commitField !== undefined) detail.commit = commitField;
                const fetchMock = makeFetchMock([{body: [listRow]}, {body: detail}]);
                vi.stubGlobal('fetch', fetchMock);

                const onDrop = vi.fn();
                const commits = await provider.getCommits('my-repo', '', '', undefined, onDrop);

                expect(commits).toHaveLength(1);
                expect(commits[0].date).toBe('2024-02-20T08:30:00Z');
                expect(commits[0].author.name).toBe('List Alice');
                expect(commits[0].author.email).toBe('list-alice@example.com');
                expect(commits[0].message).toBe('fix: from the list row');
                // `author.login` always comes from the list row — see the no-mixing test below.
                expect(commits[0].author.username).toBe('list-alice');
                // The detail still supplied the churn, so the recovery is not a degraded row.
                expect(commits[0].additions).toBe(7);
                // Full entries, not just paths: a recovery that kept the path list but lost
                // the per-file churn would zero `code_churn_rate` downstream and still pass a
                // path-only check.
                expect(commits[0].diffs).toEqual([
                    {path: 'src/x.ts', additions: 7, deletions: 3, status: 'modified'},
                ]);
                // Nothing was lost, so nothing is reported…
                expect(onDrop).not.toHaveBeenCalled();
                // …and the recovery cost no extra request: list + one detail, as always.
                expect(fetchMock).toHaveBeenCalledTimes(2);
            },
        );

        it('recovers with an empty username when neither copy names a GitHub user', async () => {
            // The other arm of the login read (#275 review TST-5): recovery from the list row
            // must not invent a username when the list row has none either.
            const listRow = {
                sha: 'aaa111',
                commit: {
                    author: {name: 'A', email: 'a@e.com', date: '2024-02-20T08:30:00Z'},
                    message: 'm',
                },
                author: null,
            };
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [listRow]},
                    // Real `stats` — a body with neither a usable `commit` NOR stats now throws
                    // rather than being recovered, so the recovery path is only reachable here
                    // with the churn actually present.
                    {body: {sha: 'aaa111', author: null, stats: {additions: 1, deletions: 0, total: 1}}},
                ]),
            );

            const commits = await provider.getCommits('my-repo', '', '');

            expect(commits).toHaveLength(1);
            expect(commits[0].author.username).toBe('');
        });

        it('classifies the reason from the DETAIL copy when only it carries a date', async () => {
            // The other operand of `hasDate(detail…) || hasDate(list…)` (#275 review cycle 3,
            // TST-4): narrowing the disjunction to the list row alone left the suite green, and
            // would report a real commit with a garbled timestamp as a truncated response.
            const garbled = {
                author: {name: 'A', email: 'a@e.com', date: '9999-99-99T00:00:00Z'},
                message: 'm',
            };
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    // List row: no embedded object at all.
                    {body: [{sha: 'aaa111', author: {login: 'alice'}}]},
                    // Detail: present, with a date that is shaped like a day but is not one.
                    {body: {sha: 'aaa111', commit: garbled, author: {login: 'alice'}, stats: {additions: 1, deletions: 0, total: 1}}},
                ]),
            );

            const onDrop = vi.fn();
            const commits = await provider.getCommits('my-repo', '', '', undefined, onDrop);

            expect(commits).toEqual([]);
            expect(onDrop).toHaveBeenCalledWith({
                sha: 'aaa111',
                reason: UNATTRIBUTABLE_DATE_DROP_REASON,
            });
        });

        it('classifies the reason from EITHER copy carrying a date, not just the detail', async () => {
            // The reason is chosen by `hasDate(detail…) || hasDate(list…)`, and every other
            // fixture makes the two copies agree, so `||` could be narrowed to either operand
            // with the suite still green (#275 review cycle 2, TST-3). This is the mixed shape:
            // the detail body is truncated (no `commit` at all) while the LIST row carries a
            // garbled date. A date IS present, so the operator should be sent to inspect the
            // commit — not told the response was truncated.
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {
                        body: [
                            {
                                sha: 'aaa111',
                                commit: {author: {name: 'A', email: 'a@e.com', date: 'unknown'}, message: 'm'},
                                author: {login: 'alice'},
                            },
                        ],
                    },
                    {body: {sha: 'aaa111', stats: {additions: 1, deletions: 0, total: 1}, files: []}},
                ]),
            );

            const onDrop = vi.fn();
            const commits = await provider.getCommits('my-repo', '', '', undefined, onDrop);

            expect(commits).toEqual([]);
            expect(onDrop).toHaveBeenCalledWith({
                sha: 'aaa111',
                reason: UNATTRIBUTABLE_DATE_DROP_REASON,
            });
        });

        it('refuses a cache HIT when the list row date is unusable, even with a memo present', async () => {
            // #275 review cycle 3, TST-1 — the highest-consequence gate in this loop, and the
            // only one where a hit/miss divergence is FATAL rather than cosmetic.
            //
            // The hit gate reads the LIST row's date, which is the row it would then build the
            // whole commit from. If the gate only checked presence (the pre-#275 code), a memo
            // written on a cold run — where the DETAIL supplied a good date — would on the next
            // warm run be served alongside the list row's UNUSABLE date. That commit then reaches
            // `raw_author_daily`, whose validator THROWS inside the run's single all-providers
            // write transaction: every provider's window rolls back, and because
            // `commit_diffstats` has no invalidation the hit recurs forever. The connector is
            // bricked permanently.
            const badDate = '+033658-09-27T00:00:00.000Z';
            const cache = {
                load: vi
                    .fn()
                    .mockReturnValue(
                        new Map([['aaa111', {additions: 5, deletions: 1, entries: [], absent: false}]]),
                    ),
                put: vi.fn(),
            };
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            const fetchMock = makeFetchMock([
                {
                    body: [
                        {
                            sha: 'aaa111',
                            commit: {author: {name: 'A', email: 'a@e.com', date: badDate}, message: 'm'},
                            author: {login: 'alice'},
                        },
                    ],
                },
                // The detail carries a GOOD date, so the commit is importable — via the fetch.
                {body: makeCommitDetailFixture('aaa111')},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await cachingProvider.getCommits('my-repo', '', '');

            // The memo was NOT served: the detail was requested (2 calls, not 1)…
            expect(fetchMock).toHaveBeenCalledTimes(2);
            // …so the commit carries the detail's usable date, never the list row's bad one.
            expect(commits).toHaveLength(1);
            expect(commits[0].date).toBe('2024-01-15T10:00:00Z');
            expect(commits[0].date).not.toBe(badDate);
            // And the churn is the freshly-fetched value, not the memo's 5/1.
            expect(commits[0].additions).toBe(40);
        });

        it('classifies a null or empty date as ABSENT, not as present-but-unattributable', async () => {
            // `date: null` / `date: ''` are what a garbled body actually yields, and calling
            // them "present" inverts the only distinction the two reasons draw (#275 review
            // cycle 2, SO-6/SEC-6). Asserted against a literal as well as the constant, so
            // swapping the two sentences cannot pass.
            const nullDate = {author: {name: 'A', email: 'a@e.com', date: null}, message: 'm'};
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [{sha: 'aaa111', commit: nullDate, author: null}]},
                    {body: {sha: 'aaa111', commit: nullDate, author: null, stats: {additions: 0, deletions: 0, total: 0}}},
                ]),
            );

            const onDrop = vi.fn();
            await provider.getCommits('my-repo', '', '', undefined, onDrop);

            expect(onDrop).toHaveBeenCalledWith({
                sha: 'aaa111',
                reason: NO_AUTHOR_DATE_DROP_REASON,
            });
            expect(onDrop.mock.calls[0][0].reason).toContain('no author date on any copy');
        });

        it('drops a commit whose date is PRESENT but unattributable, with its own reason', async () => {
            // The date must be shape-pinned here, not merely present (#275 review SEC-1). An
            // ISO 8601 expanded year round-trips through Date but `slice(0, 10)` turns it into
            // a day `raw_author_daily` rejects by THROWING — inside the run's single write
            // transaction, which rolls back every provider's window and does so again on every
            // subsequent run. Caught here it costs one reported commit instead of the whole
            // git connector.
            const bad = {
                author: {name: 'A', email: 'a@e.com', date: '+033658-09-27T00:00:00.000Z'},
                message: 'far future',
            };
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [{sha: 'aaa111', commit: bad, author: {login: 'alice'}}]},
                    {body: {sha: 'aaa111', commit: bad, author: {login: 'alice'}}},
                ]),
            );

            const onDrop = vi.fn();
            const commits = await provider.getCommits('my-repo', '', '', undefined, onDrop);

            expect(commits).toEqual([]);
            // A DISTINCT reason from the absent-date case — the operator's next step differs.
            expect(onDrop).toHaveBeenCalledWith({
                sha: 'aaa111',
                reason: UNATTRIBUTABLE_DATE_DROP_REASON,
            });
            expect(UNATTRIBUTABLE_DATE_DROP_REASON).not.toBe(NO_AUTHOR_DATE_DROP_REASON);
        });

        it('THROWS on a body with neither a usable commit nor stats, rather than inventing zero churn', async () => {
            // #275 review cycle 2, SO-1. A 200 carrying neither is a malformed RESPONSE, not a
            // fact about the commit, so it belongs to the recoverable channel. Recovering it
            // was the trap: `additions`/`deletions`/`diffs` are read off that same body, so the
            // commit would land in `raw_author_daily` — additive, append-only, cursor already
            // advanced — with 0 churn, permanently and silently. Throwing sends it to the 5xx
            // budget, then the in-run repo retry (where a truncated body heals), then #231.
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            const listRow = {
                sha: 'aaa111',
                commit: {
                    author: {name: 'A', email: 'a@e.com', date: '2024-02-20T08:30:00Z'},
                    message: 'm',
                },
                author: {login: 'alice'},
            };
            // A degenerate detail: the sha and nothing else usable.
            vi.stubGlobal(
                'fetch',
                makeFetchMock([{body: [listRow]}, {body: {sha: 'aaa111'}}]),
            );

            const onDrop = vi.fn();
            const err: unknown = await cachingProvider
                .getCommits('my-repo', '', '', undefined, onDrop)
                .then(() => null)
                .catch((e: unknown) => e);

            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain('malformed response');
            // RETRYABLE, so the fault reaches the request budget and the in-run repo retry
            // rather than failing the repo outright — that is the whole point of routing a
            // malformed body through the throw channel instead of the drop channel.
            expect(isRetryableGitFetchError(err)).toBe(true);
            // Not a drop: the commit may still be recoverable, so claiming a permanent loss
            // would be false.
            expect(onDrop).not.toHaveBeenCalled();
            // And nothing was memoized — the zeros never reach the cache either.
            expect(put).not.toHaveBeenCalled();
        });

        it('recovers AND memoizes when the body is malformed but its stats are real', async () => {
            // The other side of the throw above, and the positive control for the whole #273
            // ratchet: because the recovery path only ever reaches the `put` with real stats in
            // hand (the throw sends the alternative away), the memo gate #288 added is always
            // satisfied here. Deleting the `put` would silently disable the ratchet.
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            const listRow = {
                sha: 'aaa111',
                commit: {
                    author: {name: 'A', email: 'a@e.com', date: '2024-02-20T08:30:00Z'},
                    message: 'm',
                },
                author: {login: 'alice'},
            };
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [listRow]},
                    // No `commit` (identity comes from the list row) but REAL stats.
                    {
                        body: {
                            sha: 'aaa111',
                            stats: {additions: 9, deletions: 2, total: 11},
                            files: [{filename: 'src/z.ts', additions: 9, deletions: 2, status: 'modified'}],
                        },
                    },
                ]),
            );

            const commits = await cachingProvider.getCommits('my-repo', '', '');

            expect(commits).toHaveLength(1);
            expect(commits[0].additions).toBe(9);
            expect(put).toHaveBeenCalledWith('my-repo', 'aaa111', {
                additions: 9,
                deletions: 2,
                entries: [{path: 'src/z.ts', additions: 9, deletions: 2, status: 'modified'}],
                absent: false,
            });
        });

        it('DOES memoize a fully well-formed detail — the ratchet is intact', async () => {
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture('aaa111')]},
                    {body: makeCommitDetailFixture('aaa111')},
                ]),
            );

            await cachingProvider.getCommits('my-repo', '', '');

            expect(put).toHaveBeenCalledWith('my-repo', 'aaa111', {
                additions: 40,
                deletions: 10,
                entries: [
                    {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                    {path: 'src/bar.ts', additions: 5, deletions: 2, status: 'added'},
                ],
                absent: false,
            });
        });

        it('KEEPS but does not memoize a usable commit whose detail carries no stats', async () => {
            // #288, the shape #275 left open and the one this issue exists to settle. GitHub's
            // published response schema does not mark `stats` required, so an absent `stats` is
            // not evidence of a malformed body and must not throw — a throw would hold the
            // provider's forward cursor forever on a shape every re-fetch reproduces.
            //
            // What it must NOT do is memoize the zero. `commit_diffstats` has no invalidation,
            // so a row written here answers for this commit on every later run, in place of the
            // well-formed detail that would have contradicted it — which is exactly the
            // "a later well-formed fetch would contradict it" case.
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture('aaa111')]},
                    // A usable `commit` object — so the malformed-body throw does not fire —
                    // and NO `stats`/`files` key at all.
                    {
                        body: {
                            sha: 'aaa111',
                            commit: {
                                author: {
                                    name: 'Alice',
                                    email: 'alice@example.com',
                                    date: '2024-01-15T10:00:00Z',
                                },
                                message: 'feat: add feature',
                            },
                            author: {login: 'detail-alice'},
                        },
                    },
                ]),
            );

            const onDrop = vi.fn();
            const commits = await cachingProvider.getCommits('my-repo', '', '', undefined, onDrop);

            // 1. The commit is KEPT, with its real identity — it is not a drop and not a throw.
            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe('aaa111');
            expect(commits[0].date).toBe('2024-01-15T10:00:00Z');
            expect(onDrop).not.toHaveBeenCalled();
            // 2. Churn is zero BY ABSENCE — the only value the required numeric field can hold.
            expect(commits[0].additions).toBe(0);
            expect(commits[0].deletions).toBe(0);
            // 3. NOTHING is memoized, so a later run re-asks the endpoint.
            expect(put).not.toHaveBeenCalled();
            // 4. And the zero is not silent — the row says the totals were not observed.
            expect(commits[0].churnObserved).toBe(false);
            // 5. `diffs` stays `[]`, NOT undefined. `undefined` would send the sync's
            // `getCommitDiff` fallback back to this same endpoint for the same sha (one wasted
            // request per degraded commit per run) and file the provider under
            // DIFFS_NOT_SUPPLIED_PREFIX, which diagnoses a contract violation that did not
            // happen.
            expect(commits[0].diffs).toEqual([]);
        });

        it('treats an OBSERVED zero as observed — it memoizes and flags nothing', async () => {
            // The control that gives the test above its meaning, and the empirical distinction
            // the whole #288 decision rests on: a genuinely empty commit returns
            // `stats: {additions: 0, deletions: 0, total: 0}` — a PRESENT key — so absence and
            // observed-zero are distinguishable in the body. Gate the memo on
            // `additions === 0` instead of on the shape of `stats` and only this test fails.
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture('aaa111')]},
                    {
                        body: makeCommitDetailFixture('aaa111', {
                            stats: {additions: 0, deletions: 0, total: 0},
                            files: [],
                        }),
                    },
                ]),
            );

            const commits = await cachingProvider.getCommits('my-repo', '', '');

            expect(commits).toHaveLength(1);
            expect(commits[0].additions).toBe(0);
            expect(commits[0].churnObserved).toBe(true);
            // Observed, so it IS memoized — re-asking would return the same zero forever.
            expect(put).toHaveBeenCalledWith('my-repo', 'aaa111', {
                additions: 0,
                deletions: 0,
                entries: [],
                absent: false,
            });
        });

        it.each([
            ['an explicit null', null],
            ['an empty object', {}],
            ['non-numeric values', {additions: '40', deletions: '10', total: '50'}],
            ['a NaN total', {additions: Number.NaN, deletions: 0, total: Number.NaN}],
            ['a fractional count', {additions: 4.5, deletions: 0, total: 4.5}],
            ['a negative count', {additions: -5, deletions: 0, total: -5}],
            [
                'a count past the safe-integer ceiling',
                {additions: Number.MAX_SAFE_INTEGER + 2, deletions: 0, total: 0},
            ],
            // The `deletions` conjunct decides this row and nothing else in the repo (#288
            // review cycle 3, TST-288-A). Every case above puts the offending value in
            // `additions`, which short-circuits the `&&` — so deleting
            // `isCommitCount(rawStats.deletions)` from the guard left the whole 974-test git
            // suite green, while `deletions: 4.5` would still reach `raw_author_daily` and
            // throw inside the run's all-providers write transaction.
            ['a malformed deletions beside a good additions', {additions: 40, deletions: -3, total: 37}],
        ])('treats stats as UNOBSERVED when the body carries %s', async (_label, stats) => {
            // #288 review cycle 1 (SO-1 / SEC-1 / SEC-3). The guard used to be
            // `stats === undefined`, which recognizes exactly ONE spelling of an absence the
            // issue itself says GitHub does not document. Every input here satisfies
            // `!== undefined`, so under that guard each one took the memoize branch and wrote a
            // fabricated `0`/`0` into a table with no invalidation — the precise outcome this
            // issue exists to prevent, reintroduced through the spellings the guard did not
            // enumerate. `'40'` is the sharpest of the shape cases: typed `number` by the
            // unchecked cast, it string-concatenates through the analyzer's `reduce` and reaches
            // `raw_author_daily` as a garbage integer; `4.5` throws there, inside the run's
            // write transaction.
            //
            // The last two are the DOMAIN cases (#288 review cycle 2, SO-1/SEC-1/TST-1), which a
            // shape-only `Number.isInteger` waved through while calling itself parity with
            // `raw_author_daily` — which enforces `>= 0`. A negative is the worse of the two: it
            // would be flagged OBSERVED (so no advisory names it), silently refused by the memo
            // (`diffstat-cache` drops a non-count without counting a fault), and still summed
            // into the developer-day, where a net-negative throws inside the write transaction
            // on every run forever. Above the safe-integer ceiling the value clears every
            // integrality test and fails at better-sqlite3 bind time instead. Both are why the
            // predicate is the SHARED `isCommitCount` rather than a local test.
            //
            // Revert the guard to `=== undefined`, or drop either bound from `isCommitCount`,
            // and cases here fail; nothing else in the suite does.
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture('aaa111')]},
                    {body: makeCommitDetailFixture('aaa111', {stats, files: []})},
                ]),
            );

            const commits = await cachingProvider.getCommits('my-repo', '', '');

            // The commit is still kept — an unrecognized shape degrades, it does not throw.
            expect(commits).toHaveLength(1);
            expect(commits[0].churnObserved).toBe(false);
            // …and the fabricated zero never reaches the totals or the memo.
            expect(commits[0].additions).toBe(0);
            expect(commits[0].deletions).toBe(0);
            expect(put).not.toHaveBeenCalled();
        });

        it('THROWS on an unusable commit object plus a null stats, not just an absent one', async () => {
            // The same widening applied to the #275 malformed-body guard, which shares the
            // `stats` classification. A body with NEITHER a usable `commit` NOR observable stats
            // is malformed however the second half is spelled; keying on `=== undefined` let
            // `{commit: null, stats: null}` — a body with no evidence of usability at all — be
            // silently recovered as a zero-churn commit.
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture('aaa111')]},
                    {body: {sha: 'aaa111', commit: null, author: null, stats: null}},
                ]),
            );

            const err: unknown = await cachingProvider
                .getCommits('my-repo', '', '')
                .then(() => null)
                .catch((e: unknown) => e);

            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain('malformed response');
            expect(isRetryableGitFetchError(err)).toBe(true);
            expect(put).not.toHaveBeenCalled();
        });

        it('withholds the memo on absent stats even when the detail DID carry files', async () => {
            // The gate is `stats`, not the whole body. A detail with real `files` but no `stats`
            // is the worst thing to memoize: the row would carry genuine `entries` beside a
            // fabricated `0`/`0`, so it would LOOK observed on every later read. The file list is
            // still handed back on `GitCommit.diffs` — it was really fetched — but no row is
            // written and the commit is flagged unobserved.
            const put = vi.fn();
            const cache = {load: vi.fn().mockReturnValue(new Map()), put};
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture('aaa111')]},
                    {
                        body: {
                            sha: 'aaa111',
                            commit: {
                                author: {
                                    name: 'Alice',
                                    email: 'alice@example.com',
                                    date: '2024-01-15T10:00:00Z',
                                },
                                message: 'feat: add feature',
                            },
                            author: {login: 'detail-alice'},
                            files: [
                                {filename: 'src/foo.ts', additions: 12, deletions: 3, status: 'modified'},
                            ],
                        },
                    },
                ]),
            );

            const commits = await cachingProvider.getCommits('my-repo', '', '');

            expect(put).not.toHaveBeenCalled();
            expect(commits[0].churnObserved).toBe(false);
            // The file detail is NOT discarded — `diffs` is what spares the sync a second
            // request for the same endpoint, and it is real here even though the totals are not.
            expect(commits[0].diffs).toEqual([
                {path: 'src/foo.ts', additions: 12, deletions: 3, status: 'modified'},
            ]);
            // The totals are still zero: they are NEVER re-derived from `files`, which GitHub
            // truncates at 300 per page.
            expect(commits[0].additions).toBe(0);
        });

        it('never flags a DROPPED commit as unobserved — the two reports are exclusive', async () => {
            // #288 review cycle 1, TST-4. A commit with no usable author date is dropped at the
            // guard ABOVE the churn classification, so it never reaches the flag. That ordering
            // is what stops one sha producing both a "commit dropped" line (it is missing) and a
            // "churn unobserved" line (its developer-day is short) — two advisories with
            // different remedies, one of which would be describing a day that was never written.
            //
            // The fixture is deliberately BOTH: dateless on both copies AND stats-less.
            const dateless = {author: null, message: 'unattributable'};
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [{sha: 'aaa111', commit: dateless, author: null}]},
                    {body: {sha: 'aaa111', commit: dateless, author: null}},
                ]),
            );

            const onDrop = vi.fn();
            const commits = await provider.getCommits('my-repo', '', '', undefined, onDrop);

            // Dropped, so there is no row at all to carry a flag.
            expect(commits).toEqual([]);
            expect(onDrop).toHaveBeenCalledWith({
                sha: 'aaa111',
                reason: NO_AUTHOR_DATE_DROP_REASON,
            });
        });

        it('leaves a cache HIT unflagged — a warm run must not report every commit', async () => {
            // #288 review cycle 2, TST-3. The hit path deliberately omits `churnObserved`, and
            // the comment there makes a load-bearing claim about why ("every row this can hit is
            // an observation"). The sync filters on `churnObserved === false`, so a hit row that
            // ever acquired the flag would emit a COMMIT_CHURN_UNKNOWN line for every warm commit
            // on every warm run — the advisory going loud on healthy data, which is how an
            // operator learns to ignore it.
            const cache = {
                load: vi
                    .fn()
                    .mockReturnValue(
                        new Map([['aaa111', {additions: 5, deletions: 1, entries: [], absent: false}]]),
                    ),
                put: vi.fn(),
            };
            const cachingProvider = new GitHubProvider(CONFIG, {diffstatCache: cache});
            const fetchMock = makeFetchMock([{body: [makeCommitListFixture('aaa111')]}]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await cachingProvider.getCommits('my-repo', '', '');

            // The memo really was served — one request, no detail fetch — so this is the hit
            // path and not a silent fall-through to the miss path.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(commits[0].additions).toBe(5);
            // …and the row does not claim the churn went unobserved.
            expect(commits[0].churnObserved).not.toBe(false);
        });

        it('flags and withholds the memo with no cache attached at all', async () => {
            // Every probe path (doctor, test-connection) constructs the provider with no
            // diffstat cache. The classification must not depend on one being present.
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitListFixture('aaa111')]},
                    {body: makeCommitDetailFixture('aaa111', {stats: undefined, files: undefined})},
                ]),
            );

            const commits = await provider.getCommits('my-repo', '', '');

            expect(commits).toHaveLength(1);
            expect(commits[0].additions).toBe(0);
            expect(commits[0].churnObserved).toBe(false);
        });

        it('drops nothing when no drop listener is supplied — a short list is still short', async () => {
            // `onDrop` is optional, and an absent listener must not change WHICH commits come
            // back (every probe path — doctor, test-connection — supplies none).
            const dateless = {sha: 'aaa111', commit: {author: null, message: 'm'}, author: null};
            vi.stubGlobal('fetch', makeFetchMock([{body: [dateless]}, {body: dateless}]));

            await expect(provider.getCommits('my-repo', '', '')).resolves.toEqual([]);
        });

        it('ticks the counter for a commit whose detail fetch throws, before propagating', async () => {
            // The tick lives in a `finally`, so the observer is not left one short of the commit
            // that failed — it sees `2/3` and then the fetch rejects, rather than freezing at 1/3
            // with no explanation (#270 + #272 review cycle 3).
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                const ok = (body: unknown): Response =>
                    ({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve(body),
                        text: () => Promise.resolve(''),
                    }) as unknown as Response;
                if (url.includes('/commits/aaa111')) {
                    return Promise.resolve(ok(makeCommitDetailFixture('aaa111')));
                }
                if (url.includes('/commits/bbb222')) {
                    return Promise.resolve({
                        ok: false,
                        status: 500,
                        headers: new Headers(),
                        json: () => Promise.resolve({}),
                        text: () => Promise.resolve('boom'),
                    } as unknown as Response);
                }
                return Promise.resolve(
                    ok([
                        makeCommitListFixture('aaa111'),
                        makeCommitListFixture('bbb222'),
                        makeCommitListFixture('ccc333'),
                    ]),
                );
            });
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const pending = provider.getCommits('my-repo', '', '', onProgress);
            const settled = expect(pending).rejects.toThrow('GitHub API server error 500');
            await vi.runAllTimersAsync();
            await settled;

            // ccc333 was never reached, so the counter stops at the failing commit — not at its
            // predecessor, which is what the `finally` buys.
            expect(onProgress).toHaveBeenLastCalledWith({done: 2, total: 3});
        });

        it('reports an empty repo as a real zero total, not a suppressed step', async () => {
            vi.stubGlobal('fetch', makeFetchMock([{body: []}]));

            const onProgress = vi.fn();
            await provider.getCommits('empty-repo', '', '', onProgress);

            // Providers do NOT pre-filter an empty set — they report `total: 0`
            // truthfully and the consumer decides not to render a counter for it
            // (repoStepCount in AdminGitProviders). Keeping the guard here as well
            // would be two places to forget it.
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 0, total: null},
                {done: 0, total: 0},
            ]);
        });

        it('drops a commit with no author date on either copy, and reports the sha', async () => {
            // The one remaining loss GitHub can produce (#275). Both copies of the embedded
            // object are dateless, so there is no fallback — and `raw_author_daily` is keyed by
            // (raw identity, DATE), so there is genuinely nowhere to put this commit. It is
            // dropped, but it is NAMED: the sync turns this into an `errors[]` advisory rather
            // than letting the commit vanish behind an already-advanced cursor.
            const sha = 'abc123';
            const datelessEmbedded = {author: null, message: 'msg'};
            const fetchMock = makeFetchMock([
                {body: [{sha, commit: datelessEmbedded, author: {login: 'alice'}}]},
                {
                    body: {
                        sha,
                        commit: datelessEmbedded,
                        author: {login: 'alice'},
                        stats: {additions: 0, deletions: 0, total: 0},
                        files: [],
                    },
                },
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const commits = await provider.getCommits(
                'my-repo',
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
                undefined,
                onDrop,
            );

            expect(commits).toEqual([]);
            expect(onDrop).toHaveBeenCalledTimes(1);
            expect(onDrop).toHaveBeenCalledWith({sha, reason: NO_AUTHOR_DATE_DROP_REASON});
        });

        it('reports no drop for a commit whose detail fetch FAILS — that fault throws instead', async () => {
            // The two loss channels must stay disjoint. A recoverable fault must reach #231's
            // cursor hold, never the drop report: reporting it as a permanent loss over a window
            // that is about to be re-covered would be false, and swallowing it into a drop is
            // precisely the silent-gap bug #275 was filed about.
            const onDrop = vi.fn();
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/commits/abc123')) {
                    return Promise.resolve({
                        ok: false,
                        status: 404,
                        headers: new Headers(),
                        text: () => Promise.resolve('not found'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([makeCommitListFixture('abc123')]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            await expect(
                provider.getCommits('my-repo', '', '', undefined, onDrop),
            ).rejects.toThrow('GitHub API error 404');
            expect(onDrop).not.toHaveBeenCalled();
        });

        it('surfaces error when all per-commit detail fetches fail (no partial success)', async () => {
            // When every detail fetch fails (systemic error), getCommits throws rather
            // than silently returning []. If some succeed and some fail, the successes
            // are returned and the failing commits are individually skipped.
            const sha = 'abc123';
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve([makeCommitListFixture(sha)]),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    headers: new Headers(),
                    text: () => Promise.resolve('not found'),
                } as unknown as Response);
            }));

            await expect(
                provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z'),
            ).rejects.toThrow('GitHub API error 404');
        });

        it('throws on a PARTIAL detail failure instead of returning a silently short list', async () => {
            // Was "skips individual failing commits when some succeed" (#272, review cycle 3).
            // On GitHub the detail response IS the commit, so a swallowed failure dropped the
            // commit outright — and because `getCommits` then returned normally, `commitsComplete`
            // stayed true and the cursor advanced past the gap, making the loss permanent. The
            // in-run repo retry made partial success the LIKELY outcome of a healing outage, so
            // the swallow had to go: the fault must reach the retry, and if it never heals it must
            // reach #231's cursor hold. A 404 is included deliberately — a sha GitHub's own commit
            // list just returned is not legitimately absent.
            const sha1 = 'aaa111';
            const sha2 = 'bbb222';
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    // Commit list with two entries
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve([makeCommitListFixture(sha1), makeCommitListFixture(sha2)]),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                if (callCount === 2) {
                    // First detail succeeds
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve(makeCommitDetailFixture(sha1)),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                // Second detail fails, even though the first succeeded.
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    headers: new Headers(),
                    text: () => Promise.resolve('not found'),
                } as unknown as Response);
            }));

            await expect(
                provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z'),
            ).rejects.toThrow('GitHub API error 404');
        });

        it('throws when all per-commit detail fetches fail (systemic error)', async () => {
            const sha = 'abc123';
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve([makeCommitListFixture(sha)]),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    headers: new Headers(),
                    text: () => Promise.resolve('unauthorized'),
                } as unknown as Response);
            }));

            await expect(
                provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z'),
            ).rejects.toThrow('GitHub API error 401');
        });

        it('returns an empty username when GitHub links no user, even though a git author exists', async () => {
            // `commit.author` (the git author) and `author` (the linked GitHub user) are
            // different things: a merge bot commits under a git identity with no GitHub user
            // linked, and `''` is the right answer for the latter.
            //
            // BOTH copies carry `author: null` here, deliberately (#275 review SO-4). The
            // top-level `author` is the same embedded object on the list and the detail
            // endpoint, so that is the only shape GitHub can actually return — and since #275
            // the login is read from the list row on the cache-hit path AND the fetch path, a
            // fixture that disagreed between them would pin a divergence that cannot occur
            // while hiding the invariant that matters: a warm run and a cold run must resolve
            // the same login, or `raw_author_daily` (which keys on login in preference to
            // email) splits one author's history across two raw identities.
            const sha = 'abc123';
            const detailWithBot: Record<string, unknown> = {
                sha,
                commit: {
                    author: {name: 'Merge Bot', email: 'bot@github.com', date: '2024-01-15T10:00:00Z'},
                    message: 'merge commit',
                },
                author: null, // no GitHub user linked
                stats: {additions: 5, deletions: 0, total: 5},
                files: [],
            };
            const fetchMock = makeFetchMock([
                {body: [{...makeCommitListFixture(sha), author: null}]},
                {body: detailWithBot},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits[0].author.username).toBe('');
            expect(commits[0].author.name).toBe('Merge Bot');
            expect(commits[0].author.email).toBe('bot@github.com');
        });
    });

    // --- getPullRequests ---

    describe('getPullRequests()', () => {
        it('returns PRs mapped to GitPR shape', async () => {
            const fetchMock = makeFetchMock([{body: [makePRFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs).toHaveLength(1);
            expect(prs[0]).toEqual({
                id: '42',
                title: 'feat: add feature',
                author: {name: '', email: '', username: 'alice'},
                state: 'open',
                createdAt: '2024-01-15T09:00:00Z',
                mergedAt: null,
                closedAt: null,
                updatedAt: '2024-01-16T09:00:00Z',
                reviewers: [{name: '', email: '', username: 'bob'}],
                // additions/deletions are not returned by the PR list endpoint
                additions: 0,
                deletions: 0,
            });
        });

        it('reports one listing tick per PR page, including the page that hits the cutoff (#270)', async () => {
            const fetchMock = makeFetchMock([
                {
                    body: [makePRFixture({number: 1, updated_at: '2024-02-01T00:00:00Z'})],
                    headers: {link: '<https://api.github.com/repos/test-org/my-repo/pulls?page=2>; rel="next"'},
                },
                // Page 2's PR predates `since`, so the walk stops here — but the page
                // must still report, otherwise the last observed count is stale.
                {body: [makePRFixture({number: 2, updated_at: '2023-01-01T00:00:00Z'})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z', onProgress);

            expect(prs).toHaveLength(1);
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null},
                {done: 1, total: null},
            ]);
        });

        it('normalizes merged PR state: closed + merged_at → merged', async () => {
            const mergedPR = makePRFixture({
                state: 'closed',
                merged_at: '2024-01-16T12:00:00Z',
                closed_at: '2024-01-16T12:00:00Z',
            });
            const fetchMock = makeFetchMock([{body: [mergedPR]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].state).toBe('merged');
            expect(prs[0].mergedAt).toBe('2024-01-16T12:00:00Z');
        });

        it('keeps closed state when PR is closed without merge', async () => {
            const closedPR = makePRFixture({
                state: 'closed',
                merged_at: null,
                closed_at: '2024-01-16T12:00:00Z',
            });
            const fetchMock = makeFetchMock([{body: [closedPR]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].state).toBe('closed');
        });

        it('stops pagination when PR updated_at is before since (correct cutoff field)', async () => {
            // The list is sorted by updated_at desc, so the cutoff must use updated_at,
            // not created_at — a PR created before since but updated after since should
            // NOT trigger early termination.
            const recentlyUpdatedOldPR = makePRFixture({
                number: 1,
                created_at: '2023-06-01T00:00:00Z', // old creation date
                updated_at: '2024-02-01T00:00:00Z', // updated after since → keep
            });
            const trulyOldPR = makePRFixture({
                number: 2,
                created_at: '2023-01-01T00:00:00Z',
                updated_at: '2023-06-01T00:00:00Z', // updated before since → stop
            });
            const fetchMock = makeFetchMock([{body: [recentlyUpdatedOldPR, trulyOldPR]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            // Only the PR with updated_at >= since should be returned
            expect(prs).toHaveLength(1);
            expect(prs[0].id).toBe('1');
        });

        it('follows Link header pagination', async () => {
            const pr1 = makePRFixture({number: 1, created_at: '2024-01-20T00:00:00Z', updated_at: '2024-01-20T00:00:00Z'});
            const pr2 = makePRFixture({number: 2, created_at: '2024-01-18T00:00:00Z', updated_at: '2024-01-18T00:00:00Z'});
            const fetchMock = makeFetchMock([
                {
                    body: [pr1],
                    headers: {link: '<https://api.github.com/repos/test-org/my-repo/pulls?page=2>; rel="next"'},
                },
                {body: [pr2]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs).toHaveLength(2);
        });

        it('returns empty array for repo with no PRs', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('empty-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs).toEqual([]);
        });
    });

    // --- getReviewComments ---

    describe('getReviewComments()', () => {
        it('returns comments mapped to GitReviewComment shape', async () => {
            const fetchMock = makeFetchMock([{body: [makeReviewCommentFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments).toHaveLength(1);
            expect(comments[0]).toEqual({
                author: {name: '', email: '', username: 'bob'},
                body: 'LGTM!',
                createdAt: '2024-01-15T11:00:00Z',
                prId: '42',
            });
        });

        it('handles comments from users with no login', async () => {
            const fetchMock = makeFetchMock([
                {body: [makeReviewCommentFixture({user: null})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments[0].author.username).toBe('');
        });

        it('follows Link header pagination', async () => {
            const fetchMock = makeFetchMock([
                {
                    body: [makeReviewCommentFixture({body: 'first'})],
                    headers: {link: '<https://api.github.com/repos/test-org/my-repo/pulls/42/comments?page=2>; rel="next"'},
                },
                {body: [makeReviewCommentFixture({body: 'second'})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments).toHaveLength(2);
            expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
        });

        it('returns empty array when PR has no review comments', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments).toEqual([]);
        });
    });

    // --- getCommitDiff ---

    describe('getCommitDiff()', () => {
        it('returns file diffs mapped to GitFileDiff shape', async () => {
            const fetchMock = makeFetchMock([{body: makeCommitDetailFixture('abc123')}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('my-repo', 'abc123');

            expect(diffs).toHaveLength(2);
            expect(diffs[0]).toEqual({
                path: 'src/foo.ts',
                additions: 30,
                deletions: 5,
                status: 'modified',
            });
            expect(diffs[1]).toEqual({
                path: 'src/bar.ts',
                additions: 5,
                deletions: 2,
                status: 'added',
            });
        });

        it('returns empty array when commit has no file changes', async () => {
            const detail = {...makeCommitDetailFixture('abc123'), files: []};
            const fetchMock = makeFetchMock([{body: detail}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('my-repo', 'abc123');

            expect(diffs).toEqual([]);
        });

        it('maps all GitHub file statuses correctly', async () => {
            const detail = {
                ...makeCommitDetailFixture('abc123'),
                files: [
                    {filename: 'a.ts', additions: 10, deletions: 0, status: 'added'},
                    {filename: 'b.ts', additions: 5, deletions: 3, status: 'modified'},
                    {filename: 'c.ts', additions: 0, deletions: 8, status: 'removed'},
                    {filename: 'd.ts', additions: 2, deletions: 1, status: 'renamed'},
                ],
            };
            const fetchMock = makeFetchMock([{body: detail}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('my-repo', 'abc123');

            expect(diffs.map((d) => d.status)).toEqual(['added', 'modified', 'removed', 'renamed']);
        });
    });

    // --- Rate limiting ---

    describe('rate limit handling', () => {
        it('retries on 429 response and eventually succeeds', async () => {
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 429,
                        headers: new Headers({'retry-after': '0'}),
                        json: () => Promise.resolve([]),
                        text: () => Promise.resolve('rate limited'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            const repos = await listPromise;

            expect(repos).toEqual([]);
            expect(callCount).toBe(2);
        });

        it('throws after exhausting retries on persistent 429', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 429,
                headers: new Headers({'retry-after': '0'}),
                text: () => Promise.resolve('rate limited'),
            } as unknown as Response));

            const listPromise = provider.listRepos();
            // Attach a no-op catch immediately so the eventual rejection isn't
            // flagged as unhandled while we advance fake timers below.
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('Rate limit exceeded');
        });
    });

    // --- Transient server-error handling (#272) ---
    //
    // GitHub shared Bitbucket's ~6-second 5xx fuse exactly, so it shares the fix. Only the
    // 5xx/transport branch changed here — the 403 secondary-rate-limit branch and the
    // pre-emptive x-ratelimit-remaining pause are GitHub-only and untouched.

    describe('server error handling', () => {
        function serverError(status: number): Response {
            return {
                ok: false,
                status,
                headers: new Headers(),
                json: () => Promise.resolve({}),
                text: () => Promise.resolve('upstream failure'),
            } as unknown as Response;
        }

        it('survives a 503 blip that outlasts the old six-second budget', async () => {
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls <= 4) return Promise.resolve(serverError(503));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();

            await expect(listPromise).resolves.toEqual([]);
            expect(calls).toBe(5);
        });

        it('spends the shared 5xx budget and throws a typed error', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(500)));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('GitHub API server error 500');
            await expect(listPromise).rejects.toMatchObject({status: 500});
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
                1 + MAX_SERVER_ERROR_RETRIES,
            );
        });

        it('does NOT retry a 4xx, and reports it as non-retryable', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(404)));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('GitHub API error 404');
            expect(isRetryableGitFetchError(await listPromise.catch((e) => e))).toBe(false);
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
        });

        it('retries a transport fault on the same budget as a 5xx', async () => {
            // A socket reset is the same outage as a 503, one layer down, and it is the ONLY
            // path where `status` must be null for the in-run repo retry to fire.
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls <= 4) return Promise.reject(new Error('socket hang up'));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();

            await expect(listPromise).resolves.toEqual([]);
            expect(calls).toBe(5);
        });

        it('an exhausted transport fault keeps its message and reports no status', async () => {
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('ECONNRESET');
            await expect(listPromise).rejects.toMatchObject({status: null});
            await expect(listPromise).rejects.toSatisfy(isRetryableGitFetchError);
        });

        it('waits a real interval for an HTTP-date Retry-After on a 429, not zero', async () => {
            // The pre-#272 429 branch ran the header through parseFloat, so a date became NaN
            // and setTimeout(NaN) fired on the next tick — hammering GitHub three times in one
            // tick while already rate limited, which is how a primary limit becomes an abuse block.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 429,
                        headers: new Headers({'retry-after': 'Tue, 28 Jul 2026 10:01:00 GMT'}),
                        json: () => Promise.resolve([]),
                        text: () => Promise.resolve('rate limited'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
            expect(delays).toContain(60_000);
            expect(delays.some((d) => Number.isNaN(d))).toBe(false);
        });

        it('waits a real interval for an HTTP-date Retry-After on a secondary-limit 403', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 403,
                        headers: new Headers({'retry-after': 'Tue, 28 Jul 2026 10:00:45 GMT'}),
                        json: () => Promise.resolve({}),
                        text: () => Promise.resolve('secondary rate limit'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            expect(setTimeoutSpy.mock.calls.map((c) => Number(c[1]))).toContain(45_000);
        });

        it('waits out the PRIMARY rate limit on a 403 with remaining=0', async () => {
            // GitHub's main throttle. Distinct from the secondary-limit branch above: there is no
            // Retry-After, only x-ratelimit-remaining=0 plus an epoch reset.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            const resetEpoch = Math.floor(Date.parse('2026-07-28T10:00:30.000Z') / 1_000);
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 403,
                        headers: new Headers({
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(resetEpoch),
                        }),
                        json: () => Promise.resolve({}),
                        text: () => Promise.resolve('rate limit exceeded'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();

            await expect(listPromise).resolves.toEqual([]);
            // 30s to the reset, +1s so the retry lands just after it rather than exactly on it.
            expect(setTimeoutSpy.mock.calls.map((c) => Number(c[1]))).toContain(31_000);
            expect(calls).toBe(2);
        });

        it('backs off 60s — not 1s — when the primary-limit reset has ALREADY elapsed', async () => {
            // #284 review cycle 2 (SO-1/SEC-1/DUP-1). `parseEpochResetMs` floors an elapsed reset
            // at 0, and `0 + 1_000` clamps to MIN_RATE_LIMIT_DELAY_MS — so all three rate-limit
            // retries burned in ~3 seconds against an ACTIVE primary limit, which on GitHub
            // escalates to a token-wide abuse block. One second of host clock skew at the reset
            // boundary reaches it. `usableResetMs` now reports the elapsed reset as unusable and
            // the branch falls back to the 60s/120s/180s guess.
            //
            // The CLASSIFICATION must survive that: `remaining === '0'` with an elapsed reset is
            // still a primary limit, so it must still be RETRIED. If the guard were applied to
            // `resetMs` itself, this 403 would fall through to the secondary branch, find no
            // Retry-After, and throw with no retry at all — `calls` would be 1.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            const elapsed = Math.floor(Date.parse('2026-07-28T09:59:00.000Z') / 1_000);
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 403,
                        headers: new Headers({
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(elapsed),
                        }),
                        json: () => Promise.resolve({}),
                        text: () => Promise.resolve('rate limit exceeded'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();

            await expect(listPromise).resolves.toEqual([]);
            expect(calls).toBe(2);
            const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
            expect(delays).toContain(60_000);
            expect(delays).not.toContain(1_000);
        });

        it('tolerates a fractional x-ratelimit-reset rather than failing the 403 outright', async () => {
            // `parseInt` (pre-#272) read '….5' fine. If parseEpochResetMs rejected it, the
            // primary-limit guard `resetMs !== null` would fall through both 403 branches and
            // throw with NO retry — a regression on GitHub's main throttle.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const resetEpoch = Math.floor(Date.parse('2026-07-28T10:00:30.000Z') / 1_000);
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 403,
                        headers: new Headers({
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': `${resetEpoch}.5`,
                        }),
                        json: () => Promise.resolve({}),
                        text: () => Promise.resolve('rate limit exceeded'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();

            await expect(listPromise).resolves.toEqual([]);
            expect(calls).toBe(2);
        });

        it('throws a non-retryable 403 when it carries no rate-limit information at all', async () => {
            // A permissions 403: neither branch applies, so it fails immediately — and the repo
            // layer must not spend 20 minutes re-asking a question with a fixed answer.
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 403,
                headers: new Headers(),
                json: () => Promise.resolve({}),
                text: () => Promise.resolve('resource not accessible'),
            } as unknown as Response));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('GitHub API forbidden (403)');
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
            expect(isRetryableGitFetchError(await listPromise.catch((e) => e))).toBe(false);
        });

        it('caps the pre-emptive rate-limit pause when the reset header is absurd', async () => {
            // A garbage x-ratelimit-reset used to be trusted verbatim: `reset * 1000 - now`
            // could park the sync for years.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({
                    'x-ratelimit-remaining': '3',
                    'x-ratelimit-reset': '99999999999',
                }),
                json: () => Promise.resolve([]),
                text: () => Promise.resolve(''),
            } as unknown as Response));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
            // Positive control FIRST: `every` on an empty array is true, so without this the test
            // would stay green if the pre-emptive pause were deleted outright.
            expect(delays).toContain(3_600_000);
            expect(delays.every((d) => d <= 3_600_000)).toBe(true);
        });

        it('skips the pre-emptive rate-limit pause when the reset has ALREADY elapsed', async () => {
            // #284. `parseEpochResetMs` floors an elapsed reset at 0, so this branch used to
            // sleep `rateLimitDelayMs(null, 0 + 1_000)` — MIN_RATE_LIMIT_DELAY_MS, a full second,
            // AFTER a successful 200 and with nothing left to wait out. On the per-commit
            // detail/diffstat fan-out that is a 1-second tax on an O(commits) population, inside
            // the same run wall clock #283 exists to bound. `usableResetMs` reports it unusable
            // and the pause is skipped entirely.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            const elapsed = Math.floor(Date.parse('2026-07-28T09:59:00.000Z') / 1_000);
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({
                    'x-ratelimit-remaining': '3',
                    'x-ratelimit-reset': String(elapsed),
                }),
                json: () => Promise.resolve([]),
                text: () => Promise.resolve(''),
            } as unknown as Response));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            // Only the per-request timeout should have been armed — no pause at all. The sibling
            // case above is the positive control that this branch still fires on a USABLE reset,
            // so a green here cannot mean "the pre-emptive pause was deleted".
            const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
            expect(delays).not.toContain(1_000);
            expect(delays.every((d) => d === GIT_REQUEST_TIMEOUT_MS)).toBe(true);
        });

        it('waits out a 429 to the x-ratelimit-reset instant, not the blind 60s guess', async () => {
            // #284. GitHub signals the PRIMARY limit as 403 *or* 429, and on a 429 the reset is
            // the only header that says when the wall comes down — `Retry-After` is what it sends
            // for the SECONDARY limit. This branch used to read no reset at all and guess
            // 60s/120s/180s, i.e. four requests inside six minutes into a window that can be most
            // of an hour; a 429 is deliberately not repo-retryable, so that failed the repo and
            // #231 discarded the run.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            const resetEpoch = Math.floor(Date.parse('2026-07-28T10:50:00.000Z') / 1_000);
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 429,
                        headers: new Headers({
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(resetEpoch),
                        }),
                        json: () => Promise.resolve({}),
                        text: () => Promise.resolve('rate limited'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve([]),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await expect(listPromise).resolves.toEqual([]);

            const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
            // 50 minutes to the advertised reset — NOT `rateLimitFallbackMs(0)`, which is the
            // 60s guess this branch used to take while the wall stayed up for another 49.
            expect(delays).toContain(3_000_000);
            expect(delays).not.toContain(60_000);
            expect(calls).toBe(2);
        });

        it('skips the pre-emptive rate-limit pause for an interactive client (#283)', async () => {
            // The third hour-long sleep, and the one a retry-count override alone would have
            // missed: this fires after a 200, so it is neither a retry nor a failure. The
            // caller that has forbidden waiting OUT a rate limit has equally forbidden waiting
            // to AVOID one — inside the one HTTP request the repo picker is blocked on.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            const lowRemaining = {
                ok: true,
                status: 200,
                headers: new Headers({
                    'x-ratelimit-remaining': '3',
                    // 30 minutes out, so a pause would be unmistakable in the delay list.
                    'x-ratelimit-reset': String(
                        Math.floor(Date.parse('2026-07-28T10:30:00.000Z') / 1000),
                    ),
                }),
                json: () => Promise.resolve([]),
                text: () => Promise.resolve(''),
            } as unknown as Response;
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(lowRemaining));

            const interactive = new GitHubProvider(CONFIG, {policy: INTERACTIVE_REQUEST_POLICY});
            const listPromise = interactive.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
            expect(delays).not.toContain(1_800_000 + 1_000);
            // Only the per-request abort timer is scheduled — nothing minute-scale. Compared
            // against the constant, not a copy of it: a raised GIT_REQUEST_TIMEOUT_MS must not
            // break a test about the rate-limit pause.
            expect(delays.every((d) => d <= GIT_REQUEST_TIMEOUT_MS)).toBe(true);

            // POSITIVE CONTROL on the same response: a sync client DOES pause, so the
            // assertions above cannot pass merely because the fixture stopped triggering it.
            setTimeoutSpy.mockClear();
            vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
            const syncClient = new GitHubProvider(CONFIG);
            const syncList = syncClient.listRepos();
            await vi.runAllTimersAsync();
            await syncList;
            expect(setTimeoutSpy.mock.calls.map((c) => Number(c[1]))).toContain(1_800_000 + 1_000);
        });

        it('checkAccess fails fast on a 5xx instead of inheriting the sync budget', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(503)));

            // Built with the INTERACTIVE policy, which is what every path reaching checkAccess
            // now supplies (#283) — `doctor` and the admin test-connection route. The budget
            // moved from a per-call argument to the client, so it is the client, not the
            // method, that has to be interactive.
            const probe = new GitHubProvider(CONFIG, {policy: INTERACTIVE_REQUEST_POLICY});
            const pending = probe.checkAccess();
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toThrow('GitHub API server error 503');
            // One request, full stop: PROBE_SERVER_ERROR_RETRIES is 0 because even a single
            // retry is worth up to SERVER_ERROR_MAX_DELAY_MS once Retry-After acts as a floor,
            // and a human is waiting on this answer inside one HTTP request.
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
                1 + PROBE_SERVER_ERROR_RETRIES,
            );
            expect(PROBE_SERVER_ERROR_RETRIES).toBe(0);
        });
    });

    // --- Integration: listRepos → getCommits → getCommitDiff ---

    describe('integration: listRepos → getCommits → getCommitDiff', () => {
        it('full flow returns consistent data across all three methods', async () => {
            const sha = 'deadbeef';
            let callCount = 0;

            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                callCount++;
                let body: unknown = [];
                const headers = new Headers();

                if (url.includes('/repos?')) {
                    body = [makeRepoFixture()];
                } else if (url.includes('/commits?')) {
                    body = [makeCommitListFixture(sha)];
                } else if (url.includes(`/commits/${sha}`) && !url.includes('?')) {
                    body = makeCommitDetailFixture(sha);
                }

                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers,
                    json: () => Promise.resolve(body),
                    text: () => Promise.resolve(String(body)),
                } as unknown as Response);
            }));

            const repos = await provider.listRepos();
            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('my-repo');

            const commits = await provider.getCommits(
                repos[0].name,
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
            );
            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe(sha);

            const diffs = await provider.getCommitDiff(repos[0].name, commits[0].sha);
            expect(diffs).toHaveLength(2);
            expect(diffs[0].path).toBe('src/foo.ts');

            // Verify author data flows consistently
            expect(commits[0].author.username).toBe('alice');
            expect(commits[0].diffs).toEqual(diffs);
        });
    });
});
