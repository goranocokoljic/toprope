export interface GitCommit {
    sha: string;
    author_login: string | null;
    author_email: string | null;
    author_date: string;
    message: string;
    additions: number;
    deletions: number;
    files_changed: number;
    files: GitCommitFile[];
}

export interface GitCommitFile {
    filename: string;
    additions: number;
    deletions: number;
    changes: number;
    status: string;
}

export interface GitPullRequest {
    number: number;
    title: string;
    state: string;
    author_login: string | null;
    created_at: string;
    merged_at: string | null;
    closed_at: string | null;
    additions: number;
    deletions: number;
    changed_files: number;
    review_comments: number;
}

export interface GitReviewComment {
    pr_number: number;
    author_login: string | null;
    created_at: string;
}

export interface GitRepo {
    full_name: string;
    name: string;
    default_branch: string;
    pushed_at: string | null;
}

export interface GitClientConfig {
    org: string;
    token: string;
    baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const RATE_LIMIT_MAX_RETRIES = 3;

function parseNextLinkUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match?.[1] ?? null;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(header: string | null, attempt: number): number {
    if (!header) return 60_000 * (attempt + 1);
    const seconds = parseFloat(header);
    return !isNaN(seconds) && seconds >= 0 ? Math.ceil(seconds) * 1000 : 60_000 * (attempt + 1);
}

async function fetchWithRetry(
    url: string,
    headers: Record<string, string>,
    retries = RATE_LIMIT_MAX_RETRIES,
): Promise<Response> {
    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= retries) {
        let res: Response;
        try {
            res = await fetch(url, {headers});
        } catch (networkErr) {
            lastError = networkErr instanceof Error ? networkErr : new Error(String(networkErr));
            if (attempt < retries) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw lastError;
        }

        if (res.status === 429) {
            const delayMs = parseRetryAfterMs(res.headers.get('retry-after'), attempt);
            if (attempt < retries) {
                await sleep(delayMs);
                attempt++;
                continue;
            }
            throw new Error(`Rate limit exceeded after ${retries} retries: ${url}`);
        }

        if (res.status === 403) {
            const remaining = res.headers.get('x-ratelimit-remaining');
            const reset = res.headers.get('x-ratelimit-reset');
            if (remaining === '0' && reset) {
                const resetMs = parseInt(reset, 10) * 1000 - Date.now();
                const delayMs = Math.max(resetMs, 0) + 1_000;
                if (attempt < retries) {
                    await sleep(delayMs);
                    attempt++;
                    continue;
                }
            }
            throw new Error(`GitHub API forbidden (403) for ${url}: ${await res.text()}`);
        }

        if (res.status >= 500) {
            lastError = new Error(`GitHub API server error ${res.status} for ${url}`);
            if (attempt < retries) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw lastError;
        }

        if (!res.ok) {
            throw new Error(`GitHub API error ${res.status} for ${url}: ${await res.text()}`);
        }

        return res;
    }

    throw lastError ?? new Error(`Request failed after ${retries} retries: ${url}`);
}

interface RawCommitListItem {
    sha: string;
    commit: {
        author: {
            name: string;
            email: string;
            date: string;
        } | null;
        message: string;
    };
    author: {login: string} | null;
}

interface RawCommitDetail {
    sha: string;
    commit: {
        author: {
            name: string;
            email: string;
            date: string;
        } | null;
        message: string;
    };
    author: {login: string} | null;
    stats: {additions: number; deletions: number; total: number};
    files: Array<{
        filename: string;
        additions: number;
        deletions: number;
        changes: number;
        status: string;
    }>;
}

interface RawPullRequest {
    number: number;
    title: string;
    state: string;
    user: {login: string} | null;
    created_at: string;
    updated_at: string;
    merged_at: string | null;
    closed_at: string | null;
    additions: number;
    deletions: number;
    changed_files: number;
    review_comments: number;
}

interface RawReviewComment {
    user: {login: string} | null;
    created_at: string;
}

interface RawRepo {
    full_name: string;
    name: string;
    default_branch: string;
    pushed_at: string | null;
}

export class GitClient {
    private readonly org: string;
    private readonly headers: Record<string, string>;
    private readonly baseUrl: string;

    constructor(config: GitClientConfig) {
        this.org = config.org;
        this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        this.headers = {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    async listRepos(): Promise<GitRepo[]> {
        const repos: GitRepo[] = [];
        let nextUrl: string | null =
            `${this.baseUrl}/orgs/${this.org}/repos?per_page=100&sort=pushed`;

        while (nextUrl) {
            const res = await fetchWithRetry(nextUrl, this.headers);
            const page = (await res.json()) as RawRepo[];
            for (const r of page) {
                repos.push({
                    full_name: r.full_name,
                    name: r.name,
                    default_branch: r.default_branch,
                    pushed_at: r.pushed_at,
                });
            }
            nextUrl = parseNextLinkUrl(res.headers.get('link'));
        }

        return repos;
    }

    async getCommits(repo: string, since?: string, until?: string): Promise<GitCommit[]> {
        const params = new URLSearchParams({per_page: '100'});
        if (since) params.set('since', since);
        if (until) params.set('until', until);

        const listUrl = `${this.baseUrl}/repos/${this.org}/${repo}/commits?${params.toString()}`;
        const summaries: RawCommitListItem[] = [];
        let nextUrl: string | null = listUrl;

        while (nextUrl) {
            const res = await fetchWithRetry(nextUrl, this.headers);
            const page = (await res.json()) as RawCommitListItem[];
            summaries.push(...page);
            nextUrl = parseNextLinkUrl(res.headers.get('link'));
        }

        const commits: GitCommit[] = [];
        for (const summary of summaries) {
            try {
                const detailUrl = `${this.baseUrl}/repos/${this.org}/${repo}/commits/${summary.sha}`;
                const detailRes = await fetchWithRetry(detailUrl, this.headers);
                const detail = (await detailRes.json()) as RawCommitDetail;

                const authorDate = detail.commit.author?.date;
                if (!authorDate) {
                    // No author date (e.g. some bot/merge commits) — cannot bucket
                    // into a daily snapshot without fabricating a date, so skip it.
                    continue;
                }

                commits.push({
                    sha: detail.sha,
                    author_login: detail.author?.login ?? null,
                    author_email: detail.commit.author?.email ?? null,
                    author_date: authorDate,
                    message: detail.commit.message,
                    additions: detail.stats?.additions ?? 0,
                    deletions: detail.stats?.deletions ?? 0,
                    files_changed: detail.files?.length ?? 0,
                    files: (detail.files ?? []).map((f) => ({
                        filename: f.filename,
                        additions: f.additions,
                        deletions: f.deletions,
                        changes: f.changes,
                        status: f.status,
                    })),
                });
            } catch {
                // Skip individual commit fetch failures — list continues
            }
        }

        return commits;
    }

    async getPullRequests(repo: string, since?: string): Promise<GitPullRequest[]> {
        const params = new URLSearchParams({
            per_page: '100',
            state: 'all',
            sort: 'updated',
            direction: 'desc',
        });

        const prs: GitPullRequest[] = [];
        let nextUrl: string | null =
            `${this.baseUrl}/repos/${this.org}/${repo}/pulls?${params.toString()}`;
        const sinceDate = since ? new Date(since) : null;

        while (nextUrl) {
            const res = await fetchWithRetry(nextUrl, this.headers);
            const page = (await res.json()) as RawPullRequest[];

            let reachedSince = false;
            for (const pr of page) {
                // The list is sorted by updated_at desc, so updated_at is the
                // correct pagination cutoff. Breaking on created_at would miss
                // PRs created after `since` whose last update predates a
                // recently-touched older PR earlier in the page.
                if (sinceDate && new Date(pr.updated_at) < sinceDate) {
                    reachedSince = true;
                    break;
                }
                prs.push({
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    author_login: pr.user?.login ?? null,
                    created_at: pr.created_at,
                    merged_at: pr.merged_at,
                    closed_at: pr.closed_at,
                    additions: pr.additions ?? 0,
                    deletions: pr.deletions ?? 0,
                    changed_files: pr.changed_files ?? 0,
                    review_comments: pr.review_comments ?? 0,
                });
            }

            nextUrl = reachedSince ? null : parseNextLinkUrl(res.headers.get('link'));
        }

        return prs;
    }

    async getReviewComments(
        repo: string,
        prNumber: number,
        since?: string,
    ): Promise<GitReviewComment[]> {
        const params = new URLSearchParams({per_page: '100'});
        if (since) params.set('since', since);

        const comments: GitReviewComment[] = [];
        let nextUrl: string | null =
            `${this.baseUrl}/repos/${this.org}/${repo}/pulls/${prNumber}/comments?${params.toString()}`;

        while (nextUrl) {
            const res = await fetchWithRetry(nextUrl, this.headers);
            const page = (await res.json()) as RawReviewComment[];
            for (const c of page) {
                comments.push({
                    pr_number: prNumber,
                    author_login: c.user?.login ?? null,
                    created_at: c.created_at,
                });
            }
            nextUrl = parseNextLinkUrl(res.headers.get('link'));
        }

        return comments;
    }
}
