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
    GitLabProviderConfig,
    GitFetchProgressListener,
} from './types.js';
import {normalizeContainer} from './container.js';

const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4';
const MAX_RETRIES = 3;
const PER_PAGE = 100;

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAuthHeaders(auth: GitLabProviderConfig['auth']): Record<string, string> {
    if (auth.type === 'personal_access_token') {
        return {'PRIVATE-TOKEN': auth.token};
    }
    if (auth.type === 'job_token') {
        return {'JOB-TOKEN': auth.token};
    }
    return {Authorization: `Bearer ${auth.token}`};
}

async function fetchGitLab(url: string, headers: Record<string, string>): Promise<Response> {
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
            const retryAfter = res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset');
            const delayMs = retryAfter ? parseFloat(retryAfter) * 1_000 : 60_000 * (attempt + 1);
            if (attempt < MAX_RETRIES) {
                await sleep(delayMs);
                attempt++;
                continue;
            }
            throw new Error(`Rate limit exceeded after ${MAX_RETRIES} retries: ${url}`);
        }

        if (res.status >= 500) {
            if (attempt < MAX_RETRIES) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw new Error(`GitLab API server error ${res.status}: ${url}`);
        }

        if (!res.ok) {
            throw new Error(`GitLab API error ${res.status}: ${url}`);
        }

        return res;
    }

    throw new Error(`Request failed after ${MAX_RETRIES} retries: ${url}`);
}

function parseDiffHunks(diff: string): {additions: number; deletions: number} {
    let additions = 0;
    let deletions = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            deletions++;
        }
    }
    return {additions, deletions};
}

function normalizeMRState(state: string): string {
    switch (state) {
        case 'opened':
        case 'locked':
            return 'open';
        case 'merged':
            return 'merged';
        case 'closed':
            return 'closed';
        default:
            return state;
    }
}

function globMatch(pattern: string, str: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`, 'i').test(str);
}

// Raw API shapes

interface RawProject {
    id: number;
    /** GitLab's human-readable project name — typed optional so a payload missing it degrades to the path (#213). */
    name?: string;
    path: string;
    path_with_namespace: string;
    default_branch: string;
    archived: boolean;
}

interface RawCommit {
    id: string;
    author_name: string;
    author_email: string;
    authored_date: string;
    message: string;
}

interface RawDiffEntry {
    old_path: string;
    new_path: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
    diff: string;
}

interface RawMRAuthor {
    username: string;
    name: string;
    email?: string;
}

interface RawMR {
    iid: number;
    title: string;
    author: RawMRAuthor | null;
    state: string;
    created_at: string;
    updated_at: string;
    merged_at: string | null;
    closed_at: string | null;
    reviewers?: RawMRAuthor[];
}

interface RawNote {
    author: RawMRAuthor | null;
    body: string;
    created_at: string;
    type: string | null;
    system: boolean;
}

export class GitLabProvider implements GitProvider {
    readonly name: GitProviderType = 'gitlab';
    private readonly group: string;
    private readonly baseUrl: string;
    private readonly authHeaders: Record<string, string>;
    private readonly includeRepos: string[];
    private readonly includeSubgroups: boolean;

    constructor(config: GitLabProviderConfig) {
        // Normalized (#266) — see the note in `github.ts`: the attribution key and the request
        // path must be the same spelling, and both derive from `normalizeContainer`.
        this.group = normalizeContainer(config.group);
        // config.url is the base host (e.g. "https://gitlab.example.com"); always append /api/v4
        this.baseUrl = (config.url ?? DEFAULT_BASE_URL).replace(/\/$/, '').replace(/\/api\/v4$/, '') + '/api/v4';
        this.authHeaders = buildAuthHeaders(config.auth);
        this.includeRepos = config.repos ?? [];
        this.includeSubgroups = config.include_subgroups ?? false;
    }

    private shouldInclude(pathWithNamespace: string): boolean {
        if (this.includeRepos.length === 0) return true;
        const shortPath = pathWithNamespace.split('/').pop() ?? pathWithNamespace;
        return this.includeRepos.some(
            (p) =>
                p === pathWithNamespace ||
                p === shortPath ||
                globMatch(p, pathWithNamespace) ||
                globMatch(p, shortPath),
        );
    }

    private projectPath(repo: string): string {
        return encodeURIComponent(repo);
    }

    async checkAccess(): Promise<void> {
        await fetchGitLab(
            `${this.baseUrl}/groups/${encodeURIComponent(this.group)}/projects?per_page=1`,
            this.authHeaders,
        );
    }

    async listRepos(): Promise<GitRepo[]> {
        // the name is path_with_namespace (e.g. "group/repo") rather than the short slug so that
        // getCommits/getPullRequests etc. can URL-encode the full path and reach subgroup projects.
        // name === fullName is intentional: GitLab has no separate "slug" vs "full name" distinction.
        let baseUrl = `${this.baseUrl}/groups/${encodeURIComponent(this.group)}/projects?include_archived=false&per_page=${PER_PAGE}`;
        if (this.includeSubgroups) {
            baseUrl += '&include_subgroups=true';
        }

        const repos: GitRepo[] = [];
        let page = 1;

        let hasNextPage = true;
        while (hasNextPage) {
            const res = await fetchGitLab(`${baseUrl}&page=${page}`, this.authHeaders);
            const projects = (await res.json()) as RawProject[];

            for (const p of projects) {
                if (p.archived) continue;
                if (!this.shouldInclude(p.path_with_namespace)) continue;
                repos.push({
                    id: String(p.id),
                    name: p.path_with_namespace,
                    fullName: p.path_with_namespace,
                    displayName: p.name,
                    defaultBranch: p.default_branch ?? 'main',
                    isArchived: false,
                });
            }

            const nextPage = res.headers.get('x-next-page');
            hasNextPage = !!nextPage && nextPage !== '';
            if (hasNextPage) page = parseInt(nextPage!, 10);
        }

        return repos;
    }

    async getCommits(
        repo: string,
        since: string,
        until: string,
        onProgress?: GitFetchProgressListener,
    ): Promise<GitCommit[]> {
        const params = new URLSearchParams({ per_page: String(PER_PAGE) });
        if (since) params.set('since', since);
        if (until) params.set('until', until);

        const raw: RawCommit[] = [];
        let page = 1;

        let hasNextPage = true;
        while (hasNextPage) {
            params.set('page', String(page));
            const url = `${this.baseUrl}/projects/${this.projectPath(repo)}/repository/commits?${params.toString()}`;
            const res = await fetchGitLab(url, this.authHeaders);
            const data = (await res.json()) as RawCommit[];
            raw.push(...data);
            // One report per page — the commit total is unknown until the last
            // page, so a running seen-so-far count is all that is honest (#270).
            onProgress?.({done: raw.length, total: null});

            const nextPage = res.headers.get('x-next-page');
            hasNextPage = !!nextPage && nextPage !== '';
            if (hasNextPage) page = parseInt(nextPage!, 10);
        }

        // The per-commit diff fetch is the O(commits) cost of this call — report each
        // one so an observer's counter ticks during it, not only once it returns. It is
        // also the ONLY diff walk a sync makes per commit (the walk is itself paged, so a
        // very wide commit still costs >1 request): `diffs` below hands this exact result
        // to the caller so it does not re-walk the same endpoint (#271).
        const commits: GitCommit[] = [];
        onProgress?.({done: 0, total: raw.length});
        for (const c of raw) {
            let diffs: GitFileDiff[] = [];
            try {
                diffs = await this.getCommitDiff(repo, c.id);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // Re-throw systemic errors (auth failure, server error); silently swallow 404
                // (GitLab may return 404 for diffs on certain commits, e.g. initial commits)
                if (!msg.includes(' 404:')) throw err;
            }

            commits.push({
                sha: c.id,
                author: {
                    name: c.author_name,
                    email: c.author_email,
                    // GitLab commit API does not expose usernames; only MR authors have usernames
                    username: '',
                },
                date: c.authored_date,
                message: c.message,
                additions: diffs.reduce((s, d) => s + d.additions, 0),
                deletions: diffs.reduce((s, d) => s + d.deletions, 0),
                filesChanged: diffs.map((d) => d.path),
                // `[]`, never undefined — including via the 404 branch above, where `[]`
                // is the true answer. See `GitCommit.diffs` for why that matters (#271).
                diffs,
            });
            // Every iteration pushes, so the commit count IS the processed count —
            // no separate counter to keep in step.
            onProgress?.({done: commits.length, total: raw.length});
        }

        return commits;
    }

    async getPullRequests(
        repo: string,
        state: string,
        since: string,
        onProgress?: GitFetchProgressListener,
    ): Promise<GitPR[]> {
        let glState: string;
        switch (state) {
            case 'open':
                glState = 'opened';
                break;
            case 'merged':
                glState = 'merged';
                break;
            case 'closed':
                glState = 'closed';
                break;
            default:
                glState = 'all';
                break;
        }

        const params = new URLSearchParams({
            per_page: String(PER_PAGE),
            order_by: 'updated_at',
            sort: 'desc',
            state: glState,
        });
        if (since) params.set('updated_after', since);

        const prs: GitPR[] = [];
        let page = 1;

        while (true) {
            params.set('page', String(page));
            const url = `${this.baseUrl}/projects/${this.projectPath(repo)}/merge_requests?${params.toString()}`;
            const res = await fetchGitLab(url, this.authHeaders);
            const data = (await res.json()) as RawMR[];

            for (const mr of data) {
                const normalizedState = normalizeMRState(mr.state);
                const author: GitAuthor = {
                    name: mr.author?.name ?? '',
                    email: mr.author?.email ?? '',
                    username: mr.author?.username ?? '',
                };
                const reviewers: GitAuthor[] = (mr.reviewers ?? []).map((r) => ({
                    name: r.name,
                    email: r.email ?? '',
                    username: r.username,
                }));

                prs.push({
                    id: String(mr.iid),
                    title: mr.title,
                    author,
                    state: normalizedState,
                    createdAt: mr.created_at,
                    mergedAt: mr.merged_at,
                    closedAt: mr.closed_at,
                    updatedAt: mr.updated_at,
                    reviewers,
                    additions: 0,
                    deletions: 0,
                });
            }

            onProgress?.({done: prs.length, total: null});

            const nextPage = res.headers.get('x-next-page');
            if (!nextPage || nextPage === '') break;
            page = parseInt(nextPage, 10);
        }

        return prs;
    }

    async getReviewComments(repo: string, prId: string): Promise<GitReviewComment[]> {
        const notes: RawNote[] = [];
        let page = 1;

        while (true) {
            const url = `${this.baseUrl}/projects/${this.projectPath(repo)}/merge_requests/${prId}/notes?per_page=${PER_PAGE}&page=${page}`;
            const res = await fetchGitLab(url, this.authHeaders);
            const data = (await res.json()) as RawNote[];
            notes.push(...data);

            const nextPage = res.headers.get('x-next-page');
            if (!nextPage || nextPage === '') break;
            page = parseInt(nextPage, 10);
        }

        return notes
            .filter((n) => n.type === 'DiffNote' && !n.system)
            .map((n) => ({
                author: {
                    name: n.author?.name ?? '',
                    email: n.author?.email ?? '',
                    username: n.author?.username ?? '',
                },
                body: n.body,
                createdAt: n.created_at,
                prId,
            }));
    }

    async getPRReviews(repo: string, prId: string): Promise<GitPRReview[]> {
        const notes: RawNote[] = [];
        let page = 1;

        let hasNextPage = true;
        while (hasNextPage) {
            const url = `${this.baseUrl}/projects/${this.projectPath(repo)}/merge_requests/${prId}/notes?per_page=${PER_PAGE}&page=${page}&sort=asc&order_by=created_at`;
            const res = await fetchGitLab(url, this.authHeaders);
            const data = (await res.json()) as RawNote[];
            notes.push(...data);

            const nextPage = res.headers.get('x-next-page');
            hasNextPage = !!nextPage && nextPage !== '';
            if (hasNextPage) page = parseInt(nextPage!, 10);
        }

        // GitLab exposes review verdicts as system notes on the MR — there is
        // no structured verdict field in the notes API, so this matches the
        // system-note wording (verified against GitLab 16.x/17.x SaaS).
        // startsWith, not equality: GitLab occasionally appends detail to
        // system notes, and a wording extension must degrade to "still
        // matches", not to a silent zero-verdict undercount. Everything else
        // (comments are covered by getReviewComments, unapprovals don't add a
        // round) is skipped.
        const reviews: GitPRReview[] = [];
        for (const n of notes) {
            if (!n.system) continue;
            let state: GitReviewState;
            if (n.body.startsWith('approved this merge request')) {
                state = 'approved';
            } else if (n.body.startsWith('requested changes')) {
                state = 'changes_requested';
            } else {
                continue;
            }
            reviews.push({
                author: {
                    name: n.author?.name ?? '',
                    email: n.author?.email ?? '',
                    username: n.author?.username ?? '',
                },
                state,
                submittedAt: n.created_at,
                prId,
            });
        }

        return reviews;
    }

    async getCommitDiff(repo: string, commitSha: string): Promise<GitFileDiff[]> {
        const diffs: RawDiffEntry[] = [];
        let page = 1;

        while (true) {
            const url = `${this.baseUrl}/projects/${this.projectPath(repo)}/repository/commits/${commitSha}/diff?per_page=${PER_PAGE}&page=${page}`;
            const res = await fetchGitLab(url, this.authHeaders);
            const data = (await res.json()) as RawDiffEntry[];
            diffs.push(...data);

            const nextPage = res.headers.get('x-next-page');
            if (!nextPage || nextPage === '') break;
            page = parseInt(nextPage, 10);
        }

        return diffs.map((e) => {
            const {additions, deletions} = parseDiffHunks(e.diff ?? '');
            let status: string;
            if (e.new_file) {
                status = 'added';
            } else if (e.deleted_file) {
                status = 'deleted';
            } else if (e.renamed_file) {
                status = 'renamed';
            } else {
                status = 'modified';
            }
            return {
                path: e.new_path || e.old_path,
                additions,
                deletions,
                status,
            };
        });
    }
}
