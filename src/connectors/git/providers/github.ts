import type {
    GitProvider,
    GitProviderType,
    GitRepo,
    GitCommit,
    GitPR,
    GitReviewComment,
    GitFileDiff,
    GitAuthor,
    GitHubProviderConfig,
} from './types.js';

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

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGitHub(url: string, headers: Record<string, string>): Promise<Response> {
    let attempt = 0;

    while (attempt <= MAX_RETRIES) {
        let res: Response;
        try {
            res = await fetch(url, {headers});
        } catch (err) {
            if (attempt < MAX_RETRIES) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw err instanceof Error ? err : new Error(String(err));
        }

        if (res.status === 429) {
            const retryAfter = res.headers.get('retry-after');
            const delayMs = retryAfter
                ? parseFloat(retryAfter) * 1_000
                : 60_000 * (attempt + 1);
            if (attempt < MAX_RETRIES) {
                await sleep(delayMs);
                attempt++;
                continue;
            }
            throw new Error(`Rate limit exceeded after ${MAX_RETRIES} retries: ${url}`);
        }

        if (res.status === 403) {
            const remaining = res.headers.get('x-ratelimit-remaining');
            const reset = res.headers.get('x-ratelimit-reset');
            if (remaining === '0' && reset) {
                const delayMs = Math.max(parseInt(reset, 10) * 1_000 - Date.now(), 0) + 1_000;
                if (attempt < MAX_RETRIES) {
                    await sleep(delayMs);
                    attempt++;
                    continue;
                }
            }
            throw new Error(`GitHub API forbidden (403): ${url}: ${await res.text()}`);
        }

        if (res.status >= 500) {
            if (attempt < MAX_RETRIES) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw new Error(`GitHub API server error ${res.status}: ${url}`);
        }

        if (!res.ok) {
            throw new Error(`GitHub API error ${res.status}: ${url}`);
        }

        // Proactively pause when approaching rate limit
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = res.headers.get('x-ratelimit-reset');
        if (remaining !== null && parseInt(remaining, 10) < RATE_LIMIT_PAUSE_THRESHOLD && reset) {
            const delayMs = Math.max(parseInt(reset, 10) * 1_000 - Date.now(), 0) + 1_000;
            await sleep(delayMs);
        }

        return res;
    }

    throw new Error(`Request failed after ${MAX_RETRIES} retries: ${url}`);
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
    stats: {additions: number; deletions: number; total: number};
    files: Array<{filename: string; additions: number; deletions: number; status: string}>;
}

interface RawPR {
    number: number;
    title: string;
    user: {login: string} | null;
    state: string;
    created_at: string;
    merged_at: string | null;
    closed_at: string | null;
    requested_reviewers: Array<{login: string}>;
    additions: number;
    deletions: number;
}

interface RawReviewComment {
    user: {login: string} | null;
    body: string;
    created_at: string;
}

export class GitHubProvider implements GitProvider {
    readonly name: GitProviderType = 'github';
    private readonly org: string;
    private readonly authHeaders: Record<string, string>;
    private readonly includeRepos: string[];
    private readonly excludeRepos: string[];

    constructor(config: GitHubProviderConfig) {
        this.org = config.org;
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

    async getCommits(repo: string, since: string, until: string): Promise<GitCommit[]> {
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
            nextUrl = parseNextLink(res.headers.get('link'));
        }

        const commits: GitCommit[] = [];
        for (const summary of summaries) {
            try {
                const detailRes = await fetchGitHub(
                    `${BASE_URL}/repos/${this.org}/${repo}/commits/${summary.sha}`,
                    this.authHeaders,
                );
                const detail = (await detailRes.json()) as RawCommitDetail;
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
                    additions: detail.stats?.additions ?? 0,
                    deletions: detail.stats?.deletions ?? 0,
                    filesChanged: (detail.files ?? []).map((f) => f.filename),
                });
            } catch {
                // Skip commits where detail fetch fails
            }
        }

        return commits;
    }

    async getPullRequests(repo: string, state: string, since: string): Promise<GitPR[]> {
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
                if (sinceDate && new Date(pr.created_at) < sinceDate) {
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
                    reviewers,
                    additions: pr.additions ?? 0,
                    deletions: pr.deletions ?? 0,
                });
            }

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

    async getCommitDiff(repo: string, commitSha: string): Promise<GitFileDiff[]> {
        const res = await fetchGitHub(
            `${BASE_URL}/repos/${this.org}/${repo}/commits/${commitSha}`,
            this.authHeaders,
        );
        const detail = (await res.json()) as RawCommitDetail;

        return (detail.files ?? []).map((f) => ({
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            status: f.status,
        }));
    }
}
