import type {
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
    GitLabProviderConfig,
    GitFetchProgressListener,
    GitCommitDropListener,
    GitProviderClientOptions,
} from './types.js';
import {commitDropReason, isAttributableDate} from './commit-date.js';
import {normalizeContainer} from './container.js';
import {loadDiffstats, resolveCommitDiffstat} from './diffstat.js';
import type {GitRequestPolicy} from './http-retry.js';
import {SYNC_REQUEST_POLICY, fetchWithGitRetry} from './http-retry.js';

const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4';
const PER_PAGE = 100;

function buildAuthHeaders(auth: GitLabProviderConfig['auth']): Record<string, string> {
    if (auth.type === 'personal_access_token') {
        return {'PRIVATE-TOKEN': auth.token};
    }
    if (auth.type === 'job_token') {
        return {'JOB-TOKEN': auth.token};
    }
    return {Authorization: `Bearer ${auth.token}`};
}

/**
 * GitLab's binding of the shared retry loop (#284). The loop itself — including the
 * `ratelimit-reset` handling this provider needs — lives in `http-retry.ts`; only the label
 * is ours.
 */
function fetchGitLab(
    url: string,
    headers: Record<string, string>,
    policy: GitRequestPolicy,
): Promise<Response> {
    return fetchWithGitRetry(url, headers, 'GitLab', policy);
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
    private readonly diffstatCache?: CommitDiffstatCache;
    private readonly policy: GitRequestPolicy;

    constructor(config: GitLabProviderConfig, options: GitProviderClientOptions = {}) {
        // Normalized (#266) — see the note in `github.ts`: the attribution key and the request
        // path must be the same spelling, and both derive from `normalizeContainer`.
        this.group = normalizeContainer(config.group);
        // config.url is the base host (e.g. "https://gitlab.example.com"); always append /api/v4
        this.baseUrl = (config.url ?? DEFAULT_BASE_URL).replace(/\/$/, '').replace(/\/api\/v4$/, '') + '/api/v4';
        this.authHeaders = buildAuthHeaders(config.auth);
        this.includeRepos = config.repos ?? [];
        this.includeSubgroups = config.include_subgroups ?? false;
        this.diffstatCache = options.diffstatCache;
        this.policy = options.policy ?? SYNC_REQUEST_POLICY;
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
        // The client's own policy carries the caller's intent now (#283) — see `github.ts`.
        await fetchGitLab(
            `${this.baseUrl}/groups/${encodeURIComponent(this.group)}/projects?per_page=1`,
            this.authHeaders,
            this.policy,
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
            const res = await fetchGitLab(`${baseUrl}&page=${page}`, this.authHeaders, this.policy);
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
        onDrop?: GitCommitDropListener,
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
            const res = await fetchGitLab(url, this.authHeaders, this.policy);
            const data = (await res.json()) as RawCommit[];
            raw.push(...data);
            // One report per page — the commit total is unknown until the last
            // page, so a running seen-so-far count is all that is honest (#270).
            onProgress?.({done: raw.length, total: null});

            const nextPage = res.headers.get('x-next-page');
            hasNextPage = !!nextPage && nextPage !== '';
            if (hasNextPage) page = parseInt(nextPage!, 10);
        }

        // PIN THE DAY SHAPE HERE (#290), before any per-commit work. Until this gate existed
        // `authored_date` was pushed through unchecked, so a commit GitLab dates with an ISO
        // expanded year reached `raw_author_daily`'s validator, which THROWS — inside the run's
        // single all-providers write transaction, rolling back every OTHER provider's window too,
        // identically, on every subsequent run. The predicate is the shared one, so this gate and
        // the store's refusal can never disagree about which days are keyable.
        //
        // A drop, not a throw: the response is well-formed and re-fetching yields the identical
        // unusable date forever, so holding the provider's cursor would brick it rather than heal
        // it (see {@link GitCommitDrop}). Partitioned BEFORE the diff fan-out rather than skipped
        // inside it, so a dropped commit costs neither a diffstat lookup nor a diff request — and
        // so `total` below counts the work actually about to happen and `done` still reaches it.
        const usable: RawCommit[] = [];
        for (const c of raw) {
            if (isAttributableDate(c.authored_date)) {
                usable.push(c);
                continue;
            }
            onDrop?.({sha: c.id, reason: commitDropReason(c.authored_date)});
        }

        // The per-commit diff fetch is the O(commits) cost of this call — report each
        // one so an observer's counter ticks during it, not only once it returns. It is
        // also the ONLY diff walk a sync makes per commit (the walk is itself paged, so a
        // very wide commit still costs >1 request): `diffs` below hands this exact result
        // to the caller so it does not re-walk the same endpoint (#271).
        const commits: GitCommit[] = [];
        onProgress?.({done: 0, total: usable.length});
        // The whole repo's already-known diffs, resolved in ONE batched query rather than a
        // point read per commit (#273). Empty map when no cache was supplied — every probe
        // path (doctor, test-connection) omits it, and behaves exactly as before.
        const cached = await loadDiffstats(this.diffstatCache, repo, usable.map((c) => c.id));
        for (const c of usable) {
            // Cache-or-fetch, including the 404-is-an-answer rule (GitLab 404s the diff of an
            // initial commit) and the write-through, lives in the shared helper — Bitbucket
            // reaches its diffstat the same way and the two must not drift on WHICH faults
            // are cacheable (#273).
            const {entries: diffs, additions, deletions} = await resolveCommitDiffstat(
                this.diffstatCache,
                cached,
                repo,
                c.id,
                () => this.getCommitDiff(repo, c.id),
            );

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
                additions,
                deletions,
                // `[]`, never undefined — including via the 404 branch above, where `[]`
                // is the true answer. See `GitCommit.diffs` for why that matters (#271).
                diffs,
            });
            // Every iteration pushes, so the commit count IS the processed count —
            // no separate counter to keep in step.
            onProgress?.({done: commits.length, total: usable.length});
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
            const res = await fetchGitLab(url, this.authHeaders, this.policy);
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
            const res = await fetchGitLab(url, this.authHeaders, this.policy);
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
            const res = await fetchGitLab(url, this.authHeaders, this.policy);
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
            const res = await fetchGitLab(url, this.authHeaders, this.policy);
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
