import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {GitHubProvider} from '../../../../src/connectors/git/providers/github';
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

function makeCommitDetailFixture(sha: string): Record<string, unknown> {
    return {
        sha,
        commit: {
            author: {name: 'Alice', email: 'alice@example.com', date: '2024-01-15T10:00:00Z'},
            message: 'feat: add feature',
        },
        author: {login: 'alice'},
        stats: {additions: 40, deletions: 10, total: 50},
        files: [
            {filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
            {filename: 'src/bar.ts', additions: 10, deletions: 5, status: 'added'},
        ],
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
                filesChanged: ['src/foo.ts', 'src/bar.ts'],
            });
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
                {phase: 'listing', discovered: 1},
                {phase: 'listing', discovered: 2},
                {phase: 'fetching', done: 0, total: 2},
                {phase: 'fetching', done: 1, total: 2},
                {phase: 'fetching', done: 2, total: 2},
            ]);
        });

        it('still reaches total when a commit is skipped or its detail fetch fails', async () => {
            // aaa111 maps normally, bbb222's detail carries no author date (skipped by
            // a `continue`), ccc333's detail 500s until retries are exhausted. Only one
            // GitCommit comes back, but the counter must still reach 3/3 — a counter
            // that stops short of its total is exactly the "hung" symptom of #270.
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
            await vi.runAllTimersAsync();
            const commits = await pending;

            expect(commits.map((c) => c.sha)).toEqual(['aaa111']);
            expect(onProgress).toHaveBeenLastCalledWith({phase: 'fetching', done: 3, total: 3});
        });

        it('reports nothing at all on an empty repo (no phantom 0/0 counter)', async () => {
            vi.stubGlobal('fetch', makeFetchMock([{body: []}]));

            const onProgress = vi.fn();
            await provider.getCommits('empty-repo', '', '', onProgress);

            // The single list page still reports its (zero) discovered count; the
            // fan-out phase is skipped entirely so no consumer renders "commit 0/0".
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {phase: 'listing', discovered: 0},
            ]);
        });

        it('skips commits where author date is missing', async () => {
            const sha = 'abc123';
            const detailWithNoDate = {
                sha,
                commit: {author: null, message: 'msg'},
                author: {login: 'alice'},
                stats: {additions: 0, deletions: 0, total: 0},
                files: [],
            };
            const fetchMock = makeFetchMock([
                {body: [makeCommitListFixture(sha)]},
                {body: detailWithNoDate},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            expect(commits).toEqual([]);
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

        it('skips individual failing commits when some succeed', async () => {
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
                // Second detail fails — but first succeeded, so no throw
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    headers: new Headers(),
                    text: () => Promise.resolve('not found'),
                } as unknown as Response);
            }));

            const commits = await provider.getCommits('my-repo', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');

            // sha1 succeeded, sha2 was silently skipped
            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe(sha1);
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

        it('extracts username from author login even when commit author differs', async () => {
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
                {body: [makeCommitListFixture(sha)]},
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
                {phase: 'listing', discovered: 1},
                {phase: 'listing', discovered: 1},
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
                additions: 10,
                deletions: 5,
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
            expect(commits[0].filesChanged).toEqual(diffs.map((d) => d.path));
        });
    });
});
