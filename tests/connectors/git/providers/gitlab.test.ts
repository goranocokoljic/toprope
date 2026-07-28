import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {GitLabProvider} from '../../../../src/connectors/git/providers/gitlab';
import type {GitLabProviderConfig} from '../../../../src/connectors/git/providers/types';

const CONFIG_PAT: GitLabProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    auth: {type: 'personal_access_token', token: 'glpat-test'},
};

const CONFIG_OAUTH: GitLabProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    auth: {type: 'oauth', token: 'oauth-token'},
};

const CONFIG_JOB_TOKEN: GitLabProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    auth: {type: 'job_token', token: 'job-token'},
};

const CONFIG_SELF_MANAGED: GitLabProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    url: 'https://gitlab.example.com',
    auth: {type: 'personal_access_token', token: 'glpat-test'},
};

// --- Fixture helpers ---

function makeProjectFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 1001,
        name: 'My Repo',
        path: 'my-repo',
        path_with_namespace: 'test-group/my-repo',
        default_branch: 'main',
        archived: false,
        ...overrides,
    };
}

function makeCommitFixture(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        author_name: 'Goran',
        author_email: 'goran@wmg.rs',
        authored_date: '2024-01-15T10:00:00.000Z',
        message: 'feat: add feature',
        ...overrides,
    };
}

function makeDiffEntryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        old_path: 'src/foo.ts',
        new_path: 'src/foo.ts',
        new_file: false,
        renamed_file: false,
        deleted_file: false,
        diff: '@@ -1,3 +1,5 @@\n line1\n+line2\n+line3\n-old\n line4\n',
        ...overrides,
    };
}

function makeMRFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        iid: 42,
        title: 'feat: add feature',
        author: {username: 'alice', name: 'Alice', email: 'alice@example.com'},
        state: 'opened',
        created_at: '2024-01-15T09:00:00.000Z',
        // Distinct from created_at so the mapping assertion pins updatedAt to
        // `updated_at`, not `created_at`/`merged_at` (#247 review TST-1).
        updated_at: '2024-01-16T09:00:00.000Z',
        merged_at: null,
        closed_at: null,
        reviewers: [{username: 'bob', name: 'Bob', email: 'bob@example.com'}],
        ...overrides,
    };
}

function makeNoteFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        author: {username: 'bob', name: 'Bob', email: 'bob@example.com'},
        body: 'Looks good!',
        created_at: '2024-01-15T11:00:00.000Z',
        type: 'DiffNote',
        system: false,
        ...overrides,
    };
}

// --- Mock fetch helper ---

function makeFetchMock(
    responses: Array<{body: unknown; headers?: Record<string, string>; status?: number}>,
) {
    let callIndex = 0;
    return vi.fn().mockImplementation(() => {
        const resp = responses[callIndex++] ?? {body: [], headers: {}};
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

describe('GitLabProvider', () => {
    let provider: GitLabProvider;

    beforeEach(() => {
        provider = new GitLabProvider(CONFIG_PAT);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    // --- Auth header construction ---

    describe('auth header construction', () => {
        it('uses PRIVATE-TOKEN header for personal_access_token', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.listRepos();

            const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
            const headers = options?.headers as Record<string, string>;
            expect(headers['PRIVATE-TOKEN']).toBe('glpat-test');
            expect(headers['Authorization']).toBeUndefined();
        });

        it('uses Authorization: Bearer for oauth', async () => {
            const p = new GitLabProvider(CONFIG_OAUTH);
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
            const headers = options?.headers as Record<string, string>;
            expect(headers['Authorization']).toBe('Bearer oauth-token');
            expect(headers['PRIVATE-TOKEN']).toBeUndefined();
        });

        it('uses JOB-TOKEN header for job_token', async () => {
            const p = new GitLabProvider(CONFIG_JOB_TOKEN);
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
            const headers = options?.headers as Record<string, string>;
            expect(headers['JOB-TOKEN']).toBe('job-token');
            expect(headers['Authorization']).toBeUndefined();
        });
    });

    // --- Base URL handling ---

    describe('base URL handling', () => {
        it('uses gitlab.com/api/v4 by default', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('https://gitlab.com/api/v4');
        });

        it('uses self-managed URL when provided', async () => {
            const p = new GitLabProvider(CONFIG_SELF_MANAGED);
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('https://gitlab.example.com/api/v4');
        });

        it('appends /api/v4 to a bare self-managed host URL', async () => {
            const p = new GitLabProvider({
                ...CONFIG_PAT,
                url: 'https://gitlab.internal.com',
            });
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('https://gitlab.internal.com/api/v4');
        });

        it('does not double-append /api/v4 when URL already contains it', async () => {
            // The constructor strips any trailing /api/v4 before appending, so both forms work
            const p = new GitLabProvider({
                ...CONFIG_PAT,
                url: 'https://gitlab.example.com/api/v4',
            });
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('https://gitlab.example.com/api/v4');
            expect(url).not.toContain('/api/v4/api/v4');
        });
    });

    // --- listRepos ---

    describe('listRepos()', () => {
        it('normalizes a padded/mis-cased group into the request path (#266)', async () => {
            // See the sibling tests: the attribution key and the request path must be the same
            // spelling, and both derive from the shared `normalizeContainer`.
            const fetchMock = makeFetchMock([{body: [makeProjectFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);
            const p = new GitLabProvider({...CONFIG_PAT, group: ' TEST-Group '});

            await p.listRepos();

            expect(String(fetchMock.mock.calls[0][0])).toContain('test-group');
            expect(String(fetchMock.mock.calls[0][0])).not.toContain('TEST-Group');
        });

        it('returns repos mapped to GitRepo shape', async () => {
            const fetchMock = makeFetchMock([{body: [makeProjectFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0]).toEqual({
                id: '1001',
                name: 'test-group/my-repo',
                fullName: 'test-group/my-repo',
                displayName: 'My Repo',
                defaultBranch: 'main',
                isArchived: false,
            });
        });

        it('leaves displayName unset when the API response has no name field (projection falls back to the path)', async () => {
            const fetchMock = makeFetchMock([{body: [makeProjectFixture({name: undefined})]}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('test-group/my-repo');
            expect(repos[0].displayName).toBeUndefined();
        });

        it('uses groups/{group}/projects endpoint with URL-encoded group', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('/groups/test-group/projects');
        });

        it('URL-encodes group with slashes (nested subgroup path)', async () => {
            const p = new GitLabProvider({...CONFIG_PAT, group: 'parent/child'});
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('/groups/parent%2Fchild/projects');
        });

        it('includes include_archived=false in request', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('include_archived=false');
        });

        it('excludes archived projects even if API returns them', async () => {
            const fetchMock = makeFetchMock([{
                body: [
                    makeProjectFixture({id: 1, path_with_namespace: 'test-group/active', archived: false}),
                    makeProjectFixture({id: 2, path_with_namespace: 'test-group/archived', archived: true}),
                ],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('test-group/active');
        });

        it('adds include_subgroups=true when configured', async () => {
            const p = new GitLabProvider({...CONFIG_PAT, include_subgroups: true});
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await p.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('include_subgroups=true');
        });

        it('does not add include_subgroups when not configured', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.listRepos();

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).not.toContain('include_subgroups');
        });

        it('returns subgroup projects with full path_with_namespace as name', async () => {
            const p = new GitLabProvider({...CONFIG_PAT, include_subgroups: true});
            const fetchMock = makeFetchMock([{
                body: [
                    makeProjectFixture({
                        id: 999,
                        path_with_namespace: 'test-group/sub/deep-repo',
                        path: 'deep-repo',
                    }),
                ],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos[0].name).toBe('test-group/sub/deep-repo');
        });

        it('follows X-Next-Page pagination', async () => {
            const fetchMock = makeFetchMock([
                {
                    body: [makeProjectFixture({id: 1, path_with_namespace: 'test-group/repo-a', path: 'repo-a'})],
                    headers: {'x-next-page': '2'},
                },
                {
                    body: [makeProjectFixture({id: 2, path_with_namespace: 'test-group/repo-b', path: 'repo-b'})],
                    headers: {},
                },
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toHaveLength(2);
            expect(repos.map((r) => r.name)).toEqual(['test-group/repo-a', 'test-group/repo-b']);
        });

        it('returns empty array for empty group', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos).toEqual([]);
        });

        it('applies include filter (exact short name match)', async () => {
            const p = new GitLabProvider({...CONFIG_PAT, repos: ['my-repo']});
            const fetchMock = makeFetchMock([{
                body: [
                    makeProjectFixture({id: 1, path_with_namespace: 'test-group/my-repo', path: 'my-repo'}),
                    makeProjectFixture({id: 2, path_with_namespace: 'test-group/other', path: 'other'}),
                ],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos.map((r) => r.name)).toEqual(['test-group/my-repo']);
        });

        it('applies include filter (full namespace match)', async () => {
            const p = new GitLabProvider({...CONFIG_PAT, repos: ['test-group/my-repo']});
            const fetchMock = makeFetchMock([{
                body: [
                    makeProjectFixture({id: 1, path_with_namespace: 'test-group/my-repo', path: 'my-repo'}),
                    makeProjectFixture({id: 2, path_with_namespace: 'test-group/other', path: 'other'}),
                ],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await p.listRepos();

            expect(repos.map((r) => r.name)).toEqual(['test-group/my-repo']);
        });

        it('uses default branch "main" when default_branch is missing', async () => {
            const fetchMock = makeFetchMock([{
                body: [makeProjectFixture({default_branch: null})],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const repos = await provider.listRepos();

            expect(repos[0].defaultBranch).toBe('main');
        });
    });

    // --- getCommits ---

    describe('getCommits()', () => {
        it('returns commits mapped to GitCommit shape', async () => {
            const sha = 'abc123def456';
            const fetchMock = makeFetchMock([
                {body: [makeCommitFixture(sha)]},
                {body: [makeDiffEntryFixture()]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits(
                'test-group/my-repo',
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
            );

            expect(commits).toHaveLength(1);
            expect(commits[0]).toEqual({
                sha,
                author: {name: 'Goran', email: 'goran@wmg.rs', username: ''},
                date: '2024-01-15T10:00:00.000Z',
                message: 'feat: add feature',
                additions: 2,
                deletions: 1,
                filesChanged: ['src/foo.ts'],
                // The diff this call already fetched, carried out so the sync loop does
                // not request it a second time (#271).
                diffs: [{path: 'src/foo.ts', additions: 2, deletions: 1, status: 'modified'}],
            });
        });

        // --- diff reuse (#271) ---

        it('exposes diffs byte-identical to what getCommitDiff would return for the same sha', async () => {
            const sha = 'abc123def456';
            vi.stubGlobal(
                'fetch',
                makeFetchMock([{body: [makeCommitFixture(sha)]}, {body: [makeDiffEntryFixture()]}]),
            );
            const commits = await provider.getCommits('test-group/my-repo', '', '');

            vi.stubGlobal('fetch', makeFetchMock([{body: [makeDiffEntryFixture()]}]));
            const viaFallback = await provider.getCommitDiff('test-group/my-repo', sha);

            expect(commits[0].diffs).toEqual(viaFallback);
        });

        it('sets diffs to [] — not undefined — when the diff endpoint 404s, so the caller does not re-request', async () => {
            vi.stubGlobal(
                'fetch',
                makeFetchMock([
                    {body: [makeCommitFixture('initial')]},
                    {body: {message: '404 Not Found'}, status: 404},
                ]),
            );

            const commits = await provider.getCommits('test-group/my-repo', '', '');

            expect(commits).toHaveLength(1);
            expect(commits[0].diffs).toEqual([]);
            expect(commits[0].diffs).not.toBeUndefined();
        });

        // --- onProgress (#270) ---

        it('reports one listing tick per commit page, then one per diff fetch', async () => {
            const fetchMock = makeFetchMock([
                {body: [makeCommitFixture('aaa')], headers: {'x-next-page': '2'}},
                {body: [makeCommitFixture('bbb')]},
                {body: [makeDiffEntryFixture()]}, // diff for aaa
                {body: [makeDiffEntryFixture()]}, // diff for bbb
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            await provider.getCommits('test-group/my-repo', '', '', onProgress);

            // Listing carries no total (unknown until the last page); the per-commit
            // diff fan-out then reports real done/total.
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null},
                {done: 2, total: null},
                {done: 0, total: 2},
                {done: 1, total: 2},
                {done: 2, total: 2},
            ]);
        });

        it('reports an empty repo as a real zero total, not a suppressed step', async () => {
            vi.stubGlobal('fetch', makeFetchMock([{body: []}]));

            const onProgress = vi.fn();
            await provider.getCommits('test-group/my-repo', '', '', onProgress);

            // `total: 0` is reported truthfully; suppressing the meaningless
            // "commit 0/0" is the consumer's single responsibility.
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 0, total: null},
                {done: 0, total: 0},
            ]);
        });

        it('URL-encodes project path for API call', async () => {
            const fetchMock = makeFetchMock([
                {body: []},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.getCommits('test-group/my-repo', '2024-01-01T00:00:00Z', '');

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('test-group%2Fmy-repo');
        });

        it('passes since and until as query params', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.getCommits(
                'test-group/my-repo',
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
            );

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('since=2024-01-01T00%3A00%3A00Z');
            expect(url).toContain('until=2024-01-31T23%3A59%3A59Z');
        });

        it('follows X-Next-Page pagination for commit list', async () => {
            const sha1 = 'aaa111';
            const sha2 = 'bbb222';
            const fetchMock = makeFetchMock([
                {body: [makeCommitFixture(sha1)], headers: {'x-next-page': '2'}},
                {body: [makeCommitFixture(sha2)], headers: {}},
                {body: []}, // diff for sha1
                {body: []}, // diff for sha2
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits(
                'test-group/my-repo',
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
            );

            expect(commits).toHaveLength(2);
            expect(commits[0].sha).toBe(sha1);
            expect(commits[1].sha).toBe(sha2);
        });

        it('returns empty array for empty repo', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const commits = await provider.getCommits(
                'test-group/my-repo',
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
            );

            expect(commits).toEqual([]);
        });

        it('records zero stats when commit diff returns 404', async () => {
            const sha = 'abc123';
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve([makeCommitFixture(sha)]),
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

            const commits = await provider.getCommits(
                'test-group/my-repo',
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
            );

            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe(sha);
            expect(commits[0].additions).toBe(0);
            expect(commits[0].deletions).toBe(0);
            expect(commits[0].filesChanged).toEqual([]);
        });

        it('propagates non-404 diff errors (e.g. 401 auth failure)', async () => {
            const sha = 'abc123';
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: () => Promise.resolve([makeCommitFixture(sha)]),
                        text: () => Promise.resolve(''),
                    } as unknown as Response);
                }
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    headers: new Headers(),
                    json: () => Promise.resolve({}),
                    text: () => Promise.resolve('unauthorized'),
                } as unknown as Response);
            }));

            await expect(
                provider.getCommits(
                    'test-group/my-repo',
                    '2024-01-01T00:00:00Z',
                    '2024-01-31T23:59:59Z',
                ),
            ).rejects.toThrow('GitLab API error 401');
        });
    });

    // --- getPullRequests ---

    describe('getPullRequests()', () => {
        it('reports one listing tick per MR page (#270)', async () => {
            const fetchMock = makeFetchMock([
                {body: [makeMRFixture({iid: 1})], headers: {'x-next-page': '2'}},
                {body: [makeMRFixture({iid: 2})]},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onProgress = vi.fn();
            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '', onProgress);

            expect(prs).toHaveLength(2);
            expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
                {done: 1, total: null},
                {done: 2, total: null},
            ]);
        });

        it('returns PRs mapped to GitPR shape', async () => {
            const fetchMock = makeFetchMock([{body: [makeMRFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests(
                'test-group/my-repo',
                'all',
                '2024-01-01T00:00:00Z',
            );

            expect(prs).toHaveLength(1);
            expect(prs[0]).toEqual({
                id: '42',
                title: 'feat: add feature',
                author: {name: 'Alice', email: 'alice@example.com', username: 'alice'},
                state: 'open',
                createdAt: '2024-01-15T09:00:00.000Z',
                mergedAt: null,
                closedAt: null,
                updatedAt: '2024-01-16T09:00:00.000Z',
                reviewers: [{name: 'Bob', email: 'bob@example.com', username: 'bob'}],
                additions: 0,
                deletions: 0,
            });
        });

        it('normalizes opened → open', async () => {
            const fetchMock = makeFetchMock([{body: [makeMRFixture({state: 'opened'})]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs[0].state).toBe('open');
        });

        it('normalizes locked → open', async () => {
            const fetchMock = makeFetchMock([{body: [makeMRFixture({state: 'locked'})]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs[0].state).toBe('open');
        });

        it('normalizes merged → merged and preserves merged_at timestamp', async () => {
            const mr = makeMRFixture({
                state: 'merged',
                merged_at: '2024-01-16T12:00:00.000Z',
            });
            const fetchMock = makeFetchMock([{body: [mr]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs[0].state).toBe('merged');
            expect(prs[0].mergedAt).toBe('2024-01-16T12:00:00.000Z');
            expect(prs[0].closedAt).toBeNull();
        });

        it('normalizes closed → closed', async () => {
            const mr = makeMRFixture({
                state: 'closed',
                closed_at: '2024-01-16T12:00:00.000Z',
            });
            const fetchMock = makeFetchMock([{body: [mr]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs[0].state).toBe('closed');
            expect(prs[0].closedAt).toBe('2024-01-16T12:00:00.000Z');
            expect(prs[0].mergedAt).toBeNull();
        });

        it('maps state=open to GitLab opened in request', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.getPullRequests('test-group/my-repo', 'open', '');

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('state=opened');
        });

        it('uses state=all for unrecognized state', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.getPullRequests('test-group/my-repo', 'all', '');

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('state=all');
        });

        it('adds updated_after when since is provided', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            await provider.getPullRequests(
                'test-group/my-repo',
                'all',
                '2024-01-01T00:00:00Z',
            );

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toContain('updated_after=');
        });

        it('follows X-Next-Page pagination', async () => {
            const mr1 = makeMRFixture({iid: 1, title: 'MR 1'});
            const mr2 = makeMRFixture({iid: 2, title: 'MR 2'});
            const fetchMock = makeFetchMock([
                {body: [mr1], headers: {'x-next-page': '2'}},
                {body: [mr2], headers: {}},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs).toHaveLength(2);
        });

        it('returns empty array when no MRs exist', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs).toEqual([]);
        });

        it('handles MR with null author', async () => {
            const fetchMock = makeFetchMock([{body: [makeMRFixture({author: null})]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs[0].author).toEqual({name: '', email: '', username: ''});
        });

        it('handles MR with no reviewers field', async () => {
            const fetchMock = makeFetchMock([{body: [makeMRFixture({reviewers: undefined})]}]);
            vi.stubGlobal('fetch', fetchMock);

            const prs = await provider.getPullRequests('test-group/my-repo', 'all', '');

            expect(prs[0].reviewers).toEqual([]);
        });
    });

    // --- getReviewComments ---

    describe('getReviewComments()', () => {
        it('returns only DiffNote type comments', async () => {
            const diffNote = makeNoteFixture();
            const regularNote = makeNoteFixture({type: null, body: 'General comment'});
            const fetchMock = makeFetchMock([{body: [diffNote, regularNote]}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('test-group/my-repo', '42');

            expect(comments).toHaveLength(1);
            expect(comments[0].body).toBe('Looks good!');
        });

        it('excludes system-generated notes', async () => {
            const systemNote = makeNoteFixture({type: 'DiffNote', system: true, body: 'assigned to @alice'});
            const realNote = makeNoteFixture();
            const fetchMock = makeFetchMock([{body: [systemNote, realNote]}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('test-group/my-repo', '42');

            expect(comments).toHaveLength(1);
            expect(comments[0].body).toBe('Looks good!');
        });

        it('returns comments mapped to GitReviewComment shape', async () => {
            const fetchMock = makeFetchMock([{body: [makeNoteFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('test-group/my-repo', '42');

            expect(comments[0]).toEqual({
                author: {name: 'Bob', email: 'bob@example.com', username: 'bob'},
                body: 'Looks good!',
                createdAt: '2024-01-15T11:00:00.000Z',
                prId: '42',
            });
        });

        it('handles note with null author', async () => {
            const fetchMock = makeFetchMock([{body: [makeNoteFixture({author: null})]}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('test-group/my-repo', '42');

            expect(comments[0].author).toEqual({name: '', email: '', username: ''});
        });

        it('follows X-Next-Page pagination', async () => {
            const fetchMock = makeFetchMock([
                {body: [makeNoteFixture({body: 'first'})], headers: {'x-next-page': '2'}},
                {body: [makeNoteFixture({body: 'second'})], headers: {}},
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('test-group/my-repo', '42');

            expect(comments).toHaveLength(2);
            expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
        });

        it('returns empty array when MR has no DiffNote comments', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('test-group/my-repo', '42');

            expect(comments).toEqual([]);
        });

        it('returns empty array when all notes are system or non-diff type', async () => {
            const fetchMock = makeFetchMock([{
                body: [
                    makeNoteFixture({type: null, system: false}),
                    makeNoteFixture({type: 'DiffNote', system: true}),
                ],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const comments = await provider.getReviewComments('test-group/my-repo', '42');

            expect(comments).toEqual([]);
        });
    });

    // --- getCommitDiff ---

    describe('getCommitDiff()', () => {
        it('returns file diffs with additions/deletions parsed from hunks', async () => {
            const fetchMock = makeFetchMock([{body: [makeDiffEntryFixture()]}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

            expect(diffs).toHaveLength(1);
            expect(diffs[0]).toEqual({
                path: 'src/foo.ts',
                additions: 2,
                deletions: 1,
                status: 'modified',
            });
        });

        it('maps new_file=true to status "added"', async () => {
            const fetchMock = makeFetchMock([{
                body: [makeDiffEntryFixture({
                    new_file: true,
                    old_path: '',
                    new_path: 'src/new.ts',
                    diff: '+line1\n+line2\n',
                })],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

            expect(diffs[0].status).toBe('added');
            expect(diffs[0].path).toBe('src/new.ts');
        });

        it('maps deleted_file=true to status "deleted"', async () => {
            const fetchMock = makeFetchMock([{
                body: [makeDiffEntryFixture({
                    deleted_file: true,
                    old_path: 'src/gone.ts',
                    new_path: 'src/gone.ts',
                    diff: '-line1\n',
                })],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

            expect(diffs[0].status).toBe('deleted');
        });

        it('maps renamed_file=true to status "renamed"', async () => {
            const fetchMock = makeFetchMock([{
                body: [makeDiffEntryFixture({
                    renamed_file: true,
                    old_path: 'src/old.ts',
                    new_path: 'src/new.ts',
                    diff: '',
                })],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

            expect(diffs[0].status).toBe('renamed');
            expect(diffs[0].path).toBe('src/new.ts');
        });

        it('parses diff hunks correctly — counts only + lines as additions, - lines as deletions', async () => {
            const diff = '@@ -1,4 +1,6 @@\n line1\n+added1\n+added2\n-removed1\n line2\n --- header ignored\n +++ header ignored\n';
            const fetchMock = makeFetchMock([{
                body: [makeDiffEntryFixture({diff})],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

            expect(diffs[0].additions).toBe(2);
            expect(diffs[0].deletions).toBe(1);
        });

        it('returns zero stats for empty diff string', async () => {
            const fetchMock = makeFetchMock([{
                body: [makeDiffEntryFixture({diff: ''})],
            }]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

            expect(diffs[0].additions).toBe(0);
            expect(diffs[0].deletions).toBe(0);
        });

        it('follows X-Next-Page pagination', async () => {
            const fetchMock = makeFetchMock([
                {
                    body: [makeDiffEntryFixture({new_path: 'src/a.ts', old_path: 'src/a.ts'})],
                    headers: {'x-next-page': '2'},
                },
                {
                    body: [makeDiffEntryFixture({new_path: 'src/b.ts', old_path: 'src/b.ts'})],
                    headers: {},
                },
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

            expect(diffs).toHaveLength(2);
            expect(diffs.map((d) => d.path)).toEqual(['src/a.ts', 'src/b.ts']);
        });

        it('returns empty array for commit with no file changes', async () => {
            const fetchMock = makeFetchMock([{body: []}]);
            vi.stubGlobal('fetch', fetchMock);

            const diffs = await provider.getCommitDiff('test-group/my-repo', 'abc123');

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
            void listPromise.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(listPromise).rejects.toThrow('Rate limit exceeded');
        });

        it('retries on 5xx server error', async () => {
            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 500,
                        headers: new Headers(),
                        json: () => Promise.resolve([]),
                        text: () => Promise.resolve('server error'),
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
    });

    // --- Integration: listRepos → getCommits → getCommitDiff ---

    describe('integration: listRepos → getCommits → getCommitDiff', () => {
        it('full flow returns consistent data across all three methods', async () => {
            const sha = 'deadbeef1234';

            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                let body: unknown;

                if (url.includes('/groups/') && url.includes('/projects')) {
                    body = [makeProjectFixture()];
                } else if (url.includes('/repository/commits') && !url.includes('/diff')) {
                    body = [makeCommitFixture(sha)];
                } else if (url.includes('/diff')) {
                    body = [makeDiffEntryFixture()];
                } else {
                    body = [];
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
            expect(repos[0].name).toBe('test-group/my-repo');

            const commits = await provider.getCommits(
                repos[0].name,
                '2024-01-01T00:00:00Z',
                '2024-01-31T23:59:59Z',
            );
            expect(commits).toHaveLength(1);
            expect(commits[0].sha).toBe(sha);
            expect(commits[0].author).toEqual({
                name: 'Goran',
                email: 'goran@wmg.rs',
                username: '',
            });

            const diffs = await provider.getCommitDiff(repos[0].name, commits[0].sha);
            expect(diffs).toHaveLength(1);
            expect(diffs[0].path).toBe('src/foo.ts');

            expect(commits[0].filesChanged).toEqual(diffs.map((d) => d.path));
        });
    });
});
