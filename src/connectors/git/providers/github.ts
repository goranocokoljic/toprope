import type {
    CommitDiffstat,
    CommitDiffstatCache,
    GitProvider,
    GitProviderType,
    GitRepo,
    GitCommit,
    GitPR,
    GitReviewComment,
    GitPRReview,
    GitReviewState,
    GitFileDiff,
    GitAuthor,
    GitHubProviderConfig,
    GitFetchProgressListener,
} from './types.js';
import {normalizeContainer} from './container.js';
import {
    GitProviderFetchError,
    MAX_RATE_LIMIT_RETRIES,
    MAX_SERVER_ERROR_RETRIES,
    PROBE_SERVER_ERROR_RETRIES,
    parseEpochResetMs,
    rateLimitDelayMs,
    rateLimitFallbackMs,
    serverErrorDelayMs,
    sleep,
} from './http-retry.js';

const BASE_URL = 'https://api.github.com';
// Pause proactively when remaining requests drops below this threshold
const RATE_LIMIT_PAUSE_THRESHOLD = 100;

function parseNextLink(header: string | null): string | null {
    if (!header) return null;
    const match = header.match(/<([^>]+)>;\s*rel="next"/);
    return match?.[1] ?? null;
}

function globMatch(pattern: string, str: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`, 'i').test(str);
}

async function fetchGitHub(
    url: string,
    headers: Record<string, string>,
    // Overridden only by checkAccess, which is an interactive probe rather than a data fetch
    // and must fail fast — see PROBE_SERVER_ERROR_RETRIES.
    maxTransientRetries: number = MAX_SERVER_ERROR_RETRIES,
): Promise<Response> {
    let attempt = 0;
    // Transient faults (5xx, transport) get their own, much longer budget than the rate-limit
    // paths below — see http-retry.ts. Counted separately so one class of fault cannot spend
    // the other's allowance.
    let transientRetries = 0;

    // `for (;;)`: the two budgets above are counted separately, so no single loop guard can
    // express both, and every branch below either `continue`s or throws (#272).
    for (;;) {
        let res: Response;
        try {
            res = await fetch(url, {headers});
        } catch (err) {
            // A transport fault is the same outage as a 503, seen one layer down — same budget,
            // same backoff. Wrapped so the in-run repo retry (#272) can classify it; the message
            // is preserved verbatim.
            if (transientRetries < maxTransientRetries) {
                await sleep(serverErrorDelayMs(transientRetries, null));
                transientRetries++;
                continue;
            }
            throw new GitProviderFetchError(
                err instanceof Error ? err.message : String(err),
                null,
                {cause: err},
            );
        }

        if (res.status === 429) {
            if (attempt < MAX_RATE_LIMIT_RETRIES) {
                await sleep(
                    rateLimitDelayMs(res.headers.get('retry-after'), rateLimitFallbackMs(attempt)),
                );
                attempt++;
                continue;
            }
            throw new GitProviderFetchError(
                `Rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries: ${url}`,
                429,
            );
        }

        if (res.status === 403) {
            const remaining = res.headers.get('x-ratelimit-remaining');
            const resetMs = parseEpochResetMs(res.headers.get('x-ratelimit-reset'));
            const retryAfter403 = res.headers.get('retry-after');
            // Primary rate limit: x-ratelimit-remaining=0 with reset time. `+ 1_000` so the
            // retry lands just AFTER the reset instant rather than exactly on it.
            if (remaining === '0' && resetMs !== null) {
                if (attempt < MAX_RATE_LIMIT_RETRIES) {
                    await sleep(rateLimitDelayMs(null, resetMs + 1_000));
                    attempt++;
                    continue;
                }
            // Secondary rate limit (abuse detection): Retry-After present, no ratelimit headers
            } else if (retryAfter403 !== null) {
                if (attempt < MAX_RATE_LIMIT_RETRIES) {
                    await sleep(rateLimitDelayMs(retryAfter403, rateLimitFallbackMs(attempt)));
                    attempt++;
                    continue;
                }
            }
            throw new GitProviderFetchError(
                `GitHub API forbidden (403): ${url}: ${await res.text()}`,
                403,
            );
        }

        if (res.status >= 500) {
            if (transientRetries < maxTransientRetries) {
                await sleep(serverErrorDelayMs(transientRetries, res.headers.get('retry-after')));
                transientRetries++;
                continue;
            }
            throw new GitProviderFetchError(
                `GitHub API server error ${res.status}: ${url}`,
                res.status,
            );
        }

        if (!res.ok) {
            throw new GitProviderFetchError(`GitHub API error ${res.status}: ${url}`, res.status);
        }

        // Proactively pause when approaching rate limit. Capped like every other rate-limit
        // wait (#272): a garbage reset header must not park the sync for a decade.
        const remaining = res.headers.get('x-ratelimit-remaining');
        const resetMs = parseEpochResetMs(res.headers.get('x-ratelimit-reset'));
        if (
            remaining !== null &&
            parseInt(remaining, 10) < RATE_LIMIT_PAUSE_THRESHOLD &&
            resetMs !== null
        ) {
            await sleep(rateLimitDelayMs(null, resetMs + 1_000));
        }

        return res;
    }
}

// Raw GitHub API response shapes

interface RawRepo {
    id: number;
    name: string;
    full_name: string;
    default_branch: string;
    archived: boolean;
}

interface RawCommitListItem {
    sha: string;
    /**
     * OPTIONAL, like `RawCommitDetail`'s `stats`/`files` and for the same reason: typed to
     * match what the readers actually assume rather than to what the endpoint usually sends.
     * GitHub embeds the identical `commit` object on the list and the detail responses, and
     * since #273 the diffstat cache-hit path builds the whole `GitCommit` from THIS row
     * instead of re-requesting the detail — so it is now read, and it guards.
     */
    commit?: {
        author: {name: string; email: string; date: string} | null;
        message: string;
    };
    author?: {login: string} | null;
}

interface RawCommitDetail {
    sha: string;
    commit: {
        author: {name: string; email: string; date: string} | null;
        message: string;
    };
    author: {login: string} | null;
    // Both OPTIONAL: GitHub omits them on some commits, which is why every reader here
    // guards (`detail.stats?.additions ?? 0`, `detail.files ?? []`). Typed to match what
    // the readers actually assume, so nobody writes `detail.files.map(...)` on the strength
    // of the declaration.
    stats?: {additions: number; deletions: number; total: number};
    files?: Array<{filename: string; additions: number; deletions: number; status: string}>;
}

/**
 * The single mapping from GitHub's commit-detail `files` to `GitFileDiff[]`, shared by
 * `getCommits` (which attaches it to `GitCommit.diffs`) and `getCommitDiff` (which is the
 * caller's fallback). One function so the two can never disagree — they read the SAME
 * endpoint, and if they mapped it differently the reuse in #271 would change churn.
 *
 * Returns `[]` for a detail with no `files` (GitHub omits the key on some commits) — an
 * answer, not "unknown": re-requesting the same endpoint would return the same thing. See
 * `GitCommit.diffs` on why `[]` must never be treated as "go fetch it".
 */
function toFileDiffs(detail: RawCommitDetail): GitFileDiff[] {
    return (detail.files ?? []).map((f) => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status,
    }));
}

interface RawPR {
    number: number;
    title: string;
    user: {login: string} | null;
    state: string;
    created_at: string;
    updated_at: string;
    merged_at: string | null;
    closed_at: string | null;
    requested_reviewers: Array<{login: string}>;
    // additions/deletions are NOT in the PR list response; only on the individual PR endpoint
}

interface RawReviewComment {
    user: {login: string} | null;
    body: string;
    created_at: string;
}

interface RawReview {
    user: {login: string} | null;
    state: string;
    submitted_at: string | null;
}

/**
 * GitHub review states → normalized verdicts. Only APPROVED and
 * CHANGES_REQUESTED are verdict events; COMMENTED, DISMISSED, PENDING and
 * anything future are skipped (null) so GitHub's event stream matches what
 * Bitbucket and GitLab can express — comment-level activity is already
 * covered by getReviewComments on all providers.
 */
function normalizeReviewState(state: string): GitReviewState | null {
    switch (state) {
        case 'APPROVED':
            return 'approved';
        case 'CHANGES_REQUESTED':
            return 'changes_requested';
        default:
            return null;
    }
}

export class GitHubProvider implements GitProvider {
    readonly name: GitProviderType = 'github';
    private readonly org: string;
    private readonly authHeaders: Record<string, string>;
    private readonly includeRepos: string[];
    private readonly excludeRepos: string[];
    private readonly diffstatCache?: CommitDiffstatCache;

    constructor(config: GitHubProviderConfig, diffstatCache?: CommitDiffstatCache) {
        // Normalized (#266): the org is the attribution key AND the request path, and both have
        // to be the same spelling. `providerContainer` normalizes the former; this normalizes the
        // latter, from the same shared helper, so a YAML `org: '  Acme '` cannot attribute rows to
        // `acme` while fetching `/orgs/%20Acme%20`.
        this.org = normalizeContainer(config.org);
        this.includeRepos = config.repos ?? [];
        this.excludeRepos = config.exclude_repos ?? [];
        this.authHeaders = {
            Authorization: `Bearer ${config.auth.api_token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
        this.diffstatCache = diffstatCache;
    }

    private shouldInclude(repoName: string): boolean {
        if (this.includeRepos.length > 0) {
            const included = this.includeRepos.some(
                (p) => p === repoName || globMatch(p, repoName),
            );
            if (!included) return false;
        }
        return !this.excludeRepos.some((p) => p === repoName || globMatch(p, repoName));
    }

    async checkAccess(): Promise<void> {
        await fetchGitHub(
            `${BASE_URL}/orgs/${this.org}/repos?per_page=1`,
            this.authHeaders,
            // An interactive probe, not a data fetch — a human is waiting on it (#272).
            PROBE_SERVER_ERROR_RETRIES,
        );
    }

    async listRepos(): Promise<GitRepo[]> {
        const repos: GitRepo[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/orgs/${this.org}/repos?per_page=100&sort=pushed`;

        while (nextUrl) {
            const res = await fetchGitHub(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawRepo[];

            for (const r of page) {
                if (r.archived) continue;
                if (!this.shouldInclude(r.name)) continue;
                repos.push({
                    id: String(r.id),
                    name: r.name,
                    fullName: r.full_name,
                    defaultBranch: r.default_branch,
                    isArchived: false,
                });
            }

            nextUrl = parseNextLink(res.headers.get('link'));
        }

        return repos;
    }

    async getCommits(
        repo: string,
        since: string,
        until: string,
        onProgress?: GitFetchProgressListener,
    ): Promise<GitCommit[]> {
        const params = new URLSearchParams({per_page: '100'});
        if (since) params.set('since', since);
        if (until) params.set('until', until);

        const summaries: RawCommitListItem[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/repos/${this.org}/${repo}/commits?${params.toString()}`;

        while (nextUrl) {
            const res = await fetchGitHub(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawCommitListItem[];
            summaries.push(...page);
            // One report per page — the only granularity available here, since the
            // commit total is unknown until the last page (#270).
            onProgress?.({done: summaries.length, total: null});
            nextUrl = parseNextLink(res.headers.get('link'));
        }

        const commits: GitCommit[] = [];
        // The per-commit detail fetch below is the O(commits) network cost that
        // dominates a full sync. Seed the known total so an observer switches to
        // done/total immediately, then tick every commit.
        //
        // The tick counts commits PROCESSED, not commits returned, so it also advances
        // over the one lossy branch below (a detail with no author date — a data-shape
        // problem no retry can fix). It no longer advances over a FAILED detail fetch:
        // that now throws (#272, review cycle 3), see the catch below.
        let processed = 0;
        onProgress?.({done: 0, total: summaries.length});
        // The whole repo's already-known commit stats, resolved in ONE batched query rather
        // than a point read per commit (#273). Empty map when no cache was supplied — every
        // probe path (doctor, test-connection) omits it, and behaves exactly as before.
        const cached: Map<string, CommitDiffstat> =
            this.diffstatCache?.load(repo, summaries.map((s) => s.sha)) ?? new Map();
        for (const summary of summaries) {
            try {
                // A list row with no author date does NOT take the hit path — it falls
                // through to the detail fetch exactly as it always did. The two endpoints
                // embed the same `commit` object so they agree in practice, but making the
                // hit conditional on the field being present is what guarantees the cache can
                // never DROP a commit the un-cached path would have kept: the worst case is
                // one re-request for a malformed commit that is skipped either way.
                const listCommit = summary.commit;
                if (listCommit?.author?.date) {
                    const hit = cached.get(summary.sha);
                    if (hit !== undefined) {
                        // A cache hit skips the DETAIL request entirely, not just a diff
                        // request. That is sound because the LIST row already carries every
                        // commit field the detail response would supply — sha,
                        // `commit.author` (name/email/date), `commit.message` and
                        // `author.login` are the same embedded objects on both endpoints —
                        // and the only things the detail adds are `stats` and `files`, which
                        // is exactly what the cache holds. So the row built here is the row
                        // the detail fetch would have built, for a fact (a commit's
                        // diffstat) that is immutable by construction.
                        commits.push({
                            sha: summary.sha,
                            author: {
                                name: listCommit.author.name,
                                email: listCommit.author.email,
                                username: summary.author?.login ?? '',
                            },
                            date: listCommit.author.date,
                            message: listCommit.message,
                            // Read back, never re-summed from `entries` — see the note on the
                            // miss path below for why the two legitimately differ on GitHub.
                            additions: hit.additions,
                            deletions: hit.deletions,
                            filesChanged: hit.entries.map((d) => d.path),
                            diffs: hit.entries,
                        });
                        continue;
                    }
                }

                const detailRes = await fetchGitHub(
                    `${BASE_URL}/repos/${this.org}/${repo}/commits/${summary.sha}`,
                    this.authHeaders,
                );
                const detail = (await detailRes.json()) as RawCommitDetail;

                // This detail response IS what `getCommitDiff` would re-request for the
                // same sha, so carry its file list out on `diffs` and let the caller skip
                // that second identical request (#271). `[]`, never undefined — a detail
                // with no `files` means "no files". See `GitCommit.diffs`.
                const diffs = toFileDiffs(detail);
                // NOT summed from `diffs`: GitHub caps `files` at 300 per commit while
                // `stats` covers the whole commit, so the totals stay authoritative
                // even where the file list is truncated. Unchanged by #271.
                const additions = detail.stats?.additions ?? 0;
                const deletions = detail.stats?.deletions ?? 0;
                // Cached BEFORE the author-date guard below (#273): the fetch succeeded and
                // the fact is immutable, so it is worth keeping even for a commit this run
                // then skips — otherwise exactly the malformed commits are re-requested every
                // run. Keyed on `summary.sha`, the same spelling `load` was asked for, so a
                // write is guaranteed to be found by the next run's read.
                //
                // `absent: false` always. Unlike Bitbucket/GitLab, a 404 here is NOT an
                // answer: the sha came from GitHub's own commit list, and the endpoint is the
                // commit itself rather than a separate diffstat resource — so a 404 is an
                // anomaly that must surface, and `fetchGitHub` throws it (#272). No failure
                // of any kind reaches this line.
                this.diffstatCache?.put(repo, summary.sha, {
                    additions,
                    deletions,
                    entries: diffs,
                    absent: false,
                });

                if (!detail.commit.author?.date) continue;

                commits.push({
                    sha: detail.sha,
                    author: {
                        name: detail.commit.author.name,
                        email: detail.commit.author.email,
                        username: detail.author?.login ?? '',
                    },
                    date: detail.commit.author.date,
                    message: detail.commit.message,
                    additions,
                    deletions,
                    filesChanged: diffs.map((d) => d.path),
                    diffs,
                });
                // Deliberately NO `catch` (#272, review cycle 3) — every detail failure now
                // propagates out of `getCommits`. This used to record the error and carry on,
                // which is what made the in-run repo retry unsafe here. Two things forced it:
                //
                //   1. Unlike Bitbucket/GitLab, where the per-commit fetch is a DIFFSTAT and a
                //      failure only understates one commit's churn, on GitHub the detail response
                //      IS the commit — its author date, message and stats. A swallowed failure
                //      dropped the commit entirely, so `raw_author_daily` (and the `git_snapshots`
                //      projection over it) silently lost it.
                //   2. Swallowing left `commits.length > 0`, so `getCommits` returned normally,
                //      `commitsComplete` stayed true and the cursor advanced past the gap — making
                //      the loss permanent. The repo retry made that MORE likely, not less: the
                //      retry exists for a healing outage, and a healing outage's most probable
                //      outcome is a PARTIAL second attempt. The run then recorded
                //      `Recovered after retry` over a lossy result.
                //
                // Throwing routes the loss through the same path as every other fetch fault: the
                // request layer's own 5xx budget first, then the in-run repo retry, then — if it
                // never heals — `commitsComplete = false`, the cursor held, and the whole window
                // re-covered next run (#231). Loud and recoverable rather than a silent, permanent
                // snapshot gap. NOT narrowed to non-404 the way Bitbucket and GitLab are: a sha
                // GitHub's own commit list just returned is not legitimately absent, so a 404 here
                // is an anomaly to surface, not a "this commit has no diff" answer.
                //
                // This closes the half of #275 that #272 could reach. What remains for #275 is the
                // OTHER lossy branch — the `continue` above, a data-shape problem no retry fixes.
            } finally {
                // Its own counter, unlike the other two providers: the `continue` above skips the
                // push, so `commits.length` would stall while the loop kept working. In a `finally`
                // so the tick is not lost on the throwing path either. Incremented outside the
                // optional call so the count is identical whether or not a listener is attached.
                processed++;
                onProgress?.({done: processed, total: summaries.length});
            }
        }

        return commits;
    }

    async getPullRequests(
        repo: string,
        state: string,
        since: string,
        onProgress?: GitFetchProgressListener,
    ): Promise<GitPR[]> {
        const params = new URLSearchParams({
            per_page: '100',
            state: state || 'all',
            sort: 'updated',
            direction: 'desc',
        });

        const prs: GitPR[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/repos/${this.org}/${repo}/pulls?${params.toString()}`;
        const sinceDate = since ? new Date(since) : null;

        while (nextUrl) {
            const res = await fetchGitHub(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawPR[];

            let reachedSince = false;
            for (const pr of page) {
                // The list is sorted by updated_at desc, so use updated_at as the cutoff.
                // Using created_at would cause early termination when an old PR appears
                // near the top of the list due to a recent comment or update.
                if (sinceDate && new Date(pr.updated_at) < sinceDate) {
                    reachedSince = true;
                    break;
                }

                const author: GitAuthor = {
                    name: '',
                    email: '',
                    username: pr.user?.login ?? '',
                };

                const reviewers: GitAuthor[] = (pr.requested_reviewers ?? []).map((r) => ({
                    name: '',
                    email: '',
                    username: r.login,
                }));

                // GitHub API returns 'closed' for both merged and closed PRs;
                // distinguish merged by presence of merged_at
                const normalizedState =
                    pr.state === 'closed' && pr.merged_at ? 'merged' : pr.state;

                prs.push({
                    id: String(pr.number),
                    title: pr.title,
                    author,
                    state: normalizedState,
                    createdAt: pr.created_at,
                    mergedAt: pr.merged_at,
                    closedAt: pr.closed_at,
                    updatedAt: pr.updated_at,
                    reviewers,
                    // additions/deletions are absent from the PR list endpoint;
                    // only the individual PR endpoint (/pulls/{number}) returns them.
                    additions: 0,
                    deletions: 0,
                });
            }

            onProgress?.({done: prs.length, total: null});
            nextUrl = reachedSince ? null : parseNextLink(res.headers.get('link'));
        }

        return prs;
    }

    async getReviewComments(repo: string, prId: string): Promise<GitReviewComment[]> {
        const comments: GitReviewComment[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/repos/${this.org}/${repo}/pulls/${prId}/comments?per_page=100`;

        while (nextUrl) {
            const res = await fetchGitHub(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawReviewComment[];

            for (const c of page) {
                comments.push({
                    author: {
                        name: '',
                        email: '',
                        username: c.user?.login ?? '',
                    },
                    body: c.body,
                    createdAt: c.created_at,
                    prId,
                });
            }

            nextUrl = parseNextLink(res.headers.get('link'));
        }

        return comments;
    }

    async getPRReviews(repo: string, prId: string): Promise<GitPRReview[]> {
        const reviews: GitPRReview[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/repos/${this.org}/${repo}/pulls/${prId}/reviews?per_page=100`;

        while (nextUrl) {
            const res = await fetchGitHub(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawReview[];

            for (const r of page) {
                // PENDING reviews have no submitted_at — not yet a review event.
                if (!r.submitted_at) continue;
                const state = normalizeReviewState(r.state);
                if (!state) continue;
                reviews.push({
                    author: {
                        name: '',
                        email: '',
                        username: r.user?.login ?? '',
                    },
                    state,
                    submittedAt: r.submitted_at,
                    prId,
                });
            }

            nextUrl = parseNextLink(res.headers.get('link'));
        }

        return reviews;
    }

    async getCommitDiff(repo: string, commitSha: string): Promise<GitFileDiff[]> {
        const res = await fetchGitHub(
            `${BASE_URL}/repos/${this.org}/${repo}/commits/${commitSha}`,
            this.authHeaders,
        );
        const detail = (await res.json()) as RawCommitDetail;

        return toFileDiffs(detail);
    }
}
