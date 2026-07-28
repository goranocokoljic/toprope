import type {
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
    MAX_SERVER_ERROR_RETRIES,
    PROBE_SERVER_ERROR_RETRIES,
    parseEpochResetMs,
    rateLimitDelayMs,
    serverErrorDelayMs,
    sleep,
} from './http-retry.js';

const BASE_URL = 'https://api.github.com';
// Pause proactively when remaining requests drops below this threshold
const RATE_LIMIT_PAUSE_THRESHOLD = 100;
const MAX_RETRIES = 3;

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

    // `for (;;)`, not `while (attempt <= MAX_RETRIES)`: every branch below either `continue`s
    // or throws, so the guard could never end the loop and the post-loop throw it implied was
    // unreachable. Since #272 the two budgets are counted separately anyway, so one guard
    // cannot express both.
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
            if (attempt < MAX_RETRIES) {
                await sleep(
                    rateLimitDelayMs(res.headers.get('retry-after'), 60_000 * (attempt + 1)),
                );
                attempt++;
                continue;
            }
            throw new GitProviderFetchError(
                `Rate limit exceeded after ${MAX_RETRIES} retries: ${url}`,
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
                if (attempt < MAX_RETRIES) {
                    await sleep(rateLimitDelayMs(null, resetMs + 1_000));
                    attempt++;
                    continue;
                }
            // Secondary rate limit (abuse detection): Retry-After present, no ratelimit headers
            } else if (retryAfter403 !== null) {
                if (attempt < MAX_RETRIES) {
                    await sleep(rateLimitDelayMs(retryAfter403, 60_000 * (attempt + 1)));
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
    commit: {
        author: {name: string; email: string; date: string} | null;
        message: string;
    };
    author: {login: string} | null;
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

    constructor(config: GitHubProviderConfig) {
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
        let lastDetailError: Error | null = null;
        // The per-commit detail fetch below is the O(commits) network cost that
        // dominates a full sync. Seed the known total so an observer switches to
        // done/total immediately, then tick every commit.
        //
        // The tick counts commits PROCESSED, not commits returned, so it also advances
        // over the two lossy branches below (a detail fetch that fails, a detail with
        // no author date). That keeps the counter moving, but it does NOT report the
        // loss — a partial detail failure returns fewer commits without throwing, and
        // the caller cannot currently tell. That is a pre-existing gap in this
        // function's contract, not something this counter fixes; see #275. The
        // per-repo symptom it leaves visible is `commit N/N` followed by `diff 0/M`
        // with M < N (documented on GitSyncProgress.repo_step).
        let processed = 0;
        onProgress?.({done: 0, total: summaries.length});
        for (const summary of summaries) {
            try {
                const detailRes = await fetchGitHub(
                    `${BASE_URL}/repos/${this.org}/${repo}/commits/${summary.sha}`,
                    this.authHeaders,
                );
                const detail = (await detailRes.json()) as RawCommitDetail;
                if (!detail.commit.author?.date) continue;

                // This detail response IS what `getCommitDiff` would re-request for the
                // same sha, so carry its file list out on `diffs` and let the caller skip
                // that second identical request (#271). `[]`, never undefined — a detail
                // with no `files` means "no files". See `GitCommit.diffs`.
                const diffs = toFileDiffs(detail);
                commits.push({
                    sha: detail.sha,
                    author: {
                        name: detail.commit.author.name,
                        email: detail.commit.author.email,
                        username: detail.author?.login ?? '',
                    },
                    date: detail.commit.author.date,
                    message: detail.commit.message,
                    // NOT summed from `diffs`: GitHub caps `files` at 300 per commit while
                    // `stats` covers the whole commit, so the totals stay authoritative
                    // even where the file list is truncated. Unchanged by #271.
                    additions: detail.stats?.additions ?? 0,
                    deletions: detail.stats?.deletions ?? 0,
                    filesChanged: diffs.map((d) => d.path),
                    diffs,
                });
            } catch (err) {
                lastDetailError = err instanceof Error ? err : new Error(String(err));
            } finally {
                // Its own counter, unlike the other two providers: the `continue` above
                // and this `catch` both skip the push, so `commits.length` would stall
                // while the loop kept working. Incremented outside the optional call so
                // the count is identical whether or not a listener is attached.
                processed++;
                onProgress?.({done: processed, total: summaries.length});
            }
        }

        // If every single detail fetch failed on a non-empty commit list, the error
        // is systemic (auth failure, network outage) — surface it rather than returning [].
        //
        // #272 NOTE: because a PARTIAL detail failure does not throw, neither of #272's two
        // hardening layers reaches it. The request-level 5xx budget in `fetchGitHub` does
        // apply to each detail request, but the in-run REPO retry cannot: it only fires on a
        // throw out of `getCommits`, so a 5xx that outlasts the request budget on some commits
        // still returns a silently short list with `commitsComplete` left true. That is #275,
        // filed deliberately — deciding whether a partial loss holds the whole provider cursor
        // is a data-integrity call of the same weight as #231/#235 and gets its own review.
        // Unlike Bitbucket and GitLab, which re-throw anything that is not a typed 404 and so
        // do reach the repo retry.
        if (commits.length === 0 && summaries.length > 0 && lastDetailError) {
            throw lastDetailError;
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
