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
    GitHubProviderConfig,
    GitFetchProgressListener,
    GitCommitDropListener,
    GitProviderClientOptions,
} from './types.js';
import {NO_AUTHOR_DATE_DROP_REASON, UNATTRIBUTABLE_DATE_DROP_REASON} from './types.js';
import {isUtcDay} from '../../../aggregation/dates.js';
import {normalizeContainer} from './container.js';
import {isCommitCount, loadDiffstats} from './diffstat.js';
import type {GitRequestPolicy} from './http-retry.js';
import {
    GitProviderFetchError,
    SYNC_REQUEST_POLICY,
    assertRunTimeRemaining,
    parseEpochResetMs,
    rateLimitDelayMs,
    rateLimitFallbackMs,
    requestTimeout,
    serverErrorDelayMs,
    sleepWithinRun,
    usableResetMs,
} from './http-retry.js';

const BASE_URL = 'https://api.github.com';
// Pause proactively when remaining requests drops below this threshold
const RATE_LIMIT_PAUSE_THRESHOLD = 100;

/**
 * Can this author date be attributed to a day by the pipeline downstream (#275)?
 *
 * WHY IT IS PINNED HERE. The day key is derived by a bare `isoDate.slice(0, 10)`
 * (`analyzer.ts`, `churn.ts`), and the write boundary then hard-rejects anything that is not
 * a `YYYY-MM-DD` day — by THROWING, inside the run's single all-providers write transaction,
 * which rolls back every provider's window and re-throws identically on every subsequent run.
 * So an ISO 8601 expanded year (`+033658-09-27T…`, which `git commit --date=@999999999999`
 * produces) has to be caught HERE, where it costs one reported commit, rather than one frame
 * down where it bricks the whole git connector. Same hazard class as #233's expanded-year
 * watermark, and the same fix: pin the shape at the boundary.
 *
 * WHAT IT PINS, exactly — it validates the DAY KEY the pipeline will actually derive, using
 * the same predicate the store validates with (`isUtcDay`, whose regex is byte-identical to
 * `raw-author-daily.ts`'s `UTC_DAY_RE`). That agreement is the point, so this is deliberately
 * NOT stricter than the store:
 *   - `typeof` first, because `.test()` COERCES — an array from an odd JSON body would
 *     stringify into a matching value and sail through.
 *   - `isUtcDay` on the sliced day, so this asks the SAME question the store asks.
 *   - `Date.parse` finite, because the shape check alone accepts `9999-99-99T00:00:00Z`. This
 *     one conjunct IS stricter than the store, on purpose: `analyzer.ts` orders commits by
 *     `new Date(c.date).getTime()`, and a NaN there makes the comparator non-total — the
 *     graduated determinism rule. A day the store accepts is worth nothing if the sort that
 *     reads it is undefined.
 * Calendar validity (`2024-02-30`) and UTC-ness (an `-05:00` offset attributes to the
 * offset-local day) are NOT pinned, because the store accepts both: rejecting them here would
 * DROP commits the store would have stored, trading a small mis-attribution for a real loss.
 * A bare day with no time (`2024-01-15`) is accepted for the same reason — no reader in this
 * pipeline consumes the time component (every one of them is `slice(0, 10)` or a parsed
 * instant), so rejecting it would lose a commit the store would have keyed correctly.
 * Both remaining gaps are pre-existing and shared by all three providers; fixing them belongs
 * at the write boundary, for every provider at once.
 */
function isAttributableDate(date: string | undefined): boolean {
    return (
        typeof date === 'string' &&
        isUtcDay(date.slice(0, 10)) &&
        Number.isFinite(Date.parse(date))
    );
}

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

/**
 * GitHub's own retry loop — the one the #284 collapse deliberately left out.
 *
 * It stays separate because of two branches its siblings do not have: the 403 primary/secondary
 * rate limit below, and the pre-emptive `x-ratelimit-remaining` pause after a 200. Folding those
 * into the shared loop would mean adding hooks for cases only one caller reaches.
 *
 * THE COST OF THAT, stated here rather than left to be discovered: the transport-fault catch, the
 * 429 branch, the 5xx branch and the `!res.ok` throw below all restate the same policy as
 * {@link fetchWithGitRetry}, so a change to any of them must be made in both places. This file is
 * the copy that gets forgotten, which is why the reset rule the 429 and 403 branches share with
 * the other loop lives in one place — {@link usableResetMs} — rather than inline at each site.
 *
 * The only genuine divergence is the header NAME: GitHub spells its reset `x-ratelimit-reset`,
 * GitLab the un-prefixed `ratelimit-reset`. The 403 branch below is the real extra surface.
 *
 * WHAT GUARDS THIS, precisely — `tests/connectors/git/providers/request-policy.test.ts` is
 * `describe.each` over all three provider types, so it catches a change to branch PRESENCE,
 * retry BUDGETS, deadline handling and message shape that lands only in the shared loop. It does
 * not by itself catch a change to the backoff SCHEDULE; the no-`retry-after` 429 case added
 * there in #284 covers the rate-limit fallback rungs specifically. Do not read the table as
 * proving more than that.
 */
async function fetchGitHub(
    url: string,
    headers: Record<string, string>,
    // The retry budgets and run deadline the CLIENT was built with (#283) — an interactive
    // probe/listing takes INTERACTIVE_REQUEST_POLICY, a sync fetch the run's own. Carried on
    // the client rather than overridden per call, so no call site can forget it. REQUIRED:
    // this function is module-private and every call site passes `this.policy`, so a default
    // would be defensive code for a case that cannot occur.
    policy: GitRequestPolicy,
): Promise<Response> {
    let attempt = 0;
    // Transient faults (5xx, transport) get their own, much longer budget than the rate-limit
    // paths below — see http-retry.ts. Counted separately so one class of fault cannot spend
    // the other's allowance.
    let transientRetries = 0;

    // `for (;;)`: the two budgets above are counted separately, so no single loop guard can
    // express both, and every branch below either `continue`s or throws (#272).
    for (;;) {
        // Per ATTEMPT, not only before a pause: a run can exhaust its wall clock doing nothing
        // but promptly-answered work (#283).
        assertRunTimeRemaining(policy, url);
        let res: Response;
        // Disarmed in `finally`, the moment `fetch` settles either way — the signal bounds the
        // RESPONSE, never the body the caller reads afterwards. See GIT_REQUEST_TIMEOUT_MS: a
        // signal left armed erases that body, and the resulting rejection escapes this `try`
        // unclassified. The pre-emptive pause below makes the window certain, not theoretical.
        const timeout = requestTimeout();
        try {
            res = await fetch(url, {headers, signal: timeout.signal});
        } catch (err) {
            // A transport fault is the same outage as a 503, seen one layer down — same budget,
            // same backoff. Wrapped so the in-run repo retry (#272) can classify it; the message
            // is preserved verbatim. A GIT_REQUEST_TIMEOUT_MS abort lands here too, deliberately:
            // a stalled socket is that same outage with no response at all (#283).
            // Disarmed BEFORE the backoff, not just by the `finally`: the pause is minutes
            // long, and leaving the timer armed across it would make "cleared the moment
            // `fetch` settles" untrue on exactly the path most likely to drift (#283 review).
            timeout.clear();
            if (transientRetries < policy.retries.transient) {
                await sleepWithinRun(policy, serverErrorDelayMs(transientRetries, null), url);
                transientRetries++;
                continue;
            }
            throw new GitProviderFetchError(
                err instanceof Error ? err.message : String(err),
                null,
                {cause: err},
            );
        } finally {
            // Idempotent — `clearTimeout` on an already-cleared handle is a no-op — so the
            // catch path clearing early and this clearing again is safe, and this stays the
            // one guarantee that no path leaves a signal armed over an unread body.
            timeout.clear();
        }

        if (res.status === 429) {
            // GitHub signals the PRIMARY rate limit as either 403 or 429, and on a 429 the reset
            // instant is the only thing that says when the wall comes down — `Retry-After` is a
            // delta GitHub sends for the secondary/abuse limit, not for this one. Reading it
            // here rather than guessing 60s/120s/180s into a window that can be most of an hour:
            // four requests inside six minutes, then `Rate limit exceeded after 3 retries`, is a
            // repo failure the run cannot recover from (a 429 is not repo-retryable, by design —
            // see `isRetryableGitFetchError`), so #231 discards the run and holds the cursor.
            // `Retry-After` still wins where present, exactly as in the shared loop.
            const resetMs = usableResetMs(res.headers.get('x-ratelimit-reset'));
            if (attempt < policy.retries.rateLimit) {
                await sleepWithinRun(
                    policy,
                    rateLimitDelayMs(
                        res.headers.get('retry-after'),
                        resetMs ?? rateLimitFallbackMs(attempt),
                    ),
                    url,
                );
                attempt++;
                continue;
            }
            throw new GitProviderFetchError(
                `Rate limit exceeded after ${policy.retries.rateLimit} retries: ${url}`,
                429,
            );
        }

        if (res.status === 403) {
            const remaining = res.headers.get('x-ratelimit-remaining');
            const resetHeader = res.headers.get('x-ratelimit-reset');
            // TWO questions about ONE header, and only this site asks both. CLASSIFICATION —
            // "was the header there at all", which decides whether this 403 is the primary limit
            // — must stay `parseEpochResetMs`, because an elapsed reset is still proof of a
            // primary limit and demoting it to the secondary branch would drop the retry
            // entirely. DELAY is the different question `usableResetMs` answers (#284).
            const resetMs = parseEpochResetMs(resetHeader);
            const schedulableResetMs = usableResetMs(resetHeader);
            const retryAfter403 = res.headers.get('retry-after');
            // Primary rate limit: x-ratelimit-remaining=0 with a reset time. `+ 1_000` so the
            // retry lands just AFTER the reset instant rather than exactly on it.
            if (remaining === '0' && resetMs !== null) {
                if (attempt < policy.retries.rateLimit) {
                    await sleepWithinRun(
                        policy,
                        rateLimitDelayMs(
                            null,
                            schedulableResetMs !== null
                                ? schedulableResetMs + 1_000
                                : rateLimitFallbackMs(attempt),
                        ),
                        url,
                    );
                    attempt++;
                    continue;
                }
            // Secondary rate limit (abuse detection): Retry-After present, no ratelimit headers
            } else if (retryAfter403 !== null) {
                if (attempt < policy.retries.rateLimit) {
                    await sleepWithinRun(
                        policy,
                        rateLimitDelayMs(retryAfter403, rateLimitFallbackMs(attempt)),
                        url,
                    );
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
            if (transientRetries < policy.retries.transient) {
                await sleepWithinRun(
                    policy,
                    serverErrorDelayMs(transientRetries, res.headers.get('retry-after')),
                    url,
                );
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
        //
        // Gated on the rate-limit budget rather than on the retry counter, because this is
        // neither a retry nor a failure — it fires after a 200 (#283). Without the gate an
        // interactive listing whose zero retry budgets close every OTHER sleep would still
        // sleep to the reset instant here, up to MAX_RATE_LIMIT_DELAY_MS, inside the one
        // request a human is waiting on. A caller that has forbidden waiting out a rate limit
        // has equally forbidden waiting to avoid one.
        // `usableResetMs` and nothing else here, unlike the 403 branch: this pause has no
        // classification job, so an elapsed reset just means there is nothing left to wait out
        // and skipping is the right answer (#284).
        const remaining = res.headers.get('x-ratelimit-remaining');
        const resetMs = usableResetMs(res.headers.get('x-ratelimit-reset'));
        if (
            policy.retries.rateLimit > 0 &&
            remaining !== null &&
            parseInt(remaining, 10) < RATE_LIMIT_PAUSE_THRESHOLD &&
            resetMs !== null
        ) {
            await sleepWithinRun(policy, rateLimitDelayMs(null, resetMs + 1_000), url);
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
    author: {login: string} | null;
}

interface RawCommitDetail {
    sha: string;
    /**
     * OPTIONAL for the same reason `RawCommitListItem.commit` is, and it must stay in step with
     * it: the two endpoints return the identical embedded object, so a shape the list can omit
     * the detail can omit too. Dereferencing it unguarded would raise a TypeError out of
     * `getCommits`, which #231 reads as an incompletely-covered window — the whole provider's
     * run discarded by one malformed commit.
     */
    commit?: {
        author: {name: string; email: string; date: string} | null;
        message: string;
    };
    author: {login: string} | null;
    // Both OPTIONAL, which is why every reader here guards. Typed to match what the readers
    // actually assume, so nobody writes `detail.files.map(...)` on the strength of the
    // declaration.
    //
    // The declaration follows GitHub's own: neither key is among the endpoint's required
    // response properties, and no condition for omitting them is documented (#288 — see the
    // guard in `getCommits` for the evidence and what the codebase does about it). So this is
    // "the contract permits absence", not the stronger "GitHub is known to omit them"; an
    // absent `stats` is therefore not treated as a malformed body, but the churn it would have
    // carried is treated as UNKNOWN rather than zero.
    //
    // `| null` on `stats` is NOT decoration. This is an unchecked cast over a network body, and
    // JSON has two idiomatic spellings of "no value" — an absent key and an explicit `null`.
    // #288 makes this field decide whether a zero gets memoized into a table with no
    // invalidation, so a declaration admitting only one spelling would invite an
    // `=== undefined` guard that the other spelling walks straight past. The reader below does
    // not test either spelling; it tests for a NUMBER (see `observedStats`).
    stats?: {additions: number; deletions: number; total: number} | null;
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
    private readonly policy: GitRequestPolicy;

    constructor(config: GitHubProviderConfig, options: GitProviderClientOptions = {}) {
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
        this.diffstatCache = options.diffstatCache;
        this.policy = options.policy ?? SYNC_REQUEST_POLICY;
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
        // No per-call budget override any more (#283): the client's own policy already carries
        // the caller's intent, and every path that reaches `checkAccess` builds an
        // INTERACTIVE_REQUEST_POLICY client — which now also closes the rate-limit branches a
        // transient-only override left open.
        await fetchGitHub(`${BASE_URL}/orgs/${this.org}/repos?per_page=1`, this.authHeaders, this.policy);
    }

    async listRepos(): Promise<GitRepo[]> {
        const repos: GitRepo[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/orgs/${this.org}/repos?per_page=100&sort=pushed`;

        while (nextUrl) {
            const res = await fetchGitHub(nextUrl, this.authHeaders, this.policy);
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
        onDrop?: GitCommitDropListener,
    ): Promise<GitCommit[]> {
        const params = new URLSearchParams({per_page: '100'});
        if (since) params.set('since', since);
        if (until) params.set('until', until);

        const summaries: RawCommitListItem[] = [];
        let nextUrl: string | null =
            `${BASE_URL}/repos/${this.org}/${repo}/commits?${params.toString()}`;

        while (nextUrl) {
            const res = await fetchGitHub(nextUrl, this.authHeaders, this.policy);
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
        // over the one lossy branch below (a commit with no usable author date on either
        // copy — a data-shape problem no retry can fix, now reported through `onDrop`
        // rather than dropped silently: #275). It no longer advances over a FAILED detail
        // fetch: that now throws (#272, review cycle 3), see the note below.
        let processed = 0;
        onProgress?.({done: 0, total: summaries.length});
        // The whole repo's already-known commit stats, resolved in ONE batched query rather
        // than a point read per commit (#273). Empty map when no cache was supplied — every
        // probe path (doctor, test-connection) omits it, and behaves exactly as before.
        const cached = await loadDiffstats(this.diffstatCache, repo, summaries.map((s) => s.sha));
        for (const summary of summaries) {
            try {
                // A HIT PRODUCES EXACTLY WHAT A FETCH PRODUCES, in both directions, which is
                // what stops the cache DROPPING a commit the un-cached path keeps or ADDING
                // one it drops. The gate is `isAttributableDate`, the SAME predicate the
                // un-cached path below decides on (#275) — not a bare truthiness check, or a
                // list row with an unusable date would be served from the cache while a cold
                // run reported it dropped. Both directions then hold:
                //   - hit here → the un-cached path reads this same list row as its fallback,
                //     so it keeps the commit too;
                //   - no usable date on the list row → no lookup, straight to the detail
                //     fetch, and the commit is kept iff the DETAIL carries a usable one. The
                //     only cost is one re-request per run for a shape anomaly no retry fixes.
                const listCommit = summary.commit;
                if (listCommit?.author && isAttributableDate(listCommit.author.date)) {
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
                            diffs: hit.entries,
                            // No `churnObserved: false` here, and that is a claim about what a
                            // memo can contain, not an oversight: since #288 the miss path writes
                            // a row ONLY for a commit whose `stats` it actually read, so every
                            // row this can hit is an observation. The bound is rows written
                            // BEFORE #288 — indistinguishable from an observed zero and served
                            // here forever. `toprope git cache clear` is the operator surface for
                            // discarding them; see the guard on the miss path.
                        });
                        continue;
                    }
                }

                const detailRes = await fetchGitHub(
                    `${BASE_URL}/repos/${this.org}/${repo}/commits/${summary.sha}`,
                    this.authHeaders,
                    this.policy,
                );
                const detail = (await detailRes.json()) as RawCommitDetail;

                // This detail response IS what `getCommitDiff` would re-request for the
                // same sha, so carry its file list out on `diffs` and let the caller skip
                // that second identical request (#271). `[]`, never undefined — a detail
                // with no `files` means "no files". See `GitCommit.diffs`.
                //
                // Stays `[]` even on the #288 degraded path (no `stats`), deliberately. `[]`
                // means "no further request will help", and here that is literally true: the
                // sync's fallback is `getCommitDiff`, which re-requests THIS endpoint for THIS
                // sha and would map the same absent `files` to the same `[]`. Handing back
                // `undefined` instead would buy one duplicate request per degraded commit per
                // run and file the provider under DIFFS_NOT_SUPPLIED — an advisory that
                // diagnoses "this implementation does not honour the GitCommit.diffs contract",
                // which is the wrong story. The churn loss is reported on its own channel.
                const diffs = toFileDiffs(detail);
                // THE ONE PLACE THIS RESPONSE'S CHURN IS CLASSIFIED (#288). Resolved once into a
                // local so the malformed-body guard, the two totals, the memo gate and the
                // `churnObserved` flag are all decided by the SAME value: `detail.stats` is a
                // property of an unvalidated body, and four separate reads are four chances for
                // a later edit to memoize a zero another reader already called unknown.
                //
                // A POSITIVE SHAPE TEST, not `=== undefined`. The premise of this whole issue is
                // that GitHub's contract does not say how — or whether — it omits `stats`, so
                // testing for one spelling of absence is exactly the wrong shape of guard: an
                // explicit `"stats": null`, a `{}`, or a `{additions: "40"}` would all satisfy
                // `!== undefined`, take the memoize branch, and write a fabricated `0`/`0` into a
                // table with no invalidation — the precise outcome this issue exists to prevent,
                // reintroduced through the spellings the guard did not enumerate. Testing for a
                // NUMBER is total over every shape a body can take, and it fails in the safe
                // direction: an unrecognized shape becomes "unknown churn", which is re-askable
                // and reported, rather than a permanent silent zero.
                //
                // `isCommitCount`, the SHARED predicate, not a local `Number.isInteger`. The two
                // boundaries downstream ask the identical question about this identical value
                // and both enforce a lower bound: `diffstat-cache.ts` refuses to persist a row
                // whose counts are not counts (silently, and deliberately not as a fault), and
                // `raw-author-daily.ts` THROWS on one, inside the run's single all-providers
                // write transaction — rolling back every provider's window, deterministically,
                // on every later run. A value this line waved through but they refuse would be
                // reported to the operator as OBSERVED while being invisible on both of their
                // channels, which is the failure this classification exists to prevent. One
                // predicate is what makes the classification protect them.
                const rawStats = detail.stats;
                const observedStats =
                    rawStats !== undefined &&
                    rawStats !== null &&
                    isCommitCount(rawStats.additions) &&
                    isCommitCount(rawStats.deletions)
                        ? rawStats
                        : null;
                // The classification itself, named once and read by the memo gate and the
                // returned row alike — `observedStats !== null` recomputed at each site is two
                // chances to drift, which is the same argument that put `rawStats` in a local.
                const churnObserved = observedStats !== null;
                // NOT summed from `diffs`: GitHub caps `files` at 300 per commit while
                // `stats` covers the whole commit, so the totals stay authoritative
                // even where the file list is truncated. Unchanged by #271.
                //
                // `?? 0` on the null branch is "not observed", NOT "observed to be zero" — the
                // two are distinguishable in the body (an empty commit returns
                // `stats: {additions: 0, deletions: 0, total: 0}`, present keys with real
                // numbers) and #288 keeps them distinguishable downstream. `GitCommit.additions`
                // is a required number, so zero is the only value expressible here;
                // `churnObserved: false` on the pushed row is what stops it reading as an
                // observation.
                const additions = observedStats?.additions ?? 0;
                const deletions = observedStats?.deletions ?? 0;

                // The list row and the detail response carry the IDENTICAL embedded `commit`
                // object — that identity is precisely what licenses the cache-hit path above
                // to build a whole `GitCommit` from the list row alone. So either copy
                // answers, and a shape anomaly in ONE of two copies of the same object is not
                // a reason to lose the commit (#275): prefer the detail, which is the response
                // just fetched, and fall back to the list row. Before this, a detail whose
                // `commit` was missing dropped the commit outright even when the list row —
                // already in hand, no extra request — carried everything needed.
                //
                // Picked as ONE object, not as a flag consulted per field: the whole identity
                // comes from whichever copy answered, so there is no way for a later edit to
                // read the date off one and the name off the other.
                const detailCommit = detail.commit;
                const source =
                    detailCommit?.author && isAttributableDate(detailCommit.author.date)
                        ? detailCommit
                        : listCommit;
                if (!source?.author || !isAttributableDate(source.author.date)) {
                    // UNATTRIBUTABLE, not unfetched — see `GitCommitDrop` for why this reports
                    // instead of throwing (in one line: a throw holds the provider's whole
                    // cursor for a fault that recurs identically, so it bricks rather than
                    // heals). `summary.sha`, the spelling GitHub's own commit list used, so the
                    // operator can look the commit up.
                    //
                    // The two reasons are distinguished by whether a date was PRESENT at all,
                    // because the operator's next step differs: absent on both copies means a
                    // truncated response, while present-but-unusable means a real commit whose
                    // timestamp this pipeline cannot key on. Critically, the unusable case must
                    // be caught here and not left to pass — see `isAttributableDate` above, and
                    // `UTC_DAY_RE` in `raw-author-daily.ts`, for what it does one frame down if
                    // it escapes.
                    // `typeof … === 'string' && !== ''`, not `!== undefined`: `date: null` and
                    // `date: ''` are what a truncated or garbled body actually yields, and
                    // calling those "present but unattributable" sends the operator looking for
                    // a real commit with an odd timestamp — the precise opposite of the truth,
                    // and it inverts the only distinction the two reasons exist to draw.
                    const hasDate = (d: unknown): boolean => typeof d === 'string' && d !== '';
                    onDrop?.({
                        sha: summary.sha,
                        reason:
                            hasDate(detailCommit?.author?.date) || hasDate(listCommit?.author?.date)
                                ? UNATTRIBUTABLE_DATE_DROP_REASON
                                : NO_AUTHOR_DATE_DROP_REASON,
                    });
                    continue;
                }

                // A body that supplied NEITHER a usable `commit` nor `stats` is a malformed
                // RESPONSE, not a fact about the commit — so it belongs to the recoverable
                // channel, and throwing puts it there (#275 review cycle 2, SO-1).
                //
                // Recovering it instead was the trap: `additions`/`deletions`/`diffs` above are
                // read off this same body, so the recovered commit would carry 0/0/[] — and
                // those zeros land in `raw_author_daily`, which is ADDITIVE and append-only,
                // with the cursor advanced past the day. That is a permanent, silent
                // understatement of the developer-day's churn in the one table that has no
                // recompute path, and the empty `diffs` array even suppresses the sync loop's
                // `getCommitDiff` fallback (`[]` is an answer there, deliberately). Skipping the
                // diffstat memo does not help: the memo is trivially re-fetchable, the snapshot
                // is not, so guarding only the memo protected the cheap side.
                //
                // Throwing routes it to `fetchRepoWithRetry` — the in-run repo retry, where a
                // transient bad body heals — and then, if it never heals, #231's cursor hold.
                // NOT to the request layer's 5xx budget: `fetchGitHub` already returned 200 and
                // unwound, so the repo retry is the first and only hop, i.e. 1 attempt + 2
                // retries, not 1 + 5 + 2. `status: null` is what marks it retryable.
                //
                // SCOPE, precisely, because the adjacent `put` depends on it: this fires only
                // when the identity ALSO had to come from the list row. A detail whose `commit`
                // is usable but whose `stats` is absent does NOT throw. The two shapes are
                // distinguished because one of them has independent evidence the BODY is
                // broken — it failed to carry a usable `commit` object, which GitHub's
                // commit-detail endpoint always sends — while the other is a response GitHub's
                // own published contract permits.
                //
                // #288 SETTLED THAT SECOND HALF, which #275 left open, and this is the record of
                // the decision and its evidence:
                //
                //   EVIDENCE. GitHub's REST reference for `GET /repos/{owner}/{repo}/commits/
                //   {ref}` (docs.github.com/en/rest/commits/commits) does NOT list `stats` — or
                //   `files` — among the 200 response's required properties, and documents no
                //   condition under which either is sent. It does document that the diff-derived
                //   parts of this response degrade: `files` paginates at 300 entries per page up
                //   to a 3000-file ceiling, and the diff/patch media types "may time out and
                //   return a 5xx status code" on large commits. A genuinely EMPTY commit is not
                //   the omission case — it returns `stats: {additions: 0, deletions: 0,
                //   total: 0}`, a present key — so absence and observed-zero are distinguishable
                //   in the body, which is what makes any of this actionable.
                //
                //   DECISION. The published contract permits an absent `stats`, so absence is
                //   not evidence of a malformed body and the throw is NOT widened to cover it.
                //   Widening it would hold the provider's whole forward cursor on a shape that
                //   recurs identically on every re-fetch — the brick-rather-than-heal outcome
                //   `GitCommitDrop` exists to avoid — and it would do so for a fault whose
                //   worst case (one commit's line counts understated) is strictly smaller than
                //   its own (every commit for that provider, forever).
                //
                //   CONSEQUENCE, which is the part that actually changed. The commit is kept,
                //   but its churn is UNKNOWN rather than zero, so the two things that would
                //   otherwise launder that unknown into a fact are stopped: it is not memoized
                //   (see the `put` gate below) and it is REPORTED, via `churnObserved: false` on
                //   the returned row, which the sync aggregates into an operator-facing advisory
                //   naming the affected repo, a count and a bounded sample of the affected
                //   commits. NOT the developer-days themselves — naming an individual's day in a
                //   line that reaches a shared sync log is exactly what the privacy model
                //   forbids. Before #288 it was memoized and silent.
                //
                //   BOUND, because the guarantee is prospective. Rows already in
                //   `commit_diffstats` from a pre-#288 run are indistinguishable from an observed
                //   zero, and the cache-hit path above serves them without ever reaching this
                //   code — so an installation that already has them keeps being answered by them.
                //   `toprope git cache clear` is the operator surface that discards them (#286);
                //   the memo is of an idempotent remote read, so clearing costs only re-fetching.
                if (source !== detailCommit && !churnObserved) {
                    throw new GitProviderFetchError(
                        `GitHub commit detail for ${summary.sha} in ${this.org}/${repo} carried ` +
                            'neither a usable commit object nor stats — malformed response',
                        null,
                    );
                }

                // THE MEMO IS GATED ON `stats` HAVING BEEN OBSERVED (#288). `commit_diffstats`
                // has NO invalidation, so a row written here is served to every later run
                // forever, in place of the detail fetch that would have produced it — which is
                // exactly the "no path memoizes a diffstat that a later well-formed fetch would
                // contradict" rule. Memoizing `additions: 0, deletions: 0` for a commit whose
                // `stats` was merely absent is that contradiction in its purest form: the memo
                // would outlive the condition that produced it and answer for a commit that
                // GitHub is perfectly willing to describe. Note the gate is `stats`, NOT the
                // whole body: a detail carrying `files` but no `stats` still has real `entries`,
                // and memoizing them beside a fabricated `0`/`0` would be worse than memoizing
                // nothing, because the row would then LOOK observed.
                //
                // Not memoizing costs a re-fetch only where the commit is asked for again — an
                // in-run retry, a backfill, or a re-import; a completed run advances the cursor
                // past the window, so in steady state it costs nothing. Safe in any case: the
                // memo is of an idempotent remote read, which is the whole reason
                // `commit_diffstats` sits outside the append-only rule.
                //
                // On the RECOVERY path — identity from the list row — this is reached only with
                // real `stats` in hand, because the throw above sends the alternative away.
                //
                // Cached AFTER the date guard, so a commit the un-cached path DROPS can never be
                // pushed by a later warm run (#273) — the opposite divergence to the one the hit
                // gate prevents, and just as much a break of "a hit produces what a fetch
                // produces".
                //
                // Keyed on `summary.sha`, the same spelling `load` was asked for, so a write
                // is guaranteed to be found by the next run's read.
                //
                // `absent: false` always. Unlike Bitbucket/GitLab, a 404 here is NOT an
                // answer: the sha came from GitHub's own commit list, and the endpoint is the
                // commit itself rather than a separate diffstat resource — so a 404 is an
                // anomaly that must surface, and `fetchGitHub` throws it (#272). No FETCH
                // failure of any kind reaches this line, which is also why GitHub does not use
                // the shared `resolveCommitDiffstat` helper the other two providers share.
                if (churnObserved) {
                    this.diffstatCache?.put(repo, summary.sha, {
                        additions,
                        deletions,
                        entries: diffs,
                        absent: false,
                    });
                }

                commits.push({
                    // `summary.sha`, not `detail.sha`: identical by construction (the detail
                    // was requested BY this sha), and it is the spelling the diffstat cache is
                    // keyed on and the drop report names — so on the fallback path, where the
                    // detail body is the malformed one, every use of the sha stays consistent.
                    sha: summary.sha,
                    author: {
                        name: source.author.name,
                        email: source.author.email,
                        // `summary.author`, deliberately, on BOTH this path and the cache-hit
                        // path above — the top-level `author` (the linked GitHub user) is the
                        // same object on both endpoints, so reading it from one place is what
                        // makes a warm run and a cold run agree. They must: `raw_author_daily`
                        // keys on `login` in preference to email, so a hit/miss disagreement
                        // here would split one author's history across two raw identities
                        // (#254's failure class). `''` when GitHub names no user — a real
                        // answer for an unlinked commit (e.g. a merge bot), not an anomaly.
                        username: summary.author?.login ?? '',
                    },
                    date: source.author.date,
                    message: source.message,
                    additions,
                    deletions,
                    diffs,
                    // The same condition that withheld the memo, on the row itself (#288), so a
                    // reader downstream can tell a zero that was OBSERVED from one that was
                    // merely not reported. Reached only after the date guard's `continue`, so a
                    // dropped commit structurally cannot carry it — the two reports can never
                    // both fire for one sha.
                    churnObserved,
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
                // Together with the `onDrop` report above, these are now the ONLY two ways this
                // loop can return fewer commits than it listed, and BOTH are visible: a recoverable
                // fault throws (here), an unattributable commit is reported (there). Neither is
                // silent — that is what #275 closed. Keep it that way: a third, unreported
                // `continue` restores exactly the permanent invisible snapshot gap #231/#235/#275
                // exist to prevent, and see `GitProvider.getCommits` for why a short list on its
                // own is read by the caller as "window fully covered".
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
            const res = await fetchGitHub(nextUrl, this.authHeaders, this.policy);
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
            const res = await fetchGitHub(nextUrl, this.authHeaders, this.policy);
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
            const res = await fetchGitHub(nextUrl, this.authHeaders, this.policy);
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
            this.policy,
        );
        const detail = (await res.json()) as RawCommitDetail;

        return toFileDiffs(detail);
    }
}
