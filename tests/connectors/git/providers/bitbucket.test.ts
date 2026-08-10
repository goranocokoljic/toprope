import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {BitbucketProvider} from '../../../../src/connectors/git/providers/bitbucket';
import {
    GitProviderFetchError,
    INTERACTIVE_REQUEST_POLICY,
    MAX_SERVER_ERROR_RETRIES,
    PROBE_SERVER_ERROR_RETRIES,
    isRetryableGitFetchError,
} from '../../../../src/connectors/git/providers/http-retry';
import {
    FUTURE_AUTHOR_DATE_DROP_REASON,
    UNATTRIBUTABLE_DATE_DROP_REASON,
    type BitbucketProviderConfig,
} from '../../../../src/connectors/git/providers/types';

const CONFIG_APP_PASSWORD: BitbucketProviderConfig = {
    type: 'bitbucket',
    workspace: 'test-workspace',
    auth: {type: 'app_password', username: 'test-user', app_password: 'test-pass'},
};

const CONFIG_ACCESS_TOKEN: BitbucketProviderConfig = {
    type: 'bitbucket',
    workspace: 'test-workspace',
    auth: {type: 'access_token', token: 'test-token'},
};

const CONFIG_OAUTH: BitbucketProviderConfig = {
    type: 'bitbucket',
    workspace: 'test-workspace',
    auth: {type: 'oauth', token: 'oauth-token'},
};

// --- Fixture helpers ---

function makeRepoFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        uuid: '{repo-uuid-1}',
        slug: 'my-repo',
        name: 'My Repo',
        full_name: 'test-workspace/my-repo',
        mainbranch: {name: 'main'},
        scm: 'git',
        ...overrides,
    };
}

function makeCommitFixture(hash: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        hash,
        author: {
            raw: 'Goran <goran@wmg.rs>',
            user: {nickname: 'goranocokoljic', account_id: 'acc-123'},
        },
        date: '2024-01-15T10:00:00+00:00',
        message: 'feat: add feature',
        ...overrides,
    };
}

function makeDiffstatFixture(): Record<string, unknown>[] {
    return [
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
    ];
}

function makePRFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 42,
        title: 'feat: add feature',
        author: {nickname: 'alice', account_id: 'acc-alice', display_name: 'Alice'},
        state: 'OPEN',
        created_on: '2024-01-15T09:00:00+00:00',
        // Distinct from created_on so the mapping assertion pins updatedAt to
        // `updated_on`, not `created_on` (#247 review TST-1).
        updated_on: '2024-01-16T09:00:00+00:00',
        reviewers: [{nickname: 'bob', account_id: 'acc-bob', display_name: 'Bob'}],
        ...overrides,
    };
}

function makeCommentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        content: {raw: 'Looks good!'},
        author: {nickname: 'bob', account_id: 'acc-bob', display_name: 'Bob'},
        created_on: '2024-01-15T11:00:00+00:00',
        inline: {from: 10, to: 12, path: 'src/foo.ts'},
        ...overrides,
    };
}

function pagedResponse(values: unknown[], next?: string): Record<string, unknown> {
    const r: Record<string, unknown> = {values};
    if (next) r.next = next;
    return r;
}

// --- Mock fetch helper ---

function makeFetchMock(responses: Array<{body: unknown; headers?: Record<string, string>; status?: number}>) {
    let callIndex = 0;
    return vi.fn().mockImplementation(() => {
        const resp = responses[callIndex++] ?? {body: pagedResponse([]), headers: {}};
        const status = resp.status ?? 200;
        const ok = status >= 200 && status < 300;
        const headers = new Headers(resp.headers ?? {});
        return Promise.resolve({
            ok,
            status,
            headers,
            json: () => Promise.resolve(resp.body),
            text: () => Promise.resolve(JSON.stringify(resp.body)),
        } as unknown as Response);
    });
}

describe('BitbucketProvider', () => {
    let provider: BitbucketProvider;

    beforeEach(() => {
        provider = new BitbucketProvider(CONFIG_APP_PASSWORD);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        // `stubGlobal` survives `restoreAllMocks`, so a future test that forgets to stub fails
        // loudly instead of inheriting the previous test's `fetchMock` (#292 review TST-3).
        vi.unstubAllGlobals();
    });

    // --- Auth header construction ---

    describe('auth header construction', () => {
        it('uses Basic auth for app_password', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.listRepos();

            const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
            const headers = options?.headers as Record<string, string>;
            const expected = `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`;
            expect(headers['Authorization']).toBe(expected);
        });

        it('uses Bearer auth for access_token', async () => {
            const p = new BitbucketProvider(CONFIG_ACCESS_TOKEN);
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
            const headers = options?.headers as Record<string, string>;
            expect(headers['Authorization']).toBe('Bearer test-token');
        });

        it('uses Bearer auth for oauth', async () => {
            const p = new BitbucketProvider(CONFIG_OAUTH);
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
            const headers = options?.headers as Record<string, string>;
            expect(headers['Authorization']).toBe('Bearer oauth-token');
        });
    });

    // --- listRepos ---

    describe('listRepos()', () => {
        it('normalizes a padded/mis-cased workspace into the request path (#266)', async () => {
            // The workspace is both the attribution key and the request path. `providerContainer`
            // normalizes the former; the constructor normalizes the latter from the same shared
            // helper, so a YAML `workspace: ' ACME-WS '` cannot attribute rows to `acme-ws` while
            // fetching `/repositories/%20ACME-WS%20`.
            const fetchMock = makeFetchMock([{body: pagedResponse([makeRepoFixture()])}]);
            vi.stubGlobal('fetch', fetchMock);
            const p = new BitbucketProvider({...CONFIG_APP_PASSWORD, workspace: ' ACME-WS '});

            await p.listRepos();

            expect(String(fetchMock.mock.calls[0][0])).toContain('/repositories/acme-ws');
        });

        it('returns repos mapped to GitRepo shape', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([makeRepoFixture()])}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0]).toEqual({
                id: '{repo-uuid-1}',
                name: 'my-repo',
                fullName: 'test-workspace/my-repo',
                displayName: 'My Repo',
                defaultBranch: 'main',
                isArchived: false,
            });
        });

        it('leaves displayName unset when the API response has no name field (projection falls back to the slug)', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([makeRepoFixture({name: undefined})])}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('my-repo');
            expect(repos[0].displayName).toBeUndefined();
        });

        it('uses role=member in the request URL', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('role=member');
        });

        it('excludes non-git repos', async () => {
            const fetchMock = makeFetchMock([{
                body: pagedResponse([
                    makeRepoFixture({scm: 'git', slug: 'git-repo'}),
                    makeRepoFixture({uuid: '{hg}', slug: 'hg-repo', scm: 'hg'}),
                ]),
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('git-repo');
        });

        it('follows next URL pagination', async () => {
            const fetchMock = makeFetchMock([
                {body: pagedResponse(
                    [makeRepoFixture({uuid: '{a}', slug: 'repo-a'})],
                    'https://api.bitbucket.org/2.0/repositories/test-workspace?page=2',
                )},
                {body: pagedResponse([makeRepoFixture({uuid: '{b}', slug: 'repo-b'})])},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(2);
            expect(repos.map((r) => r.name)).toEqual(['repo-a', 'repo-b']);
        });

        it('returns empty array for empty workspace', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toEqual([]);
        });

        it('applies include list filter', async () => {
            const p = new BitbucketProvider({...CONFIG_APP_PASSWORD, repos: ['keep-me']});
            const fetchMock = makeFetchMock([{
                body: pagedResponse([
                    makeRepoFixture({slug: 'keep-me', uuid: '{1}'}),
                    makeRepoFixture({slug: 'skip-me', uuid: '{2}'}),
                ]),
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos.map((r) => r.name)).toEqual(['keep-me']);
        });

        it('applies exclude glob pattern filter', async () => {
            const p = new BitbucketProvider({...CONFIG_APP_PASSWORD, exclude_repos: ['archived-*']});
            const fetchMock = makeFetchMock([{
                body: pagedResponse([
                    makeRepoFixture({slug: 'keep-me', uuid: '{1}'}),
                    makeRepoFixture({slug: 'archived-old', uuid: '{2}'}),
                ]),
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos.map((r) => r.name)).toEqual(['keep-me']);
        });

        it('uses default branch main when mainbranch is missing', async () => {
            const fetchMock = makeFetchMock([{
                body: pagedResponse([makeRepoFixture({mainbranch: undefined})]),
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos[0].defaultBranch).toBe('main');
        });
    });

    // --- Author parsing ---

    describe('parseRawAuthor (via getCommits)', () => {
        it('splits "Name <email>" format correctly', async () => {
            const hash = 'abc123';
            const fetchMock = makeFetchMock([
                {body: pagedResponse([makeCommitFixture(hash)])},
                {body: pagedResponse(makeDiffstatFixture())},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits[0].author.name).toBe('Goran');
            expect(commits[0].author.email).toBe('goran@wmg.rs');
        });

        it('extracts username from author.user.nickname', async () => {
            const hash = 'abc123';
            const fetchMock = makeFetchMock([
                {body: pagedResponse([makeCommitFixture(hash)])},
                {body: pagedResponse(makeDiffstatFixture())},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits[0].author.username).toBe('goranocokoljic');
        });

        it('falls back to account_id when nickname is absent', async () => {
            const hash = 'abc123';
            const commitWithNoNickname = makeCommitFixture(hash, {
                author: {raw: 'Bot <bot@ci.com>', user: {account_id: 'acc-bot'}},
            });
            const fetchMock = makeFetchMock([
                {body: pagedResponse([commitWithNoNickname])},
                {body: pagedResponse([])},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits[0].author.username).toBe('acc-bot');
        });

        it('handles raw author string without email angle brackets', async () => {
            const hash = 'abc123';
            const commitNoEmail = makeCommitFixture(hash, {
                author: {raw: 'just-a-name', user: {nickname: 'justname'}},
            });
            const fetchMock = makeFetchMock([
                {body: pagedResponse([commitNoEmail])},
                {body: pagedResponse([])},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits[0].author.name).toBe('just-a-name');
            expect(commits[0].author.email).toBe('');
        });
    });

    // --- getCommits ---

    describe('getCommits()', () => {
        it('returns commits mapped to GitCommit shape with diffstat totals', async () => {
            const hash = 'abc123';
            const fetchMock = makeFetchMock([
                {body: pagedResponse([makeCommitFixture(hash)])},
                {body: pagedResponse(makeDiffstatFixture())},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toHaveLength(1);
            expect(commits[0]).toEqual({
                sha: hash,
                author: {name: 'Goran', email: 'goran@wmg.rs', username: 'goranocokoljic'},
                date: '2024-01-15T10:00:00+00:00',
                message: 'feat: add feature',
                additions: 40,
                deletions: 5,
                // The diffstat this call already fetched, carried out so the sync loop
                // does not request it a second time (#271).
                diffs: [
                    {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                    {path: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
                ],
            });
        });

        // --- diff reuse (#271) ---

        it('exposes diffs byte-identical to what getCommitDiff would return for the same sha', async () => {
            // The whole point of the reuse: the value handed to the caller must be the
            // same value the fallback path would have produced, or churn changes.
            // `getCommits` builds it by CALLING `this.getCommitDiff`, so today there is one
            // implementation and this can only fail if someone forks it — a regression
            // guard against exactly that, not an independent check.
            const hash = 'abc123';
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: pagedResponse([makeCommitFixture(hash)])},
                    {body: pagedResponse(makeDiffstatFixture())},
                ]),
            );
            const commits = await provider.getCommits('my-repo', '', '');

            // Fresh provider + fresh mock so the second call is genuinely independent.
            vi.stubGlobal('fetch', makeFetchMock([{body: pagedResponse(makeDiffstatFixture())}]));
            const viaFallback = await provider.getCommitDiff('my-repo', hash);

            expect(commits[0].diffs).toEqual(viaFallback);
        });

        it('sets diffs to [] — not undefined — when the diffstat 404s, so the caller does not re-request', async () => {
            // undefined would send the sync loop back to the endpoint that just 404'd,
            // restoring exactly the duplicate request #271 removes for merge commits.
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: pagedResponse([makeCommitFixture('merge1')])},
                    {body: {type: 'error'}, status: 404},
                ]),
            );

            const commits = await provider.getCommits('my-repo', '', '');

            expect(commits).toHaveLength(1);
            // `toEqual([])` is the whole assertion: it fails on undefined too, which is
            // precisely the distinction the sync loop branches on.
            expect(commits[0].diffs).toEqual([]);
        });

        // --- onProgress (#270) ---

        it('reports one listing tick per commit page, then one per diffstat fetch', async () => {
            const fetchMock = makeFetchMock([
                {body: pagedResponse([makeCommitFixture('aaa')], 'https://api.bitbucket.org/2.0/next')},
                {body: pagedResponse([makeCommitFixture('bbb')])},
                {body: pagedResponse(makeDiffstatFixture())}, // diffstat for aaa
                {body: pagedResponse(makeDiffstatFixture())}, // diffstat for bbb
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            await provider.getCommits('my-repo', '', '', onProgress);

            // Listing has no total (unknown until the last page) and carries the scanned
            // count beside the retained one (#276) — here they are equal, because a
            // forward run filters nothing; the per-commit diffstat fan-out — where nearly
            // all of a big repo's wall time goes — then reports real done/total and no
            // scanned count at all (past listing, every row in the set was kept).
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null, scanned: 1},
                {done: 2, total: null, scanned: 2},
                {done: 0, total: 2},
                {done: 1, total: 2},
                {done: 2, total: 2},
            ]);
        });

        it('reports an empty repo as a real zero total, not a suppressed step', async () => {
            vi.stubGlobal('fetch', makeFetchMock([{body: pagedResponse([])}]));

            const onProgress = vi.fn();
            await provider.getCommits('empty-repo', '', '', onProgress);

            // `total: 0` is reported truthfully here as on the other two providers;
            // suppressing the meaningless "commit 0/0" is the consumer's job.
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 0, total: null, scanned: 0},
                {done: 0, total: 0},
            ]);
        });

        it('advances the scanned count on every page of a walk that retains nothing', async () => {
            // The #276 contract, replacing the pin that recorded the old stationary
            // behavior. Bitbucket's commit endpoint takes no date bounds, so an `until` in
            // the past is filtered in memory: each page before the window retains nothing,
            // `done` cannot move, and `scanned` is the only honest signal that the walk is
            // progressing rather than hung. Both properties are asserted — every page
            // still reports (that was the old pin), and consecutive reports now DIFFER.
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse(
                        [makeCommitFixture('newer1', {date: '2024-06-01T00:00:00+00:00'})],
                        'https://api.bitbucket.org/2.0/next',
                    ),
                },
                {
                    body: pagedResponse(
                        [
                            makeCommitFixture('newer2', {date: '2024-05-01T00:00:00+00:00'}),
                            makeCommitFixture('newer3', {date: '2024-04-01T00:00:00+00:00'}),
                        ],
                        'https://api.bitbucket.org/2.0/next2',
                    ),
                },
                {
                    body: pagedResponse([
                        makeCommitFixture('newer4', {date: '2024-03-01T00:00:00+00:00'}),
                    ]),
                },
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const commits = await provider.getCommits(
                'my-repo',
                '2024-01-01T00:00:00Z',
                '2024-02-01T00:00:00Z',
                onProgress,
            );

            expect(commits).toEqual([]);
            const listingTicks = onProgress.mock.calls
                .map((c) => c[0] as {done: number; total: number | null; scanned?: number})
                .filter((p) => p.total === null);
            // Rows scanned accumulate across pages (1, then +2, then +1) while nothing is
            // retained — the exact shape a backfill's approach walk produces. Three
            // pairwise-distinct literals, so this also states AC1 (no two consecutive
            // reports are identical) without needing a separate distinctness assertion,
            // which could not fail once these exact values are pinned.
            expect(listingTicks).toEqual([
                {done: 0, total: null, scanned: 1},
                {done: 0, total: null, scanned: 3},
                {done: 0, total: null, scanned: 4},
            ]);
        });

        it('counts a whole straddling page as scanned while keeping only the rows inside the window', async () => {
            // The page every backfill crosses exactly once: the boundary page, where the
            // walk is half past `until` and half inside it. It is the ONLY state in which
            // both counters are non-zero AND different (`scanned > done > 0`), which is
            // what pins `done` to `collected.length` rather than to the walk's position in
            // the page. It also carries the row sitting exactly ON `until`, which this walk
            // KEEPS (`commitDate <= untilDate`). Read that as a record of current behavior,
            // not as a claim that keeping it is correct: the LOWER bound is inclusive too
            // (the break is `commitDate < sinceDate`, so a row at `since` survives it), and
            // a capped run advances the cursor to exactly its `until` — so adjacent windows
            // share that instant and a commit stamped there is returned by BOTH of them.
            // That used to be a one-instant DOUBLE-COUNT rather than a gap, because the
            // cross-run merge ADDED commit metrics on a stated premise of disjoint windows.
            // IG1.2 (#318) removed that premise: the commit is inserted by sha with ON
            // CONFLICT DO NOTHING and the cell is recomputed from all of its stored commits,
            // so a shared instant now costs one redundant insert attempt and nothing else.
            // The overlap is pinned here as behaviour, not as an exposure. Left alone here
            // because the bounds are pre-existing and shared in spirit with the other two
            // providers' server-side filters — the point of pinning it is that whoever
            // changes them has to change this assertion deliberately rather than drift
            // into it, in either direction.
            const fetchMock = makeFetchMock([
                {
                    // Entirely ahead of the window: 2 scanned, 0 kept.
                    body: pagedResponse(
                        [
                            makeCommitFixture('ahead1', {date: '2024-06-01T00:00:00+00:00'}),
                            makeCommitFixture('ahead2', {date: '2024-05-01T00:00:00+00:00'}),
                        ],
                        'https://api.bitbucket.org/2.0/next',
                    ),
                },
                {
                    // Straddles `until`: 4 scanned, the last 3 fall inside the window —
                    // `boundary` sits exactly ON `until` and is therefore kept.
                    body: pagedResponse([
                        makeCommitFixture('ahead3', {date: '2024-03-01T00:00:00+00:00'}),
                        makeCommitFixture('boundary', {date: '2024-02-01T00:00:00+00:00'}),
                        makeCommitFixture('inside1', {date: '2024-01-20T00:00:00+00:00'}),
                        makeCommitFixture('inside2', {date: '2024-01-10T00:00:00+00:00'}),
                    ]),
                },
                {body: pagedResponse(makeDiffstatFixture())}, // diffstat for boundary
                {body: pagedResponse(makeDiffstatFixture())}, // diffstat for inside1
                {body: pagedResponse(makeDiffstatFixture())}, // diffstat for inside2
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const commits = await provider.getCommits(
                'my-repo',
                '2024-01-01T00:00:00Z',
                '2024-02-01T00:00:00Z',
                onProgress,
            );

            // The boundary row is KEPT — the `<=` in the filter, pinned.
            expect(commits.map((c) => c.sha)).toEqual(['boundary', 'inside1', 'inside2']);
            const ticks = onProgress.mock.calls.map(
                (c) => c[0] as {done: number; total: number | null; scanned?: number},
            );
            const listingTicks = ticks.filter((p) => p.total === null);
            // Page 1 keeps nothing; page 2 keeps 3 of its 4 rows, so the retained count
            // moves for the first time while the scanned count stays 3 ahead of it. The
            // exact pairs also carry the invariant a row cannot be kept without having
            // been handed over, so no separate `scanned >= done` loop is needed.
            expect(listingTicks).toEqual([
                {done: 0, total: null, scanned: 2},
                {done: 3, total: null, scanned: 6},
            ]);
        });

        it('gates the cutoff page tail before breaking, and still does not report that page', async () => {
            // The cutoff page's listing tick is still skipped, deliberately: the fan-out seed
            // below it runs in the same synchronous block and would overwrite the tick before
            // any poller could read it, so restructuring the walk to reach it would be churn
            // for nothing (#270 review OR-1). What #304 changed is what the page's ROWS do.
            //
            // THE THREE ROWS AFTER THE CUTOFF ARE THE POINT, one per outcome the tail can have:
            //   - `undatable` is now REPORTED. It used to be the one member of its class the
            //     walk lost in silence — counted into `scanned`, never gated, never in
            //     `collected`, never on `onDrop` — which is what bounded the #292 claim that an
            //     emitted divergence is window-filtered rows plus reported drops. The gate runs
            //     above the cutoff guard for the same reason it `continue`s rather than breaks:
            //     "it sits after the cutoff row" is a statement about the endpoint's ORDER, and
            //     a row whose own date is unreadable cannot be placed in that order at all.
            //   - `straggler` is datable and INSIDE the window, and must still not be collected.
            //     Draining the tail must not turn the retained set into a function of where the
            //     page boundary happened to fall; delete the `reachedCutoff` guard in the walk
            //     and this row appears in the result, which no other test catches.
            //   - `ahead` is datable and FUTURE-dated, and must not be reported either: past the
            //     cutoff the endpoint's order is what the stop rests on, so calling it a lost
            //     commit would report an ordering violation as data loss.
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse(
                        [
                            makeCommitFixture('aaa', {date: '2024-01-20T00:00:00+00:00'}),
                            makeCommitFixture('bbb', {date: '2023-12-01T00:00:00+00:00'}),
                            makeCommitFixture('undatable', {date: 'not-a-date'}),
                            makeCommitFixture('straggler', {date: '2024-01-05T00:00:00+00:00'}),
                            makeCommitFixture('ahead', {date: '2099-01-01T00:00:00+00:00'}),
                        ],
                        'https://api.bitbucket.org/2.0/next',
                    ),
                },
                {body: pagedResponse([])}, // diffstat for aaa
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const onProgress = vi.fn();
            const commits = await provider.getCommits(
                'my-repo',
                '2024-01-01T00:00:00Z',
                '2024-12-31T23:59:59Z',
                onProgress,
                onDrop,
            );

            expect(commits.map((c) => c.sha)).toEqual(['aaa']);
            // Exactly one report, and it is the row nothing else could account for. Asserted as
            // the whole call list rather than a `toHaveBeenCalledWith`, so a walk that also
            // reported `ahead` (or re-reported `bbb`) fails here.
            expect(onDrop.mock.calls.map((c) => c[0])).toEqual([
                {sha: 'undatable', reason: UNATTRIBUTABLE_DATE_DROP_REASON},
            ]);
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 0, total: 1},
                {done: 1, total: 1},
            ]);
        });

        // --- commit-date pin (#290) ---

        // ONE body, two fixtures: the gate does not branch on which flavor of undatable it got
        // (`isAttributableDate` is a single conjunction, and `commitDropReason` classifies both
        // through the same present-but-unusable arm), so a second copy of this body would assert
        // the same three values against the same code path.
        //   - The expanded year is a VALID `Date` that `Date.parse` accepts, so it is the only
        //     one of the two that catches a regression to a bare parse check — and it is what
        //     `git commit --date=@999999999999` really produces.
        //   - `'not-a-date'` catches no weakening the expanded year misses; it is here because
        //     it is the input class #292 names and the one `commit-date-contract.test.ts`
        //     deliberately excludes — the literal Invalid Date, whose comparisons are `false`
        //     against BOTH bounds, which is what used to make it fall out of a bounded walk
        //     retained by nothing and reported by nothing.
        it.each([
            ['an ISO expanded year', '+033658-09-27T01:46:39.000Z'],
            ['an unparseable string', 'not-a-date'],
        ])(
            'keeps walking past %s, reports it, and still counts it as scanned',
            async (_label, badDate) => {
                // THE REGRESSION THIS EXISTS FOR. The gate has to `continue`, never `break
                // paging`: the cutoff below it relies on the endpoint's newest-first ORDER, and a
                // row this walk cannot date says nothing about where in that order it sits.
                // Breaking on it would silently discard the rest of a window the run then records
                // as fully covered — which is exactly the #231 hole `onDrop` exists to make
                // impossible. The bad row is therefore placed BETWEEN two in-window commits, so a
                // `break` loses `after`.
                const fetchMock = makeFetchMock([
                    {
                        body: pagedResponse([
                            makeCommitFixture('before', {date: '2024-01-20T00:00:00+00:00'}),
                            makeCommitFixture('bad', {date: badDate}),
                            makeCommitFixture('after', {date: '2024-01-10T00:00:00+00:00'}),
                        ]),
                    },
                    {body: pagedResponse(makeDiffstatFixture())}, // diffstat for before
                    {body: pagedResponse(makeDiffstatFixture())}, // diffstat for after
                ]);
                vi.stubGlobal('fetch', fetchMock);

                const onDrop = vi.fn();
                const onProgress = vi.fn();
                const commits = await provider.getCommits(
                    'my-repo',
                    '2024-01-01T00:00:00Z',
                    '2024-02-01T00:00:00Z',
                    onProgress,
                    onDrop,
                );

                expect(commits.map((c) => c.sha)).toEqual(['before', 'after']);
                // Present but unusable, so it must classify as unattributable — not the
                // truncated-response reason, whose remedy sends the operator somewhere else.
                expect(onDrop.mock.calls.map((c) => c[0])).toEqual([
                    {sha: 'bad', reason: UNATTRIBUTABLE_DATE_DROP_REASON},
                ]);
                // The dropped row was HANDED over, so it still counts toward `scanned` — the
                // emitted divergence from `done` is window-filtered rows plus reported drops.
                // Every other row here is inside the window, so on this walk the drop is the ONLY
                // thing separating the two counts. Note what this can and cannot catch: `scanned`
                // is incremented per PAGE above the gate, so no change confined to the drop path
                // moves it. What it pins is that a future move to per-row counting (which
                // `bitbucket.ts` anticipates) would still have to count the dropped row.
                const listingTicks = onProgress.mock.calls
                    .map((c) => c[0] as {done: number; total: number | null; scanned?: number})
                    .filter((p) => p.total === null);
                expect(listingTicks).toEqual([{done: 2, total: null, scanned: 3}]);
            },
        );

        // --- future-dated exclusions (#304) ---

        // The clock this walk compares against. Fixed rather than inherited from the suite's
        // `useFakeTimers()` base (which is the real wall clock) so `until` can be written as a
        // literal equal to `now` — the forward-run shape the whole class only appears in.
        const NOW = '2026-07-28T10:00:00.000Z';

        // TWO fixtures, and the SMALL one is the load-bearing case. The check is a bare
        // `commitDate > nowMs` with no tolerance, and `FUTURE_AUTHOR_DATE_DROP_REASON` argues at
        // length that a horizon constant would be underivable and would silence exactly the
        // broken-operator-clock case. A 2099 row clears any horizon anyone might later add, so on
        // its own it would let `> nowMs + FIVE_MINUTES` ship green; the two-minute row is the only
        // input the threshold-free form and a tolerance form disagree on. It is also the realistic
        // producer (an NTP-drifting laptop or CI runner), and the only fixture whose day key is
        // TODAY — i.e. the one that shows this is an instant comparison, not a day comparison.
        it.each([
            ['a date decades ahead', '2099-01-01T00:00:00+00:00'],
            ['a two-minute clock skew', '2026-07-28T10:02:00+00:00'],
        ])(
            'reports %s that the forward window excludes, and keeps walking',
            async (_label, futureDate) => {
                // THE #304 CASE. On a forward run `until` IS `now`, so a commit dated ahead of the
                // clock fails `commitDate <= untilDate` and never reaches `collected` — and before
                // #304 nothing said so. It is not the ordinary "still approaching the window"
                // exclusion the filter exists for: Bitbucket re-pages from HEAD every run and the
                // row is newer than `since`, so it never trips the cutoff, and no run in flight
                // has an `until` past `now`. The result was a permanent `+1` divergence between
                // `scanned` and `done` that an operator reads as benign.
                //
                // The future row sits BETWEEN two in-window commits, so a walk that broke on it
                // (or stopped gating after it) loses `after`.
                vi.setSystemTime(new Date(NOW));
                const fetchMock = makeFetchMock([
                    {
                        body: pagedResponse([
                            makeCommitFixture('before', {date: '2026-07-20T00:00:00+00:00'}),
                            makeCommitFixture('skewed', {date: futureDate}),
                            makeCommitFixture('after', {date: '2026-07-10T00:00:00+00:00'}),
                        ]),
                    },
                    {body: pagedResponse(makeDiffstatFixture())}, // diffstat for before
                    {body: pagedResponse(makeDiffstatFixture())}, // diffstat for after
                ]);
                vi.stubGlobal('fetch', fetchMock);

                const onDrop = vi.fn();
                const onProgress = vi.fn();
                const commits = await provider.getCommits(
                    'my-repo',
                    '2026-07-01T00:00:00Z',
                    NOW,
                    onProgress,
                    onDrop,
                );

                expect(commits.map((c) => c.sha)).toEqual(['before', 'after']);
                // Its OWN reason, not the unattributable one: the date is a perfectly good day and
                // the operator's next step is the commit's timestamp (clock skew, `--date=`,
                // imported history), not a truncated response.
                expect(onDrop.mock.calls.map((c) => c[0])).toEqual([
                    {sha: 'skewed', reason: FUTURE_AUTHOR_DATE_DROP_REASON},
                ]);
                // The row was HANDED over, so it still counts toward `scanned` — and now the
                // divergence it creates is accounted for by a channel rather than being silent.
                const listingTicks = onProgress.mock.calls
                    .map((c) => c[0] as {done: number; total: number | null; scanned?: number})
                    .filter((p) => p.total === null);
                expect(listingTicks).toEqual([{done: 2, total: null, scanned: 3}]);
            },
        );

        it('on a backfill chunk reports only the row ahead of the CLOCK, not the ones ahead of until', async () => {
            // BOTH SIDES OF THE `&&`, in the one shape that can show them: a backfill or catch-up
            // chunk whose `until` is a past watermark. All three rows are handled differently.
            //   - `newer` is after `until` but before `now` — the ordinary approach exclusion,
            //     covered by the next forward run. A backfill filters HUNDREDS of pages of these,
            //     so reporting them would bury the real losses; this is the row that distinguishes
            //     `> untilDate && > now` from a bare `> untilDate`, and the exact-list assertion
            //     below is what fails if it is reported.
            //   - `ahead-of-clock` is after both, and IS reported even though this is not a
            //     forward run. Deliberate rather than incidental: the walk has no way to know
            //     which shape the sync called it for, and scoping the report to forward runs would
            //     need a flag the interface does not carry. The cost is that the forward run
            //     reports the same sha too — the repeat `GitProvider.getCommits` documents for
            //     every Bitbucket drop, not a second loss.
            //   - `inside` is the only row kept.
            vi.setSystemTime(new Date(NOW));
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse([
                        makeCommitFixture('ahead-of-clock', {date: '2099-01-01T00:00:00+00:00'}),
                        makeCommitFixture('newer', {date: '2026-06-01T00:00:00+00:00'}),
                        makeCommitFixture('inside', {date: '2026-01-15T00:00:00+00:00'}),
                    ]),
                },
                {body: pagedResponse(makeDiffstatFixture())}, // diffstat for inside
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const commits = await provider.getCommits(
                'my-repo',
                '2026-01-01T00:00:00Z',
                '2026-02-01T00:00:00Z',
                undefined,
                onDrop,
            );

            expect(commits.map((c) => c.sha)).toEqual(['inside']);
            expect(onDrop.mock.calls.map((c) => c[0])).toEqual([
                {sha: 'ahead-of-clock', reason: FUTURE_AUTHOR_DATE_DROP_REASON},
            ]);
        });

        it('does NOT report a commit stamped exactly now that until just misses', async () => {
            // `>` and not `>=`, pinned. A row at exactly the current instant is the boundary the
            // next run's `until` includes — the sync derives `until` from the run's start, so a
            // window opened one tick later reaches it. Reporting it would call a one-tick race a
            // permanent loss.
            vi.setSystemTime(new Date(NOW));
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse([
                        makeCommitFixture('on-the-instant', {date: NOW}),
                        makeCommitFixture('inside', {date: '2026-07-20T00:00:00+00:00'}),
                    ]),
                },
                {body: pagedResponse(makeDiffstatFixture())}, // diffstat for inside
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const commits = await provider.getCommits(
                'my-repo',
                '2026-07-01T00:00:00Z',
                '2026-07-28T09:59:59.999Z',
                undefined,
                onDrop,
            );

            expect(commits.map((c) => c.sha)).toEqual(['inside']);
            expect(onDrop).not.toHaveBeenCalled();
        });

        // --- window bounds (#304) ---

        // BOTH refusal classes, per bound. The unparseable one is the obvious half; the EXPANDED
        // YEAR is the half a `Number.isNaN` check alone would miss, and it is the worse failure:
        // `+010000-…` parses to a finite instant in the future, so as a `since` it makes the very
        // first row trip the cutoff, `collected` come back empty, the run report success, and the
        // cursor advance over an entirely unwalked window. It is also the value #233 was actually
        // about, and what `git commit --date=@999999999999` produces.
        it.each([
            ['until', 'unparseable', 'not-a-date', ['2024-01-01T00:00:00Z', 'not-a-date']],
            ['since', 'unparseable', 'not-a-date', ['not-a-date', '2024-12-31T00:00:00Z']],
            [
                'until',
                'an expanded year',
                '+010000-01-01T00:00:00.000Z',
                ['2024-01-01T00:00:00Z', '+010000-01-01T00:00:00.000Z'],
            ],
            [
                'since',
                'an expanded year',
                '+010000-01-01T00:00:00.000Z',
                ['+010000-01-01T00:00:00.000Z', '2024-12-31T00:00:00Z'],
            ],
        ] as const)(
            'refuses to walk when %s is %s, instead of filtering with a bound that excludes everything',
            async (label, _kind, offendingValue, [since, until]) => {
                // Fail closed: the caller records the failure and HOLDS the cursor (#231), so the
                // window is re-fetched once the bound is fixed — rather than being recorded as
                // covered while nothing was walked.
                const fetchMock = makeFetchMock([
                    {body: pagedResponse([makeCommitFixture('aaa')])},
                ]);
                vi.stubGlobal('fetch', fetchMock);

                const walk = provider.getCommits('my-repo', since, until);
                await expect(walk).rejects.toThrow(new RegExp(`"${label}"`));
                // THE REFUSAL CLASS, not just the bound name — without it, half this table is
                // green for the wrong reason. An expanded-year `since` paired with an ordinary
                // `until` is ALSO an inverted window (year 10000 > 2024), and that guard's message
                // names "since" and git_last_sync too — so with the shape pin deleted this row
                // still passed. Pinning the sentence the shape check owns is what makes each row
                // fail for the check it is named after.
                await expect(walk).rejects.toThrow(/four-digit-year/);
                // The message names the bound and the state keys that hold it, and NEVER the
                // OFFENDING value: it reaches an operator terminal and `sync_logs.errors` through
                // the caller's `Failed to fetch commits:` line, and the bounds are read from
                // stored, unvalidated `sync_state` rows. `(got: <value>)` is the obvious "make it
                // debuggable" edit, and this is what stops it landing unnoticed. Asserted against
                // the bad operand only — the valid partner bound could not appear either way, so
                // asserting on it would be an assertion that cannot fail.
                await expect(walk).rejects.toThrow(/git_last_sync/);
                const message = await walk.then(
                    () => '',
                    (err: unknown) => (err instanceof Error ? err.message : String(err)),
                );
                expect(message).not.toContain(offendingValue);
                // Refused BEFORE the first request, so a malformed bound costs no network work
                // and cannot half-walk a repo.
                expect(fetchMock).not.toHaveBeenCalled();
            },
        );

        it('refuses an INVERTED window, where each bound is valid but the pair is impossible', async () => {
            // The reachable half of the same defect (#304 review cycle 2). `catchUpUntil` clamps
            // `until` to `now` while `since` is whatever the cursor says — so a host clock that
            // jumped forward once, or a hand-edited `git_last_sync`, hands this walk a window no
            // commit can satisfy. Unrefused, the first row trips the cutoff, the break skips the
            // listing tick, and an empty list returns as a SUCCESS: the run then records the span
            // as covered and advances the cursor over it. Nothing else in the diff catches this —
            // both bounds pass `parseCommitBound` individually.
            const fetchMock = makeFetchMock([{body: pagedResponse([makeCommitFixture('aaa')])}]);
            vi.stubGlobal('fetch', fetchMock);

            await expect(
                provider.getCommits('my-repo', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'),
            ).rejects.toThrow(/inverted/);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('allows a window whose bounds are equal — an empty span is not an inverted one', async () => {
            // `>` and not `>=` on the pair: a chunk whose `since` and `until` coincide asks for a
            // zero-length span, which is a legitimate no-op the cursor logic can produce, not a
            // corrupt cursor. Refusing it would fail a run that is behaving correctly.
            const instant = '2026-01-01T00:00:00.000Z';
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            await expect(provider.getCommits('my-repo', instant, instant)).resolves.toEqual([]);
            // It WALKED — `[]` here is an empty repo, not a refusal that happened to return the
            // same value. Without this the test would pass against a short-circuit.
            expect(fetchMock).toHaveBeenCalled();
        });

        it('drops an unattributable date BEFORE the diffstat fan-out, so it costs no request', async () => {
            // The assertion that catches a gate moved AFTER the fan-out is the request COUNT
            // below, not `additions`: `good` is first in the page, so it would consume the single
            // diffstat response either way and still report 40. Do not drop the count assertion
            // believing the churn one covers it.
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse([
                        makeCommitFixture('good'),
                        makeCommitFixture('bad', {date: 'not-a-date'}),
                    ]),
                },
                {body: pagedResponse(makeDiffstatFixture())}, // the ONLY diffstat response
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const commits = await provider.getCommits('my-repo', '', '', undefined, onDrop);

            expect(commits.map((c) => c.sha)).toEqual(['good']);
            expect(commits[0].additions).toBe(40);
            expect(onDrop).toHaveBeenCalledTimes(1);
            // One commit-list request + one diffstat request. A third call would mean the bad
            // commit reached the fan-out.
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('reports the PR-list page that hits the since cutoff', async () => {
            // Unlike the commit walk, getPullRequests reports BEFORE deciding whether to
            // stop, and there is a real `await` on the next iteration for a non-final
            // page — so this tick is observable and must not be moved into a break.
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse(
                        [
                            makePRFixture({id: 1, updated_on: '2024-02-01T00:00:00+00:00'}),
                            makePRFixture({id: 2, updated_on: '2023-01-01T00:00:00+00:00'}),
                        ],
                        'https://api.bitbucket.org/2.0/next',
                    ),
                },
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const prs = await provider.getPullRequests(
                'my-repo',
                'all',
                '2024-01-01T00:00:00Z',
                onProgress,
            );

            expect(prs.map((p) => p.id)).toEqual(['1']);
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([{done: 1, total: null}]);
        });

        it('stops pagination when commit date is before since', async () => {
            const recent = makeCommitFixture('aaa', {date: '2024-01-20T00:00:00+00:00'});
            const old = makeCommitFixture('bbb', {date: '2023-12-01T00:00:00+00:00'});
            const fetchMock = makeFetchMock([
                {body: pagedResponse([recent, old])},
                {body: pagedResponse([])}, // diffstat for recent
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-12-31T23:59:59Z');

            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe('aaa');
        });

        it('excludes commits newer than until', async () => {
            const tooNew = makeCommitFixture('aaa', {date: '2024-02-10T00:00:00+00:00'});
            const inRange = makeCommitFixture('bbb', {date: '2024-01-15T00:00:00+00:00'});
            const fetchMock = makeFetchMock([
                {body: pagedResponse([tooNew, inRange])},
                {body: pagedResponse([])}, // diffstat for inRange
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe('bbb');
        });

        it('follows next URL pagination for commit list', async () => {
            const hash1 = 'aaa111';
            const hash2 = 'bbb222';
            const fetchMock = makeFetchMock([
                {body: pagedResponse(
                    [makeCommitFixture(hash1, {date: '2024-01-20T00:00:00+00:00'})],
                    'https://api.bitbucket.org/2.0/repositories/ws/my-repo/commits?page=2',
                )},
                {body: pagedResponse([makeCommitFixture(hash2, {date: '2024-01-15T00:00:00+00:00'})])},
                {body: pagedResponse([])}, // diffstat hash1
                {body: pagedResponse([])}, // diffstat hash2
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toHaveLength(2);
            expect(commits[0].sha).toBe(hash1);
            expect(commits[1].sha).toBe(hash2);
        });

        it('returns empty array for empty repo', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toEqual([]);
        });

        it('still returns commit when diffstat returns 404 (merge commit); records zero stats', async () => {
            const hash = 'abc123';
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve(pagedResponse([makeCommitFixture(hash)])),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    headers: new Headers(),
                    json: () => Promise.resolve({}),
                    text: () => Promise.resolve('not found'),
                } as unknown as Response);
            }));

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe(hash);
            expect(commits[0].additions).toBe(0);
            expect(commits[0].deletions).toBe(0);
            expect(commits[0].diffs).toEqual([]);
        });

        it('returns both commits when one diffstat succeeds and another returns 404', async () => {
            const hashA = 'aaa111';
            const hashB = 'bbb222'; // merge commit — no diffstat
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    // commit list: two commits in range
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve(pagedResponse([
                            makeCommitFixture(hashA, {date: '2024-01-20T00:00:00+00:00'}),
                            makeCommitFixture(hashB, {date: '2024-01-18T00:00:00+00:00'}),
                        ])),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                if (callCount === 2) {
                    // diffstat for hashA — succeeds
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve(pagedResponse(makeDiffstatFixture())),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                // diffstat for hashB — 404 (merge commit)
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    headers: new Headers(),
                    json: () => Promise.resolve({}),
                    text: () => Promise.resolve('not found'),
                } as unknown as Response);
            }));

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toHaveLength(2);
            expect(commits[0].sha).toBe(hashA);
            expect(commits[0].additions).toBe(40);
            // Full entries, not just paths: the succeeding half of a mixed walk must carry
            // per-file churn, which a path-only check cannot tell apart from a stripped diff.
            expect(commits[0].diffs).toEqual([
                {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                {path: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
            ]);
            expect(commits[1].sha).toBe(hashB);
            expect(commits[1].additions).toBe(0);
            expect(commits[1].diffs).toEqual([]);
        });

        it('propagates non-404 diffstat errors (e.g. 401 auth failure)', async () => {
            const hash = 'abc123';
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve(pagedResponse([makeCommitFixture(hash)])),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                // diffstat returns 401 — auth failure, should propagate
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    headers: new Headers(),
                    json: () => Promise.resolve({}),
                    text: () => Promise.resolve('unauthorized'),
                } as unknown as Response);
            }));

            await expect(
                provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z'),
            ).rejects.toThrow('Bitbucket API error 401');
        });
    });

    // --- getPullRequests ---

    describe('getPullRequests()', () => {
        it('reports one listing tick per PR page (#270)', async () => {
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse(
                        [makePRFixture({id: 1})],
                        'https://api.bitbucket.org/2.0/next',
                    ),
                },
                {body: pagedResponse([makePRFixture({id: 2})])},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const prs = await provider.getPullRequests('my-repo', 'all', '', onProgress);

            expect(prs).toHaveLength(2);
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null},
                {done: 2, total: null},
            ]);
        });

        it('returns PRs mapped to GitPR shape', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([makePRFixture()])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs).toHaveLength(1);
            expect(prs[0]).toEqual({
                id: '42',
                title: 'feat: add feature',
                author: {name: 'Alice', email: '', username: 'alice'},
                state: 'open',
                createdAt: '2024-01-15T09:00:00+00:00',
                mergedAt: null,
                closedAt: null,
                updatedAt: '2024-01-16T09:00:00+00:00',
                reviewers: [{name: 'Bob', email: '', username: 'bob'}],
                additions: 0,
                deletions: 0,
            });
        });

        it('normalizes MERGED state → merged and sets mergedAt', async () => {
            const pr = makePRFixture({
                state: 'MERGED',
                updated_on: '2024-01-16T12:00:00+00:00',
            });
            const fetchMock = makeFetchMock([{body: pagedResponse([pr])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].state).toBe('merged');
            expect(prs[0].mergedAt).toBe('2024-01-16T12:00:00+00:00');
            expect(prs[0].closedAt).toBeNull();
        });

        it('normalizes DECLINED state → closed and sets closedAt', async () => {
            const pr = makePRFixture({
                state: 'DECLINED',
                updated_on: '2024-01-16T12:00:00+00:00',
            });
            const fetchMock = makeFetchMock([{body: pagedResponse([pr])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].state).toBe('closed');
            expect(prs[0].closedAt).toBe('2024-01-16T12:00:00+00:00');
            expect(prs[0].mergedAt).toBeNull();
        });

        it('normalizes SUPERSEDED state → closed', async () => {
            const pr = makePRFixture({state: 'SUPERSEDED'});
            const fetchMock = makeFetchMock([{body: pagedResponse([pr])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].state).toBe('closed');
        });

        it('stops pagination when updated_on is before since', async () => {
            const recent = makePRFixture({id: 1, updated_on: '2024-02-01T00:00:00+00:00'});
            const old = makePRFixture({id: 2, updated_on: '2023-06-01T00:00:00+00:00'});
            const fetchMock = makeFetchMock([{body: pagedResponse([recent, old])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs).toHaveLength(1);
            expect(prs[0].id).toBe('1');
        });

        it('follows next URL pagination', async () => {
            const pr1 = makePRFixture({id: 1, updated_on: '2024-01-20T00:00:00+00:00'});
            const pr2 = makePRFixture({id: 2, updated_on: '2024-01-18T00:00:00+00:00'});
            const fetchMock = makeFetchMock([
                {body: pagedResponse(
                    [pr1],
                    'https://api.bitbucket.org/2.0/repositories/ws/my-repo/pullrequests?page=2',
                )},
                {body: pagedResponse([pr2])},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs).toHaveLength(2);
        });

        it('returns empty array for repo with no PRs', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs).toEqual([]);
        });

        it('requests sort=-updated_on to ensure consistent cutoff across all states', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('sort=-updated_on');
        });

        it('handles PR with null author', async () => {
            const pr = makePRFixture({author: null});
            const fetchMock = makeFetchMock([{body: pagedResponse([pr])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].author).toEqual({name: '', email: '', username: ''});
        });

        it('handles PR with no reviewers field', async () => {
            const pr = makePRFixture({reviewers: undefined});
            const fetchMock = makeFetchMock([{body: pagedResponse([pr])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].reviewers).toEqual([]);
        });

        it('maps participant account_id as username fallback', async () => {
            const pr = makePRFixture({
                author: {account_id: 'acc-only', display_name: 'Display'},
                reviewers: [{account_id: 'rev-acc', display_name: 'Reviewer'}],
            });
            const fetchMock = makeFetchMock([{body: pagedResponse([pr])}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('my-repo', 'all', '2024-01-01T00:00:00Z');

            expect(prs[0].author.username).toBe('acc-only');
            expect(prs[0].reviewers[0].username).toBe('rev-acc');
        });
    });

    // --- getReviewComments ---

    describe('getReviewComments()', () => {
        it('returns only inline comments', async () => {
            const inline = makeCommentFixture();
            const general = makeCommentFixture({inline: null, content: {raw: 'General comment'}});
            const fetchMock = makeFetchMock([{body: pagedResponse([inline, general])}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments).toHaveLength(1);
            expect(comments[0].body).toBe('Looks good!');
        });

        it('returns comments mapped to GitReviewComment shape', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([makeCommentFixture()])}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments[0]).toEqual({
                author: {name: 'Bob', email: '', username: 'bob'},
                body: 'Looks good!',
                createdAt: '2024-01-15T11:00:00+00:00',
                prId: '42',
            });
        });

        it('handles comments from null author', async () => {
            const fetchMock = makeFetchMock([{
                body: pagedResponse([makeCommentFixture({author: null})]),
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments[0].author).toEqual({name: '', email: '', username: ''});
        });

        it('follows next URL pagination', async () => {
            const fetchMock = makeFetchMock([
                {body: pagedResponse(
                    [makeCommentFixture({content: {raw: 'first'}})],
                    'https://api.bitbucket.org/2.0/repositories/ws/my-repo/pullrequests/42/comments?page=2',
                )},
                {body: pagedResponse([makeCommentFixture({content: {raw: 'second'}})])},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments).toHaveLength(2);
            expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
        });

        it('returns empty array when PR has no inline comments', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments).toEqual([]);
        });

        it('returns empty array when all comments are general (no inline field)', async () => {
            const fetchMock = makeFetchMock([{
                body: pagedResponse([
                    makeCommentFixture({inline: null}),
                    makeCommentFixture({inline: undefined}),
                ]),
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('my-repo', '42');

            expect(comments).toEqual([]);
        });
    });

    // --- getCommitDiff ---

    describe('getCommitDiff()', () => {
        it('returns file diffs mapped to GitFileDiff shape', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse(makeDiffstatFixture())}]);
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
                additions: 10,
                deletions: 0,
                status: 'added',
            });
        });

        it('uses old path for removed files when new is null', async () => {
            const removedEntry = {
                status: 'removed',
                lines_added: 0,
                lines_removed: 8,
                new: null,
                old: {path: 'src/gone.ts'},
            };
            const fetchMock = makeFetchMock([{body: pagedResponse([removedEntry])}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('my-repo', 'abc123');

            expect(diffs[0].path).toBe('src/gone.ts');
            expect(diffs[0].status).toBe('removed');
        });

        it('maps all Bitbucket diffstat statuses', async () => {
            const entries = [
                {status: 'added', lines_added: 10, lines_removed: 0, new: {path: 'a.ts'}, old: null},
                {status: 'modified', lines_added: 5, lines_removed: 3, new: {path: 'b.ts'}, old: {path: 'b.ts'}},
                {status: 'removed', lines_added: 0, lines_removed: 8, new: null, old: {path: 'c.ts'}},
                {status: 'renamed', lines_added: 2, lines_removed: 1, new: {path: 'd-new.ts'}, old: {path: 'd-old.ts'}},
            ];
            const fetchMock = makeFetchMock([{body: pagedResponse(entries)}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('my-repo', 'abc123');

            expect(diffs.map((d) => d.status)).toEqual(['added', 'modified', 'removed', 'renamed']);
        });

        it('follows next URL pagination for diffstat', async () => {
            const fetchMock = makeFetchMock([
                {body: pagedResponse(
                    [{status: 'modified', lines_added: 5, lines_removed: 2, new: {path: 'a.ts'}, old: {path: 'a.ts'}}],
                    'https://api.bitbucket.org/2.0/repositories/ws/my-repo/diffstat/abc?page=2',
                )},
                {body: pagedResponse([
                    {status: 'added', lines_added: 3, lines_removed: 0, new: {path: 'b.ts'}, old: null},
                ])},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('my-repo', 'abc123');

            expect(diffs).toHaveLength(2);
        });

        it('returns empty array when commit has no file changes', async () => {
            const fetchMock = makeFetchMock([{body: pagedResponse([])}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('my-repo', 'abc123');

            expect(diffs).toEqual([]);
        });
    });

    // --- Rate limit handling ---

    describe('rate limit handling', () => {
        it('retries on 429 and succeeds on retry', async () => {
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 429,
                        headers: new Headers({'retry-after': '0'}),
                        json: () => Promise.resolve(pagedResponse([])),
                        text: () => Promise.resolve('rate limited'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve(pagedResponse([])),
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
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('Rate limit exceeded');
        });

        it('an exhausted 429 throws a typed, retryable error', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 429,
                headers: new Headers({'retry-after': '0'}),
                text: () => Promise.resolve('rate limited'),
            } as unknown as Response));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toBeInstanceOf(GitProviderFetchError);
            await expect(listPromise).rejects.toMatchObject({status: 429});
        });

        it('waits a real interval for an HTTP-date Retry-After on a 429, not zero', async () => {
            // The pre-#272 429 branch ran the header through parseFloat, so a date became NaN
            // and setTimeout(NaN) fired on the next tick: three "retries" burned in one tick
            // WHILE rate limited, which is how a primary limit escalates into an abuse block.
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
                        headers: new Headers({
                            'retry-after': 'Tue, 28 Jul 2026 10:01:00 GMT',
                        }),
                        json: () => Promise.resolve(pagedResponse([])),
                        text: () => Promise.resolve('rate limited'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve(pagedResponse([])),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
            expect(delays).toContain(60_000);
            expect(delays.some((d) => Number.isNaN(d))).toBe(false);
        });

        it('never retries a 429 instantly, even on Retry-After: 0', async () => {
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 429,
                        headers: new Headers({'retry-after': '0'}),
                        json: () => Promise.resolve(pagedResponse([])),
                        text: () => Promise.resolve('rate limited'),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve(pagedResponse([])),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            expect(setTimeoutSpy.mock.calls.every((c) => Number(c[1]) > 0)).toBe(true);
        });
    });

    // --- Transient server-error handling (#272) ---
    //
    // The 2026-07-28 incident: ONE transient 503 on a per-commit diffstat killed a
    // multi-hour initial sync, twice. The same request replayed hours later returned 200 in
    // 734ms — the retry budget (three linear pauses, ~6s total) was simply shorter than the
    // outage.

    describe('server error handling', () => {
        function serverError(status: number, headers: Headers = new Headers()): Response {
            return {
                ok: false,
                status,
                headers,
                json: () => Promise.resolve({}),
                text: () => Promise.resolve('upstream failure'),
            } as unknown as Response;
        }

        function okPage(): Response {
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: () => Promise.resolve(pagedResponse([])),
                text: () => Promise.resolve(''),
            } as unknown as Response;
        }

        it('survives a 503 blip that outlasts the old six-second budget', async () => {
            // Four consecutive 503s: under the pre-#272 three-retry budget this threw.
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                return Promise.resolve(calls <= 4 ? serverError(503) : okPage());
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();

            await expect(listPromise).resolves.toEqual([]);
            expect(calls).toBe(5);
        });

        it('sizes the 5xx budget separately from the 429 budget', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(503)));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('Bitbucket API server error 503');
            // Initial attempt + MAX_SERVER_ERROR_RETRIES, NOT the 429 path's 3.
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
                1 + MAX_SERVER_ERROR_RETRIES,
            );
        });

        it('counts the two budgets independently when a run hits both statuses', async () => {
            // Sizing is not independence: only a MIXED sequence can show that rate limiting
            // early in a request does not eat the 5xx allowance it needs later.
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls <= 2) {
                    return Promise.resolve({
                        ok: false,
                        status: 429,
                        headers: new Headers({'retry-after': '1'}),
                        json: () => Promise.resolve(pagedResponse([])),
                        text: () => Promise.resolve('rate limited'),
                    } as unknown as Response);
                }
                return Promise.resolve(serverError(503));
            }));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('Bitbucket API server error 503');
            // 2 rate-limited attempts, then a FULL 1 + MAX_SERVER_ERROR_RETRIES worth of 5xx —
            // a shared counter would have cut the 5xx budget short by the two 429s.
            expect(calls).toBe(2 + 1 + MAX_SERVER_ERROR_RETRIES);
        });

        it('checkAccess fails fast on a 5xx instead of inheriting the sync budget', async () => {
            // A probe answers `toprope doctor` and the admin test-connection route, where a
            // human (and an HTTP request) is waiting. Spending the full budget there would turn
            // a mistyped host into a ~2.5-minute hang.
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(503)));

            // The interactive budget lives on the CLIENT since #283, not on the call.
            const probe = new BitbucketProvider(CONFIG_APP_PASSWORD, {
                policy: INTERACTIVE_REQUEST_POLICY,
            });
            const pending = probe.checkAccess();
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toThrow('Bitbucket API server error 503');
            // One request, full stop: PROBE_SERVER_ERROR_RETRIES is 0 because even a single
            // retry is worth up to SERVER_ERROR_MAX_DELAY_MS once Retry-After acts as a floor,
            // and a human is waiting on this answer inside one HTTP request.
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
                1 + PROBE_SERVER_ERROR_RETRIES,
            );
            expect(PROBE_SERVER_ERROR_RETRIES).toBe(0);
        });

        it('an exhausted 5xx throws a typed error carrying the status', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(502)));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toBeInstanceOf(GitProviderFetchError);
            await expect(listPromise).rejects.toMatchObject({status: 502});
        });

        it('honors Retry-After on a 5xx the way the 429 path already did', async () => {
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                return Promise.resolve(
                    calls === 1 ? serverError(503, new Headers({'retry-after': '90'})) : okPage(),
                );
            }));

            const listPromise = provider.listRepos();
            await vi.runAllTimersAsync();
            await listPromise;

            // 90s exactly — not the ~5s the exponential schedule would have chosen, and not
            // jittered downward below what the server asked for.
            const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
            expect(delays).toContain(90_000);
        });

        it('retries a transport fault on the same budget as a 5xx', async () => {
            // The 503 and the reset socket are the same outage seen at two layers; handling
            // them differently would leave half the incident un-hardened.
            let calls = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                calls++;
                if (calls <= 4) return Promise.reject(new Error('socket hang up'));
                return Promise.resolve(okPage());
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
        });

        it('does NOT retry a 4xx — a deterministic answer is not an outage', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(401)));

            const listPromise = provider.listRepos();
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('Bitbucket API error 401');
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
        });

        it('propagates an exhausted 5xx OUT of getCommits as a retryable typed error', async () => {
            // THE incident path, end to end: getCommits → per-commit diffstat → 503. The whole
            // in-run repo retry hangs on this, because isRetryableGitFetchError fails CLOSED —
            // if this ever surfaced as a plain Error (say someone wrapped it with repo context)
            // the retry would silently never fire and #272 would be fully regressed, with every
            // mock-provider test still green.
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/diffstat/')) return Promise.resolve(serverError(503));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve(pagedResponse([makeCommitFixture('abc123')])),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const pending = provider.getCommits('my-repo', '', '');
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toBeInstanceOf(GitProviderFetchError);
            await expect(pending).rejects.toMatchObject({status: 503});
            await expect(pending).rejects.toSatisfy(isRetryableGitFetchError);
        });

        it('still records zero stats for a commit whose diffstat 404s', async () => {
            // The 404 tolerance is now keyed on the typed status rather than a ' 404:'
            // substring of the message — this pins that it still tolerates.
            const hash = 'abc123';
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/diffstat/')) return Promise.resolve(serverError(404));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve(pagedResponse([makeCommitFixture(hash)])),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }));

            const pending = provider.getCommits('my-repo', '', '');
            await vi.runAllTimersAsync();
            const commits = await pending;

            expect(commits).toHaveLength(1);
            expect(commits[0].additions).toBe(0);
            expect(commits[0].diffs).toEqual([]);
        });
    });

    // --- Integration: listRepos → getCommits → getCommitDiff ---

    describe('integration: listRepos → getCommits → getCommitDiff', () => {
        it('full flow returns consistent data across all three methods', async () => {
            const hash = 'deadbeef';

            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                let body: unknown;

                if (url.includes('/repositories/') && url.includes('role=member')) {
                    body = pagedResponse([makeRepoFixture()]);
                } else if (url.includes('/commits')) {
                    body = pagedResponse([makeCommitFixture(hash)]);
                } else if (url.includes('/diffstat/')) {
                    body = pagedResponse(makeDiffstatFixture());
                } else {
                    body = pagedResponse([]);
                }

                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: () => Promise.resolve(body),
                    text: () => Promise.resolve(JSON.stringify(body)),
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
            expect(commits[0].sha).toBe(hash);
            expect(commits[0].author).toEqual({
                name: 'Goran',
                email: 'goran@wmg.rs',
                username: 'goranocokoljic',
            });

            const diffs = await provider.getCommitDiff(repos[0].name, commits[0].sha);
            expect(diffs).toHaveLength(2);
            expect(diffs[0].path).toBe('src/foo.ts');

            expect(commits[0].diffs).toEqual(diffs);
            expect(commits[0].additions).toBe(40);
            expect(commits[0].deletions).toBe(5);
        });
    });
});
