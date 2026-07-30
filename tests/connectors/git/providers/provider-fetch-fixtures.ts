/**
 * The canonical per-provider `fetch` stub and route table for driving the REAL provider classes
 * (`GitHubProvider`, `BitbucketProvider`, `GitLabProvider`) without a network.
 *
 * Extracted in #280 because these fixtures encode each provider's **URL shape** and its response
 * payload shape, and a second copy is a second source of truth: a real change (GitLab's
 * project-scoped commits path, GitHub's `files`/`stats` payload, Bitbucket's `diffstat` route)
 * would need N independent edits, and because an unrouted URL resolves to a benign empty page
 * rather than throwing, a stale regex degrades into "the provider returned no commits" instead of
 * a loud failure. One table, one edit.
 *
 * The three route builders describe ONE repo (`repo1`) with {@link SHAS} commits by one author,
 * each touching the same files — the minimum a `getCommits` call needs to complete, plus the
 * repo-list and PR-list routes a full `syncProviders` run also walks.
 *
 * NOT a place for assertions or database helpers: each consuming test owns those. This module is
 * fixture data and the transport stub, nothing else.
 */
import {vi} from 'vitest';
import type {GitProviderConfig} from '../../../../src/connectors/git/providers/types';

export const AUTHOR_EMAIL = 'alice@example.com';
export const COMMIT_DATE = '2024-01-15T10:00:00.000Z';
export const SHAS = ['sha-aaa', 'sha-bbb', 'sha-ccc'];

/** The repo every route builder below describes. */
export const REPO = 'repo1';

/**
 * One routed endpoint.
 *
 * `body` for a fixed payload, `bodyFor` when the response must echo something from the URL
 * (GitHub's commit-detail endpoint has to return the sha it was asked for). Two fields rather
 * than a `unknown | fn` union, which collapses to plain `unknown` and needs a cast.
 */
export type Route = {
    match: RegExp;
    body?: unknown;
    bodyFor?: (url: string) => unknown;
    status?: number;
};

export interface CountingFetch {
    fetchMock: ReturnType<typeof vi.fn>;
    /** How many requests hit URLs matching `pattern`, counted from the request log. */
    hits: (pattern: RegExp) => number;
    /** Every requested URL, in order. */
    urls: string[];
}

/**
 * A `fetch` stub that routes by URL and logs every request.
 *
 * An UNROUTED URL resolves to `{values: []}` with status 200 rather than throwing, so a provider's
 * unrelated paging does not have to be modelled. Note the shape: that is an empty *Bitbucket*
 * page. GitHub and GitLab list endpoints return bare arrays, so an unrouted URL on those two
 * yields an object where the provider expects an array — which throws on `.map`/`.length` rather
 * than reading as empty. Do not rely on the fallback as "an empty response" for those two; route
 * the endpoint explicitly (all three builders below do).
 */
export function makeCountingFetch(routes: Route[]): CountingFetch {
    const urls: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        urls.push(u);
        const route = routes.find((r) => r.match.test(u));
        const status = route?.status ?? 200;
        const body = route ? (route.bodyFor ? route.bodyFor(u) : route.body) : {values: []};
        return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers({}),
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(JSON.stringify(body)),
        } as unknown as Response);
    });
    return {
        fetchMock,
        hits: (pattern: RegExp): number => urls.filter((u) => pattern.test(u)).length,
        urls,
    };
}

export const BITBUCKET_CONFIG: GitProviderConfig = {
    type: 'bitbucket',
    workspace: 'test-ws',
    auth: {type: 'access_token', token: 'tok'},
};

export const GITHUB_CONFIG: GitProviderConfig = {
    type: 'github',
    org: 'test-org',
    auth: {type: 'token', api_token: 'tok'},
};

export const GITLAB_CONFIG: GitProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    auth: {type: 'personal_access_token', token: 'tok'},
};

/** `diffstatStatus` lets a caller drive the 404-is-an-answer path (#271). */
export function bitbucketRoutes(diffstatStatus = 200): Route[] {
    return [
        {
            match: /\/repositories\/test-ws\?/,
            body: {
                values: [
                    {
                        uuid: 'u1',
                        slug: 'repo1',
                        full_name: 'test-ws/repo1',
                        mainbranch: {name: 'main'},
                        scm: 'git',
                    },
                ],
            },
        },
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
            status: diffstatStatus,
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
    ];
}

export function githubRoutes(): Route[] {
    return [
        {
            match: /\/orgs\/test-org\/repos\?/,
            body: [
                {
                    id: 1,
                    name: 'repo1',
                    full_name: 'test-org/repo1',
                    default_branch: 'main',
                    archived: false,
                },
            ],
        },
        {
            match: /\/repos\/test-org\/repo1\/commits\?/,
            // The list row carries the embedded `commit`/`author` objects GitHub really returns on
            // this endpoint, not just the sha. That is load-bearing, not decoration: the diffstat
            // cache's HIT path (#273) skips the detail request entirely and builds the row from
            // these fields, and it only takes that path when the list row already has a usable
            // author date. A sha-only fixture silently pins the cold path forever.
            body: SHAS.map((sha) => ({
                sha,
                commit: {
                    author: {name: 'Alice', email: AUTHOR_EMAIL, date: COMMIT_DATE},
                    message: 'feat: work',
                },
                author: {login: 'alice-gh'},
            })),
        },
        {
            // Detail endpoint — no `?`, which is what distinguishes it from the list URL.
            // Echoes the requested sha so the three commits stay distinct.
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
        {match: /\/repos\/test-org\/repo1\/pulls\?/, body: []},
    ];
}

export function gitlabRoutes(): Route[] {
    return [
        {
            match: /\/groups\/test-group\/projects\?/,
            body: [
                {
                    id: 7,
                    name: 'Repo1',
                    path: 'repo1',
                    path_with_namespace: 'test-group/repo1',
                    default_branch: 'main',
                    archived: false,
                },
            ],
        },
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
        {match: /\/merge_requests\?/, body: []},
    ];
}

/**
 * The file-level diff each builder's per-commit endpoint describes, as the provider is expected to
 * return it on `GitCommit.diffs` — the SAME facts as the route bodies above, expressed as the
 * normalized shape, so a conformance check can assert the whole entry rather than only its path.
 *
 * GitLab's per-commit endpoint returns a unified hunk instead of a line-count pair, so its numbers
 * are what the provider's hunk parser derives from `@@ -1,2 +1,4 @@\n a\n+b\n+c\n-d\n` (two added
 * lines, one removed), not the 30/5 the other two report.
 */
export const EXPECTED_DIFFS: Record<GitProviderConfig['type'], Array<{
    path: string;
    additions: number;
    deletions: number;
    status: string;
}>> = {
    github: [
        {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
        {path: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
    ],
    bitbucket: [
        {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
        {path: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
    ],
    gitlab: [{path: 'src/foo.ts', additions: 2, deletions: 1, status: 'modified'}],
};
