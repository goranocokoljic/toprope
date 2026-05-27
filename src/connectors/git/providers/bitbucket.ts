import type {
    GitProvider,
    GitProviderType,
    GitRepo,
    GitCommit,
    GitPR,
    GitReviewComment,
    GitFileDiff,
    GitAuthor,
    BitbucketProviderConfig,
} from './types.js';

const BASE_URL = 'https://api.bitbucket.org/2.0';
const MAX_RETRIES = 3;

function parseRawAuthor(raw: string): {name: string; email: string} {
    const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
    if (match) {
        return {name: match[1].trim(), email: match[2].trim()};
    }
    return {name: raw.trim(), email: ''};
}

function globMatch(pattern: string, str: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`, 'i').test(str);
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAuthHeader(auth: BitbucketProviderConfig['auth']): string {
    if (auth.type === 'app_password') {
        const encoded = Buffer.from(`${auth.username}:${auth.app_password}`).toString('base64');
        return `Basic ${encoded}`;
    }
    return `Bearer ${auth.token}`;
}

async function fetchBitbucket(url: string, headers: Record<string, string>): Promise<Response> {
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
            throw new Error(`Bitbucket API server error ${res.status}: ${url}`);
        }

        if (!res.ok) {
            throw new Error(`Bitbucket API error ${res.status}: ${url}`);
        }

        return res;
    }

    throw new Error(`Request failed after ${MAX_RETRIES} retries: ${url}`);
}

// --- Raw API shapes ---

interface RawPagedResponse<T> {
    values: T[];
    next?: string;
}

interface RawRepo {
    uuid: string;
    slug: string;
    full_name: string;
    mainbranch?: {name: string};
    scm: string;
}

interface RawCommitAuthor {
    raw: string;
    user?: {nickname?: string; account_id?: string};
}

interface RawCommit {
    hash: string;
    author: RawCommitAuthor;
    date: string;
    message: string;
}

interface RawDiffstatEntry {
    status: string;
    lines_added: number;
    lines_removed: number;
    new: {path: string} | null;
    old: {path: string} | null;
}

interface RawParticipant {
    nickname?: string;
    account_id?: string;
    display_name?: string;
}

interface RawPR {
    id: number;
    title: string;
    author: RawParticipant | null;
    state: string;
    created_on: string;
    updated_on: string;
    reviewers?: RawParticipant[];
}

interface RawComment {
    content: {raw: string};
    author: RawParticipant | null;
    created_on: string;
    inline?: {from?: number | null; to?: number | null; path?: string} | null;
}

function normalizePRState(bbState: string): string {
    switch (bbState) {
        case 'MERGED':
            return 'merged';
        case 'OPEN':
            return 'open';
        case 'DECLINED':
        case 'SUPERSEDED':
            return 'closed';
        default:
            return bbState.toLowerCase();
    }
}

function bbStatesFromNormalized(state: string): string[] {
    switch (state) {
        case 'open':
            return ['OPEN'];
        case 'merged':
            return ['MERGED'];
        case 'closed':
            return ['DECLINED', 'SUPERSEDED'];
        default:
            return ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];
    }
}

function participantToAuthor(p: RawParticipant | null): GitAuthor {
    return {
        name: p?.display_name ?? '',
        email: '',
        username: p?.nickname ?? p?.account_id ?? '',
    };
}

export class BitbucketProvider implements GitProvider {
    readonly name: GitProviderType = 'bitbucket';
    private readonly workspace: string;
    private readonly authHeaders: Record<string, string>;
    private readonly includeRepos: string[];
    private readonly excludeRepos: string[];

    constructor(config: BitbucketProviderConfig) {
        this.workspace = config.workspace;
        this.includeRepos = config.repos ?? [];
        this.excludeRepos = config.exclude_repos ?? [];
        this.authHeaders = {Authorization: buildAuthHeader(config.auth)};
    }

    private shouldInclude(repoSlug: string): boolean {
        if (this.includeRepos.length > 0) {
            const included = this.includeRepos.some(
                (p) => p === repoSlug || globMatch(p, repoSlug),
            );
            if (!included) return false;
        }
        return !this.excludeRepos.some((p) => p === repoSlug || globMatch(p, repoSlug));
    }

    private async fetchPaged<T>(startUrl: string): Promise<T[]> {
        const results: T[] = [];
        let nextUrl: string | null = startUrl;

        while (nextUrl) {
            const res = await fetchBitbucket(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawPagedResponse<T>;
            results.push(...page.values);
            nextUrl = page.next ?? null;
        }

        return results;
    }

    async listRepos(): Promise<GitRepo[]> {
        const repos = await this.fetchPaged<RawRepo>(
            `${BASE_URL}/repositories/${this.workspace}?role=member&pagelen=100`,
        );

        return repos
            .filter((r) => r.scm === 'git' && this.shouldInclude(r.slug))
            .map((r) => ({
                id: r.uuid,
                name: r.slug,
                fullName: r.full_name,
                defaultBranch: r.mainbranch?.name ?? 'main',
                isArchived: false,
            }));
    }

    async getCommits(repo: string, since: string, until: string): Promise<GitCommit[]> {
        const sinceDate = since ? new Date(since) : null;
        const untilDate = until ? new Date(until) : null;

        const collected: RawCommit[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/repositories/${this.workspace}/${repo}/commits?pagelen=100`;

        paging: while (nextUrl) {
            const res = await fetchBitbucket(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawPagedResponse<RawCommit>;

            for (const c of page.values) {
                const commitDate = new Date(c.date);
                if (sinceDate && commitDate < sinceDate) {
                    break paging;
                }
                if (!untilDate || commitDate <= untilDate) {
                    collected.push(c);
                }
            }

            nextUrl = page.next ?? null;
        }

        const commits: GitCommit[] = [];
        for (const raw of collected) {
            const {name, email} = parseRawAuthor(raw.author.raw);
            const username = raw.author.user?.nickname ?? raw.author.user?.account_id ?? '';
            let diffs: GitFileDiff[] = [];
            try {
                diffs = await this.getCommitDiff(repo, raw.hash);
            } catch (err) {
                // 404 means diffstat absent for this commit (e.g. merge commits) — record with zero stats
                // Re-throw anything else (auth failure, server error) so systemic problems surface
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.includes(' 404:')) throw err;
            }
            commits.push({
                sha: raw.hash,
                author: {name, email, username},
                date: raw.date,
                message: raw.message,
                additions: diffs.reduce((s, d) => s + d.additions, 0),
                deletions: diffs.reduce((s, d) => s + d.deletions, 0),
                filesChanged: diffs.map((d) => d.path),
            });
        }

        return commits;
    }

    async getPullRequests(repo: string, state: string, since: string): Promise<GitPR[]> {
        const bbStates = bbStatesFromNormalized(state);
        const stateParams = bbStates.map((s) => `state=${encodeURIComponent(s)}`).join('&');
        const sinceDate = since ? new Date(since) : null;
        const prs: GitPR[] = [];

        let nextUrl: string | null =
            `${BASE_URL}/repositories/${this.workspace}/${repo}/pullrequests?pagelen=50&sort=-updated_on&${stateParams}`;

        while (nextUrl) {
            const res = await fetchBitbucket(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawPagedResponse<RawPR>;

            let reachedSince = false;
            for (const pr of page.values) {
                if (sinceDate && new Date(pr.updated_on) < sinceDate) {
                    reachedSince = true;
                    break;
                }

                const normalizedState = normalizePRState(pr.state);
                prs.push({
                    id: String(pr.id),
                    title: pr.title,
                    author: participantToAuthor(pr.author),
                    state: normalizedState,
                    createdAt: pr.created_on,
                    mergedAt: normalizedState === 'merged' ? pr.updated_on : null,
                    closedAt: normalizedState === 'closed' ? pr.updated_on : null,
                    reviewers: (pr.reviewers ?? []).map(participantToAuthor),
                    additions: 0,
                    deletions: 0,
                });
            }

            nextUrl = reachedSince ? null : (page.next ?? null);
        }

        return prs;
    }

    async getReviewComments(repo: string, prId: string): Promise<GitReviewComment[]> {
        const rawComments = await this.fetchPaged<RawComment>(
            `${BASE_URL}/repositories/${this.workspace}/${repo}/pullrequests/${prId}/comments?pagelen=100`,
        );

        return rawComments
            .filter((c) => c.inline != null)
            .map((c) => ({
                author: participantToAuthor(c.author),
                body: c.content.raw,
                createdAt: c.created_on,
                prId,
            }));
    }

    async getCommitDiff(repo: string, commitSha: string): Promise<GitFileDiff[]> {
        const entries = await this.fetchPaged<RawDiffstatEntry>(
            `${BASE_URL}/repositories/${this.workspace}/${repo}/diffstat/${commitSha}?pagelen=500`,
        );

        return entries.map((e) => ({
            path: e.new?.path ?? e.old?.path ?? '',
            additions: e.lines_added,
            deletions: e.lines_removed,
            status: e.status,
        }));
    }
}
