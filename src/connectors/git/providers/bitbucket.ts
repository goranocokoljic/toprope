import type {
    CommitDiffstatCache,
    GitProvider,
    GitProviderType,
    GitRepo,
    GitCommit,
    GitPR,
    GitReviewComment,
    GitPRReview,
    GitFileDiff,
    GitAuthor,
    BitbucketProviderConfig,
    GitFetchProgressListener,
} from './types.js';
import {normalizeContainer} from './container.js';
import {loadDiffstats, resolveCommitDiffstat} from './diffstat.js';
import {
    GitProviderFetchError,
    MAX_RATE_LIMIT_RETRIES,
    MAX_SERVER_ERROR_RETRIES,
    PROBE_SERVER_ERROR_RETRIES,
    rateLimitDelayMs,
    rateLimitFallbackMs,
    serverErrorDelayMs,
    sleep,
} from './http-retry.js';

const BASE_URL = 'https://api.bitbucket.org/2.0';

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

function buildAuthHeader(auth: BitbucketProviderConfig['auth']): string {
    if (auth.type === 'app_password') {
        const encoded = Buffer.from(`${auth.username}:${auth.app_password}`).toString('base64');
        return `Basic ${encoded}`;
    }
    return `Bearer ${auth.token}`;
}

async function fetchBitbucket(
    url: string,
    headers: Record<string, string>,
    // Overridden only by checkAccess, which is an interactive probe rather than a data fetch
    // and must fail fast — see PROBE_SERVER_ERROR_RETRIES.
    maxTransientRetries: number = MAX_SERVER_ERROR_RETRIES,
): Promise<Response> {
    let attempt = 0;
    // Transient faults (5xx, transport) get their OWN, much longer budget than the 429
    // path — see http-retry.ts. Counted separately so a run does not spend its 5xx
    // allowance on rate limiting, or vice versa.
    let transientRetries = 0;

    // `for (;;)`: the two budgets above are counted separately, so no single loop guard can
    // express both, and every branch below either `continue`s or throws (#272).
    for (;;) {
        let res: Response;
        try {
            res = await fetch(url, {headers});
        } catch (err) {
            // A transport fault is the same outage as a 503, seen one layer down — same
            // budget, same backoff. Wrapped so the in-run repo retry (#272) can classify
            // it; the message is preserved verbatim.
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

        if (res.status >= 500) {
            if (transientRetries < maxTransientRetries) {
                await sleep(serverErrorDelayMs(transientRetries, res.headers.get('retry-after')));
                transientRetries++;
                continue;
            }
            throw new GitProviderFetchError(
                `Bitbucket API server error ${res.status}: ${url}`,
                res.status,
            );
        }

        if (!res.ok) {
            throw new GitProviderFetchError(`Bitbucket API error ${res.status}: ${url}`, res.status);
        }

        return res;
    }
}

// --- Raw API shapes ---

interface RawPagedResponse<T> {
    values: T[];
    next?: string;
}

interface RawRepo {
    uuid: string;
    slug: string;
    /** Bitbucket's human-readable repository name (distinct from the slug). */
    name?: string;
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

// One entry of GET /pullrequests/{id}/activity. Each entry carries exactly one
// key: `approval` (an approve event), `changes_requested` (a request-changes
// event), `comment`, or `update`. Only the first two are review verdicts;
// comments are already covered by getReviewComments.
interface RawActivityEntry {
    approval?: {date?: string; user: RawParticipant | null};
    changes_requested?: {date?: string; user: RawParticipant | null};
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
    private readonly diffstatCache?: CommitDiffstatCache;

    constructor(config: BitbucketProviderConfig, diffstatCache?: CommitDiffstatCache) {
        // Normalized (#266) — see the note in `github.ts`: the attribution key and the request
        // path must be the same spelling, and both derive from `normalizeContainer`.
        this.workspace = normalizeContainer(config.workspace);
        this.includeRepos = config.repos ?? [];
        this.excludeRepos = config.exclude_repos ?? [];
        this.authHeaders = {Authorization: buildAuthHeader(config.auth)};
        this.diffstatCache = diffstatCache;
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

    async checkAccess(): Promise<void> {
        await fetchBitbucket(
            `${BASE_URL}/repositories/${this.workspace}?role=member&pagelen=1`,
            this.authHeaders,
            // An interactive probe, not a data fetch — a human is waiting on it (#272).
            PROBE_SERVER_ERROR_RETRIES,
        );
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
                displayName: r.name,
                defaultBranch: r.mainbranch?.name ?? 'main',
                isArchived: false,
            }));
    }

    async getCommits(
        repo: string,
        since: string,
        until: string,
        onProgress?: GitFetchProgressListener,
    ): Promise<GitCommit[]> {
        const sinceDate = since ? new Date(since) : null;
        const untilDate = until ? new Date(until) : null;

        const collected: RawCommit[] = [];
        // Rows this walk has been HANDED, as opposed to the ones it keeps in `collected`.
        // The INTENDED reason the two differ is the in-memory `until` filter below, and
        // telling them apart is the whole of #276 — see `GitFetchProgress.scanned`. Note it
        // is not the only reason: a row whose `date` does not parse yields an Invalid Date
        // that compares false against BOTH bounds, so it is counted here and silently
        // dropped from `collected` (a pre-existing gap — that loss is not routed to the
        // #275 drop reporter). The divergence is therefore an upper bound on filtered rows,
        // not an exact count of them.
        let scanned = 0;
        let nextUrl: string | null =
            `${BASE_URL}/repositories/${this.workspace}/${repo}/commits?pagelen=100`;

        paging: while (nextUrl) {
            const res = await fetchBitbucket(nextUrl, this.authHeaders);
            const page = (await res.json()) as RawPagedResponse<RawCommit>;

            // Counted for the WHOLE page before the filter runs, so the number is the same
            // whether the loop below breaks out or not. On the page that trips the `since`
            // cutoff this over-counts: the rows after the break were returned but never
            // examined. That value is unobservable rather than harmless — `break paging`
            // skips this page's report (see below) and the next emission omits `scanned`
            // entirely, so no consumer can read it. Moving or adding a report after the
            // break would expose the over-count; count per row inside the loop if that
            // ever happens.
            scanned += page.values.length;

            for (const c of page.values) {
                const commitDate = new Date(c.date);
                if (sinceDate && commitDate < sinceDate) {
                    break paging;
                }
                if (!untilDate || commitDate <= untilDate) {
                    collected.push(c);
                }
            }

            // BOTH numbers, because on this provider they are genuinely different facts
            // (#276): `done` is rows retained, `scanned` is rows the endpoint handed over.
            // Bitbucket's commit endpoint takes no date bounds (see the URL above), so this
            // walk pages from HEAD and filters `until` in memory — on a backfill or
            // catch-up chunk whose `until` is in the past, every page before the window
            // retains nothing and `done` is pinned at 0 for the entire approach, which is
            // what made the label look hung. `scanned` advances by a page of rows each
            // time and is what moves there. On a normal forward run (`until` = now)
            // nothing is filtered and the two track each other, which the consumer renders
            // as the single `done` count it always did.
            //
            // Reported even when equal, deliberately: which of the two to show is the
            // label's decision, not this walk's (see `GitFetchProgress.scanned`).
            //
            // Deliberately NOT reported on the page that trips the `since` cutoff: the
            // `break paging` skips it, and the seed below would overwrite it in the same
            // synchronous block anyway, so restructuring the walk to reach it would buy
            // an emission no consumer can ever observe (#270 review OR-1).
            onProgress?.({done: collected.length, total: null, scanned});
            nextUrl = page.next ?? null;
        }

        // The per-commit diffstat fetch is the O(commits) cost of this call — report
        // each one so an observer's counter ticks instead of jumping 0 → N when the
        // whole loop returns. It is also the ONLY diffstat walk a sync makes per commit
        // (the walk is itself paged, so a very wide commit still costs >1 request):
        // `diffs` below hands this exact result to the caller so it does not re-walk the
        // same endpoint (#271).
        const commits: GitCommit[] = [];
        onProgress?.({done: 0, total: collected.length});
        // The whole repo's already-known diffstats, resolved in ONE batched query rather than
        // a point read per commit (#273). Empty map when no cache was supplied — every probe
        // path (doctor, test-connection) omits it, and behaves exactly as before.
        const cached = loadDiffstats(this.diffstatCache, repo, collected.map((c) => c.hash));
        for (const raw of collected) {
            const {name, email} = parseRawAuthor(raw.author.raw);
            const username = raw.author.user?.nickname ?? raw.author.user?.account_id ?? '';
            // Cache-or-fetch, including the 404-is-an-answer rule and the write-through, lives
            // in the shared helper — GitLab reaches its diff the same way and the two must not
            // drift on WHICH faults are cacheable (#273).
            const {entries: diffs, additions, deletions} = await resolveCommitDiffstat(
                this.diffstatCache,
                cached,
                repo,
                raw.hash,
                () => this.getCommitDiff(repo, raw.hash),
            );
            commits.push({
                sha: raw.hash,
                author: {name, email, username},
                date: raw.date,
                message: raw.message,
                additions,
                deletions,
                filesChanged: diffs.map((d) => d.path),
                // `[]`, never undefined — including via the helper's 404 branch, where `[]`
                // is the true answer. See `GitCommit.diffs` for why that matters (#271).
                diffs,
            });
            // Every iteration pushes, so the commit count IS the processed count —
            // no separate counter to keep in step.
            onProgress?.({done: commits.length, total: collected.length});
        }

        return commits;
    }

    async getPullRequests(
        repo: string,
        state: string,
        since: string,
        onProgress?: GitFetchProgressListener,
    ): Promise<GitPR[]> {
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
                    // Approximation: the PR list payload has no merge timestamp,
                    // so updated_on stands in. Post-merge activity bumps it, so
                    // consumers persisting a time-to-merge must keep the FIRST
                    // observed value (see upsertPRRecord in ../sync.ts).
                    mergedAt: normalizedState === 'merged' ? pr.updated_on : null,
                    closedAt: normalizedState === 'closed' ? pr.updated_on : null,
                    updatedAt: pr.updated_on,
                    reviewers: (pr.reviewers ?? []).map(participantToAuthor),
                    additions: 0,
                    deletions: 0,
                });
            }

            onProgress?.({done: prs.length, total: null});
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

    async getPRReviews(repo: string, prId: string): Promise<GitPRReview[]> {
        const entries = await this.fetchPaged<RawActivityEntry>(
            `${BASE_URL}/repositories/${this.workspace}/${repo}/pullrequests/${prId}/activity?pagelen=50`,
        );

        const reviews: GitPRReview[] = [];
        for (const entry of entries) {
            // Entries lacking a date can't be ordered — skip rather than crash
            // the whole verdict fetch for the PR.
            if (entry.approval?.date) {
                reviews.push({
                    author: participantToAuthor(entry.approval.user),
                    state: 'approved',
                    submittedAt: entry.approval.date,
                    prId,
                });
            } else if (entry.changes_requested?.date) {
                reviews.push({
                    author: participantToAuthor(entry.changes_requested.user),
                    state: 'changes_requested',
                    submittedAt: entry.changes_requested.date,
                    prId,
                });
            }
            // comment/update entries are not review verdicts — skip.
        }

        // The activity feed is newest-first; return oldest-first to match the
        // other providers' submission order. Numeric compare, not lexicographic:
        // Bitbucket timestamps carry offsets (+00:00-style).
        return reviews.sort(
            (a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt),
        );
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
