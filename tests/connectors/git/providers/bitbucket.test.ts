import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {BitbucketProvider} from '../../../../src/connectors/git/providers/bitbucket';
import type {BitbucketProviderConfig} from '../../../../src/connectors/git/providers/types';

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
                filesChanged: ['src/foo.ts', 'src/bar.ts'],
            });
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

            // Listing has no total (unknown until the last page); the per-commit
            // diffstat fan-out — where nearly all of a big repo's wall time goes —
            // then reports real done/total.
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null},
                {done: 2, total: null},
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
                {done: 0, total: null},
                {done: 0, total: 0},
            ]);
        });

        it('reports every page of a walk that retains nothing, though the count cannot move', async () => {
            // Bitbucket's commit endpoint takes no date bounds, so an `until` in the
            // past is filtered in memory: each page before the window retains nothing
            // and reports an unchanging 0. Pinned deliberately — this is the known
            // stationary-counter case on the backfill/catch-up path (#276), and the
            // assertion fails if a future change stops reporting these pages at all.
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse(
                        [makeCommitFixture('newer1', {date: '2024-06-01T00:00:00+00:00'})],
                        'https://api.bitbucket.org/2.0/next',
                    ),
                },
                {
                    body: pagedResponse([
                        makeCommitFixture('newer2', {date: '2024-05-01T00:00:00+00:00'}),
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
            // One report per page — present, but stationary at 0 because nothing
            // inside the window has been reached yet.
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 0, total: null},
                {done: 0, total: null},
                {done: 0, total: 0},
            ]);
        });

        it('still reports the page that hits the since cutoff (#270)', async () => {
            // The cutoff used to break straight out of both loops; the page's
            // retained count must be reported before the walk stops — and when that
            // page retains nothing it is the ONLY signal, since the fan-out seed then
            // carries a zero total the consumer renders as no counter.
            const fetchMock = makeFetchMock([
                {
                    body: pagedResponse(
                        [
                            makeCommitFixture('aaa', {date: '2024-01-20T00:00:00+00:00'}),
                            makeCommitFixture('bbb', {date: '2023-12-01T00:00:00+00:00'}),
                        ],
                        'https://api.bitbucket.org/2.0/next',
                    ),
                },
                {body: pagedResponse([])}, // diffstat for aaa
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const commits = await provider.getCommits(
                'my-repo',
                '2024-01-01T00:00:00Z',
                '2024-12-31T23:59:59Z',
                onProgress,
            );

            // Cutoff behavior is unchanged (only 'aaa' survives), and the truncated
            // page still reported the one commit it collected.
            expect(commits.map((c) => c.sha)).toEqual(['aaa']);
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null},
                {done: 0, total: 1},
                {done: 1, total: 1},
            ]);
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
            expect(commits[0].filesChanged).toEqual([]);
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
            expect(commits[0].filesChanged).toEqual(['src/foo.ts', 'src/bar.ts']);
            expect(commits[1].sha).toBe(hashB);
            expect(commits[1].additions).toBe(0);
            expect(commits[1].filesChanged).toEqual([]);
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

            expect(commits[0].filesChanged).toEqual(diffs.map((d) => d.path));
            expect(commits[0].additions).toBe(40);
            expect(commits[0].deletions).toBe(5);
        });
    });
});
