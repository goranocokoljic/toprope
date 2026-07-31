/**
 * Shared HTTP retry policy for the git providers (#272).
 *
 * All three providers (`github.ts`, `gitlab.ts`, `bitbucket.ts`) hand-rolled the same
 * retry loop, and all three gave a 5xx the same ~6-second fuse: three linear 1s/2s/3s
 * pauses. Real provider blips last minutes, and a single un-retried 503 anywhere in a
 * multi-hour initial sync throws away the WHOLE run's data (a partially-covered window
 * must not advance the cursor — see `ProviderFetchResult.complete`). This module owns the
 * one 5xx policy the three share so they cannot drift apart again.
 *
 * It is a policy + typed-error module AND — since #284 — the one retry LOOP that Bitbucket and
 * GitLab share ({@link fetchWithGitRetry}). GitHub keeps its own loop, and that asymmetry is
 * deliberate rather than unfinished work: `fetchGitHub` alone handles a 403 primary/secondary
 * rate limit and pre-emptively pauses on `x-ratelimit-remaining`, so absorbing it would mean
 * adding hooks for branches its two siblings do not have. The residual cost is real and named at
 * `fetchGitHub` itself — four branches there restate this module's policy and must be changed in
 * lockstep with it, which `request-policy.test.ts` is the guard for.
 *
 * SCOPE. This is the canonical `Retry-After` / backoff policy for the three GIT PROVIDERS
 * only. The tool connectors (`connectors/copilot`, `claude-code`, `windsurf`, `cursor`,
 * and the dead `connectors/git/client.ts`) each still carry their own `parseRetryAfterMs`
 * with a different contract — they return a fallback delay where this returns `null` — and
 * keep the short 5xx fuse. That is deliberately out of scope for #272: those connectors
 * make a handful of requests per run and a failure loses nothing, whereas a single failure
 * here discards a multi-hour run via #231's cursor hold. If you migrate them, this module
 * is the destination; don't add a seventh copy.
 */

/**
 * A fetch that ended a git-provider request after its retry budget was spent.
 *
 * Carries the HTTP `status` — or `null` for a transport-level fault (DNS failure,
 * connection reset, timeout) that never produced a response — so callers can decide
 * whether a longer pause could plausibly help instead of pattern-matching the message
 * string. `message` is unchanged from what the providers threw before #272: `toprope
 * doctor` classifies provider failures by searching it for ` 404`, and the existing
 * provider tests assert on it.
 */
export class GitProviderFetchError extends Error {
    /** HTTP status of the failing response, or `null` for a transport-level fault. */
    readonly status: number | null;

    constructor(message: string, status: number | null, options?: {cause?: unknown}) {
        super(message, options);
        this.name = 'GitProviderFetchError';
        this.status = status;
    }
}

/** Retries granted to a 5xx (or transport fault) BEYOND the initial attempt. */
export const MAX_SERVER_ERROR_RETRIES = 5;

/**
 * Retries granted to a rate-limited response (429, or GitHub's 403 secondary limit) BEYOND
 * the initial attempt.
 *
 * Separate from {@link MAX_SERVER_ERROR_RETRIES} and much smaller, because each of these
 * pauses is not a guess but the reset instant the server itself advertised — up to
 * {@link MAX_RATE_LIMIT_DELAY_MS}. Three of those is already up to three hours of waiting,
 * which is the right order for a limit that resets hourly and far too many for anything else.
 * Owned here, not per provider: this is the half of the policy that #272 review cycle 2
 * caught still triplicated as a local `MAX_RETRIES` in each of the three fetch loops, i.e.
 * free to drift in exactly the way this module exists to prevent.
 */
export const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * The pause to use for retry `attempt` of a rate-limited response when it carries NO usable
 * reset information — a linear 60s/120s/180s guess, unchanged from the pre-#272 per-provider
 * copies it replaces.
 */
export function rateLimitFallbackMs(attempt: number): number {
    return 60_000 * (attempt + 1);
}

/**
 * Transient-fault retries for an interactive REACHABILITY PROBE (`checkAccess`), as opposed
 * to a sync's data fetch.
 *
 * ZERO, not one. A probe's whole value is answering "are you up right now": it backs `toprope
 * doctor` (serially, per provider) and the admin "test connection" route, which answers inside
 * one HTTP request a human is waiting on. Even a single retry is not bounded by a few seconds
 * the way it looks — {@link serverErrorDelayMs} honors `Retry-After` as a floor, so one retry
 * against a host answering `503 Retry-After: 3600` (an utterly ordinary maintenance response,
 * and for self-hosted GitLab the host is admin-supplied) waits the full
 * {@link SERVER_ERROR_MAX_DELAY_MS} — two minutes of pure sleeping, after which the browser or
 * proxy has usually given up first. {@link GIT_REQUEST_TIMEOUT_MS} (#283) does not shorten that:
 * it bounds how long one request may wait for a RESPONSE, not how long the retry policy may
 * sleep between requests. Only a zero budget removes the symptom this constant exists for.
 *
 * The trade is explicit: a probe now reports a one-off blip as unreachable. That is the right
 * failure for a cheap, idempotent, re-runnable check — and the sync itself, where a blip
 * genuinely costs hours of work, still gets the full budget.
 */
export const PROBE_SERVER_ERROR_RETRIES = 0;

/**
 * Retries granted to a request out of BOTH budgets — the caller's intent, expressed as
 * numbers rather than as a boolean the request loops would have to interpret (#283).
 *
 * Before this the two halves were asymmetric in a way nothing named: `maxTransientRetries`
 * was a per-CALL parameter (so {@link PROBE_SERVER_ERROR_RETRIES} could be applied to
 * `checkAccess`), while the rate-limit budget was the module constant with no override at
 * all. An interactive probe therefore failed fast on a 503 and still slept up to
 * `MAX_RATE_LIMIT_RETRIES × MAX_RATE_LIMIT_DELAY_MS` — three hours — inside one HTTP request
 * a human was waiting on. Both halves live here now so a caller cannot close one and leave
 * the other open.
 */
export interface GitRetryProfile {
    /** Retries for a 5xx or transport fault. */
    readonly transient: number;
    /** Retries for a rate-limited response (429, GitHub's 403 secondary limit). */
    readonly rateLimit: number;
}

/**
 * What a SYNC's data fetch gets: the full budgets this module documents. A single failure
 * here discards a multi-hour run via #231's cursor hold, so waiting is much cheaper than
 * failing.
 */
export const SYNC_RETRY_PROFILE: GitRetryProfile = {
    transient: MAX_SERVER_ERROR_RETRIES,
    rateLimit: MAX_RATE_LIMIT_RETRIES,
};

/**
 * A wall-clock deadline for one sync RUN, which the request layer consults on the same clock
 * the repo-level pauses are bounded by (#283).
 *
 * WHY A DEADLINE AND NOT A BIGGER BUDGET. Before this, nothing bounded how long a run could
 * take. `GIT_RUN_RETRY_SLEEP_BUDGET_MS` bounds only the REPO-level pauses; the request layer's
 * own sleeping was unbounded in aggregate because each request carries its budget
 * independently, and the per-commit detail/diffstat fetch is an O(commits) population. A host
 * answering every request `503 Retry-After: 3600` pins each pause to
 * {@link SERVER_ERROR_MAX_DELAY_MS}, i.e. ~10 minutes PER REQUEST — so run length was a
 * function of the provider's behaviour, with no ceiling at all.
 *
 * WHY IT IS SAFE TO CUT A RUN OFF — this is the part that changed in #273 and makes the
 * deadline possible now. A cut-off run's window is not fully covered, so #231 holds the
 * cursor and discards the run's partial snapshots, exactly as any other failure does. But the
 * per-commit diffstat memo (`commit_diffstats`) is written per commit OUTSIDE the run's write
 * transaction, so every commit detail the run did fetch is kept. The next run re-pages the
 * commit lists (O(pages)) and serves the whole fan-out from the memo — so each run redoes
 * strictly less of the dominant cost than the last. Without that memo a deadline would have
 * been a brick: a repo too big for the budget would fail identically forever.
 *
 * WHAT THAT DOES *NOT* PROMISE, stated because the ratchet is easy to over-read. Only the
 * per-commit fan-out is memoized. The commit-LIST paging and the entire per-PR review fan-out
 * (`getPullRequests` + two calls per PR) have no memo and are re-paid in full on every run. So
 * convergence is conditional, not guaranteed: it holds iff the UN-memoized work for one window
 * fits inside the budget. `GIT_CATCHUP_WINDOW_MAX_DAYS` bounds that window to 30 days on any
 * cursor-resuming run, which is what makes the condition hold in practice; a FIRST sync is
 * deliberately uncapped (see `SyncRunOptions.firstSyncWindowMonths`), so an initial import whose
 * un-memoized work alone exceeds the budget will stop at the same place every run until the
 * operator narrows it. `runDeadlineLine` names that lever rather than leaving it to be inferred.
 *
 * An interface rather than a bare instant so tests can drive it without a fake clock, and so
 * the sync's `runBudget` can own construction.
 */
export interface GitRunDeadline {
    /** Milliseconds left before the deadline. Zero or negative once it has passed. */
    remainingMs(): number;
}

/**
 * A deadline `budgetMs` from now.
 *
 * Range-validated on BOTH bounds rather than trusted, per the graduated rule: a `NaN` or
 * `Infinity` budget would make every `remainingMs()` comparison false and silently restore the
 * unbounded behaviour this exists to remove, and a non-positive one would fail every request
 * before it is issued. Neither is reachable from the in-tree callers (both pass a module
 * constant), which is precisely why an unchecked mistake here would be invisible.
 */
export function createRunDeadline(budgetMs: number): GitRunDeadline {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
        throw new Error(`git run deadline budget must be a positive finite number of ms, got ${budgetMs}`);
    }
    const at = Date.now() + budgetMs;
    return {remainingMs: () => at - Date.now()};
}

/**
 * The retry budgets and the wall-clock deadline one provider CLIENT was built with.
 *
 * Carried on the client rather than passed per call, because it is a property of WHO built it:
 * the sync pipeline builds one client per provider per run and hands it that run's deadline,
 * while `doctor` and the admin routes build a throwaway client per request. That also means a
 * client can never be half-configured — there is no call site that could forget to pass the
 * interactive budget to `listRepos` the way #283's bullet 4 describes.
 */
export interface GitRequestPolicy {
    readonly retries: GitRetryProfile;
    /**
     * Absent on the interactive clients, which are bounded by their zero retry budgets and by
     * {@link GIT_REQUEST_TIMEOUT_MS} instead. Only a sync run has a wall clock worth naming.
     */
    readonly deadline?: GitRunDeadline;
}

/** The policy every sync fetch takes, unless the caller supplies a run deadline as well. */
export const SYNC_REQUEST_POLICY: GitRequestPolicy = {retries: SYNC_RETRY_PROFILE};

/**
 * What an INTERACTIVE caller gets: no sleeping at all, on either budget.
 *
 * Zero on BOTH halves, for the one reason {@link PROBE_SERVER_ERROR_RETRIES} states at
 * length — the caller is answering "is this reachable right now" inside a single HTTP request
 * a human (or a browser, or a proxy) is waiting on, and every pause available here is measured
 * in minutes or hours, not seconds. Three callers take it, and the second and third are what
 * #283 added:
 *   - `checkAccess()` — `toprope doctor` and the admin test-connection route;
 *   - `listRepos()` on `GET /api/admin/git/providers/:id/repos`, the repo-scope picker;
 *   - `listRepos()` in `toprope doctor`, which enumerates repos to verify configured slugs.
 *
 * It also disables GitHub's PRE-EMPTIVE rate-limit pause, which is neither a retry nor a
 * failure — it fires after a 200 when `x-ratelimit-remaining` is low and sleeps to the reset
 * instant, up to {@link MAX_RATE_LIMIT_DELAY_MS}. A retry-count override alone would have left
 * that third hour-long sleep on the interactive path.
 *
 * The trade is the same one {@link PROBE_SERVER_ERROR_RETRIES} names: an interactive call
 * reports a one-off blip as a failure — and, since it no longer waits out a 429/403 rate
 * limit, reports being rate-limited as a failure too. That is the right answer for a cheap,
 * idempotent, re-runnable read, but it puts weight on the REMEDIATION copy: see
 * `gitProviderFixHint`, which must recognise a rate limit before it blames the token's scopes.
 *
 * Written inline rather than as a named `GitRetryProfile` constant: there is exactly one
 * interactive shape and nothing composes it, so a separate export would have had no consumer
 * but this line. `SYNC_RETRY_PROFILE` earns its name because `sync.ts` composes it with a
 * run deadline.
 */
export const INTERACTIVE_REQUEST_POLICY: GitRequestPolicy = {
    retries: {transient: PROBE_SERVER_ERROR_RETRIES, rateLimit: 0},
};

/**
 * Ceiling on how long ONE HTTP request may take to produce a RESPONSE, enforced by an
 * `AbortSignal` handed to `fetch`.
 *
 * The gap it closes is not slowness but silence: a socket that connects and then never
 * answers produces no response and no error, so a request could hang indefinitely and no
 * budget on this page applied — they all bound RETRIES, which need a completed attempt to
 * count. Two minutes is far beyond any healthy response from these APIs (the slowest in-tree
 * call is a 100-item list page) while still being long enough that a merely slow provider is
 * not mistaken for a dead one.
 *
 * SCOPE — this bounds the request up to the point `fetch` RESOLVES (connect + request +
 * response headers), and nothing after it. That boundary is not a simplification, it is the
 * only correct one available here, and getting it wrong was a shipped bug this comment exists
 * to prevent recurring:
 *
 *   `fetch` resolves when the HEADERS arrive; the body is a stream the CALLER consumes later
 *   (`await res.json()`, outside the retry loops, at ~20 call sites). Per the Fetch spec an
 *   abort while that stream is still open ERRORS the stream. So a signal left armed past
 *   `fetch` does not merely "fire harmlessly on a settled request" — it destroys the body the
 *   caller has not read yet, and it rejects out of `res.json()` as a bare `Error`, OUTSIDE the
 *   `try` that would have wrapped it in a {@link GitProviderFetchError}. `isRetryableGitFetchError`
 *   then fails closed: no transient retry, no repo retry, `complete: false`, and #231 discards
 *   the whole run. GitHub's pre-emptive rate-limit pause makes that certain rather than
 *   unlikely — it sleeps up to {@link MAX_RATE_LIMIT_DELAY_MS} AFTER a 200 and then returns the
 *   response, so any pause over two minutes would have handed back a destroyed body.
 *
 * Bounding the body read as well would mean reading it inside the retry loop. #284 collapsed two
 * of the three loops into {@link fetchWithGitRetry} but deliberately did NOT do that: every call
 * site is handed a `Response` and consumes it itself — usually `res.json()` plus a paging header,
 * and `checkAccess` discards it unread — so pulling the read inside would change what all three
 * loops return and would still leave `fetchGitHub`, which keeps its own loop, outside the bound.
 * The body read remains bounded by undici's own `bodyTimeout` (300 s of inactivity), exactly as
 * it was before #283.
 *
 * An abort surfaces to the caller as the ordinary transport fault it is, so it takes the
 * transient budget and the same backoff as a 503 — a stalled socket is the same outage seen
 * one layer down. It is deliberately NOT wired to {@link GitRunDeadline}: an abort carrying
 * the deadline would be classified as transient and retried, which is the opposite of what
 * the deadline means, so the deadline is checked explicitly instead (see
 * {@link assertRunTimeRemaining}).
 */
export const GIT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * One request's timeout: the signal to hand `fetch`, and the `clear` that disarms it.
 *
 * `clear` is not optional hygiene — see {@link GIT_REQUEST_TIMEOUT_MS} for why a signal left
 * armed past `fetch` destroys the response body the caller is about to read. Call it in a
 * `finally` around the `fetch`, so it runs on the retry/`continue` path and the throw path
 * alike.
 */
export interface GitRequestTimeout {
    readonly signal: AbortSignal;
    /** Disarm the timer. MUST be called as soon as `fetch` settles, either way. */
    clear(): void;
}

/**
 * A fresh timeout bounding one request's RESPONSE at {@link GIT_REQUEST_TIMEOUT_MS}.
 *
 * An `AbortController` on a plain `setTimeout` rather than `AbortSignal.timeout`, for two
 * reasons. `AbortSignal.timeout` runs on a native timer that no test clock can advance, so the
 * only thing a test could assert about it is that it is an `AbortSignal` — which stays green if
 * the bound is changed to a decade. And it cannot be cancelled, which the paragraph above makes
 * mandatory rather than nice-to-have. This form is both drivable and disarmable.
 *
 * `unref`ed as well, so a timer disarmed late (or missed on some future path) still cannot hold
 * the process open.
 */
export function requestTimeout(): GitRequestTimeout {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        // Named `TimeoutError`, matching what `AbortSignal.timeout` produces — the transport
        // catch in each provider reads `err.message`, and an operator seeing this in
        // `sync_logs.errors` should get the standard wording.
        const reason = new Error(
            `git provider request exceeded ${GIT_REQUEST_TIMEOUT_MS} ms with no response`,
        );
        reason.name = 'TimeoutError';
        controller.abort(reason);
    }, GIT_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    return {signal: controller.signal, clear: () => clearTimeout(timer)};
}

/**
 * A fetch abandoned because the RUN ran out of wall clock (#283).
 *
 * Deliberately NOT a {@link GitProviderFetchError}, and that is load-bearing rather than
 * stylistic: {@link isRetryableGitFetchError} fails closed on any other error type, so this
 * cannot be handed to the in-run repo retry — which would answer "the run is out of time" by
 * sleeping another 5 and 15 minutes, the exact multiplication the deadline exists to stop.
 * It is also not a 404, so `resolveCommitDiffstat` rethrows it rather than memoizing a
 * deadline as a commit's answer.
 *
 * It propagates out of `getCommits` like any other fault, so #231 holds the provider's cursor
 * and the run's partial snapshots are discarded — see {@link GitRunDeadline} for why that
 * converges instead of bricking.
 */
export class GitRunDeadlineError extends Error {
    /**
     * WHY the fetch was abandoned — and the two are not interchangeable, which is the whole
     * reason this field exists (#283 review cycle 3, SO-1/SEC-1).
     *
     * - `clock-passed` — the budget is SPENT. Everything still unfetched in this run stays
     *   unfetched, so the window is not covered and the cursor must be held.
     * - `pause-refused` — the clock has NOT passed; the run simply cannot afford THIS pause,
     *   which for a rate-limit reset can be a full {@link MAX_RATE_LIMIT_DELAY_MS} hour. The
     *   fetch that provoked it failed for an ordinary retryable reason and the run is entitled
     *   to carry on and finish.
     *
     * Conflating them means one best-effort review-comment fetch meeting an hour-long
     * rate-limit reset with 45 minutes left discards a whole provider's successfully-fetched
     * run — the #231 best-effort trade this pipeline spends paragraphs refusing to make. The
     * caller distinguishes on this field rather than by re-reading the clock, because the
     * question is why we gave up, not what time it is now.
     */
    readonly kind: 'clock-passed' | 'pause-refused';

    constructor(kind: 'clock-passed' | 'pause-refused', message: string) {
        super(message);
        this.name = 'GitRunDeadlineError';
        this.kind = kind;
    }
}

/**
 * Refuse to START another request once the run's deadline has passed.
 *
 * Checked per request, not only before a sleep: a run can exceed its wall clock purely by
 * doing work — an O(commits) fan-out over a large history, with every request answering
 * promptly — and a deadline that only guarded pauses would not bound that at all.
 *
 * A no-op for a policy with no deadline (every interactive client).
 */
export function assertRunTimeRemaining(policy: GitRequestPolicy, url: string): void {
    const remaining = policy.deadline?.remainingMs();
    if (remaining === undefined) return;
    // TOTAL, per the graduated rule: a non-finite reading is rejected explicitly rather than
    // left to compare false. `remaining <= 0` alone fails OPEN on `NaN`, which would silently
    // restore the unbounded behaviour this exists to remove — and `GitRunDeadline` is a public
    // interface anything may implement, so "Date.now() can't be NaN" does not cover it.
    if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new GitRunDeadlineError(
            'clock-passed',
            `git sync run exceeded its wall-clock budget before requesting ${url}`,
        );
    }
}

/**
 * Pause for `delayMs`, unless the run's deadline could not survive the pause.
 *
 * Checked BEFORE sleeping and against the FULL delay, mirroring `fetchRepoWithRetry`'s
 * treatment of `GIT_RUN_RETRY_SLEEP_BUDGET_MS`: the deadline then bounds time actually spent
 * rather than time attempted, and a request cannot start a 120-second pause with 3 seconds of
 * budget left and report the overrun afterwards.
 *
 * A plain {@link sleep} for a policy with no deadline.
 */
export async function sleepWithinRun(
    policy: GitRequestPolicy,
    delayMs: number,
    url: string,
): Promise<void> {
    const remaining = policy.deadline?.remainingMs();
    // Total on both operands, per the graduated rule — `NaN >= NaN` is false, so an
    // unparseable reading would slip the guard and take the pause.
    if (remaining !== undefined && (!Number.isFinite(remaining) || delayMs >= remaining)) {
        // `pause-refused`, NOT `clock-passed`: the budget may have most of an hour left and
        // simply be shorter than this one rate-limit reset. See {@link GitRunDeadlineError.kind}
        // for why the caller must not read this as "the run is over".
        throw new GitRunDeadlineError(
            'pause-refused',
            `git sync run has ${Number.isFinite(remaining) ? Math.max(remaining, 0) : 'an unreadable amount of'} ` +
                `ms of its wall-clock budget left, less than the ${delayMs} ms retry pause ` +
                `requested for ${url}`,
        );
    }
    await sleep(delayMs);
}

/** First 5xx pause, before jitter. Doubles per retry. */
export const SERVER_ERROR_BASE_DELAY_MS = 5_000;

/**
 * Ceiling for a single 5xx pause. With {@link MAX_SERVER_ERROR_RETRIES} the un-jittered
 * schedule is 5s → 10s → 20s → 40s → 80s, so the budget is ~2.5 minutes (~1.3 minutes at
 * minimum jitter) instead of the pre-#272 six seconds — but that figure is the NO-header case
 * only. `Retry-After` is a floor (see {@link serverErrorDelayMs}), so a server answering
 * `503 Retry-After: 3600` pins every pause to this cap and the real worst case is
 * `MAX_SERVER_ERROR_RETRIES × 120s = 10 minutes` PER REQUEST. Quote the 10-minute number, not
 * the 2.5-minute one, whenever reasoning about how long a whole run can take: the per-commit
 * detail/diffstat fetch is an O(commits) population and each member carries this budget
 * independently, with no run-level deadline consulting it (#272, review cycle 3).
 *
 * Note the exponential term therefore tops out at 80s and never actually meets this cap — the
 * cap is live only on the `Retry-After` clamp in {@link serverErrorDelayMs}, and on the
 * exponential term it is a guard for whoever raises `MAX_SERVER_ERROR_RETRIES` later.
 */
export const SERVER_ERROR_MAX_DELAY_MS = 120_000;

/**
 * Ceiling for a single RATE-LIMIT pause. Deliberately far higher than
 * {@link SERVER_ERROR_MAX_DELAY_MS}, because the two headers mean different things: a 503's
 * `Retry-After` is a guess we are free to re-ask after, while a rate-limit reset is a hard
 * fact about when the next request can possibly succeed — and GitHub's primary limit resets
 * hourly. Capping this at two minutes would just burn the budget re-asking a wall that is
 * still up. The cap exists only so a mistaken or hostile value cannot park a sync forever.
 */
export const MAX_RATE_LIMIT_DELAY_MS = 60 * 60_000;

/**
 * Floor for a rate-limit pause. `Retry-After: 0` on a 429 is not a licence to retry
 * instantly — doing so spends the whole (small) rate-limit budget in one tick and turns a
 * survivable limit into a failed run, which is also how a primary limit gets escalated into
 * a secondary/abuse block.
 */
const MIN_RATE_LIMIT_DELAY_MS = 1_000;

/**
 * A shared `sleep` for this module and the three providers that import its policy.
 *
 * Not repo-wide: `scheduler/sync-pipeline.ts` and the four tool-connector clients keep their own
 * one-liners, because importing a `connectors/git/providers/*` symbol into the scheduler would
 * invert the layering for two lines. This removes the copies inside the surface #272 owns.
 */
export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `Retry-After` as milliseconds from now, or `null` when the header is absent or
 * unusable.
 *
 * Both RFC 9110 forms are accepted. The HTTP-date form matters for more than
 * completeness: the pre-#272 code ran every `Retry-After` through `parseFloat`, so a date
 * became `NaN`, `setTimeout(NaN)` fired on the next tick, and the backoff the header
 * asked for collapsed into an immediate retry — the opposite of honoring it. Anything
 * unparseable returns `null` so the caller falls back to its own backoff rather than
 * waiting zero.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
    if (header === null || header === undefined) return null;
    const trimmed = header.trim();
    if (trimmed === '') return null;

    // delta-seconds — the only form RFC 9110 defines numerically, and the form every git
    // provider actually sends. Anchored and integral: `parseFloat` accepted '30s' and '-5'.
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (!Number.isFinite(seconds)) return null;
        return seconds * 1_000;
    }

    // HTTP-date. Gated on containing a letter first, because `Date.parse` is far more
    // permissive than the header is: it reads '-5' as a year and yields a huge negative
    // instant. Every RFC 9110 date form (and the ISO form some servers send) carries a month
    // name, a day name or a 'T'/'Z', so requiring one letter admits all of them and rejects
    // stray numerics.
    if (!/[a-z]/i.test(trimmed)) return null;
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    // A date already in the past is a zero wait, not a negative one. Returning 0 rather than
    // `null` is safe ONLY because every caller treats the parsed value as a FLOOR against its
    // own backoff (see serverErrorDelayMs / rateLimitDelayMs) — a bare `Math.min(advertised,
    // cap)` here would let clock skew of one second collapse the whole retry budget.
    return Math.max(at - Date.now(), 0);
}

/**
 * How long to wait before retry number `attempt` (0-based) of a 5xx or transport fault.
 *
 * Without a usable `Retry-After`: exponential backoff with equal jitter — half the delay
 * fixed, half random. The fixed half guarantees the backoff still grows; the random half
 * keeps a sync whose many in-flight repos all hit the same outage from re-converging on one
 * instant.
 *
 * With one, the header acts as a FLOOR on that schedule, not as a replacement:
 * - never SOONER than the server asked — that is what the header forbids, so no downward
 *   jitter and no capping below the advertised value except by the hard ceiling;
 * - never sooner than our own backoff either. A replacement would mean `Retry-After: 0`, or
 *   an HTTP-date the client's clock has already passed (one second of skew is enough), spends
 *   all {@link MAX_SERVER_ERROR_RETRIES} retries in a few milliseconds — leaving the request
 *   failing FASTER than the six-second schedule this module replaced, on the exact input the
 *   module exists to handle. `Retry-After: 1` on a persistent 503 is the same trap by degrees.
 *
 * Capped at {@link SERVER_ERROR_MAX_DELAY_MS} so a mistaken or hostile header cannot park a
 * sync indefinitely; if the outage genuinely outlasts the cap, the next 5xx re-reads the
 * header and waits again.
 */
export function serverErrorDelayMs(attempt: number, retryAfterHeader: string | null): number {
    const base = Math.min(
        SERVER_ERROR_BASE_DELAY_MS * 2 ** attempt,
        SERVER_ERROR_MAX_DELAY_MS,
    );
    const advertised = parseRetryAfterMs(retryAfterHeader);
    if (advertised !== null) {
        return Math.min(Math.max(advertised, base), SERVER_ERROR_MAX_DELAY_MS);
    }
    return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * How long to wait before retrying a RATE-LIMITED request (429, or GitHub's 403 secondary
 * limit), given the response's `Retry-After` and the caller's own fallback for when there
 * isn't one.
 *
 * Exists so the four rate-limit branches stop hand-rolling `parseFloat(retryAfter) * 1_000`,
 * which is the very defect {@link parseRetryAfterMs} was written to close: an HTTP-date
 * became `NaN`, `setTimeout(NaN)` fired on the next tick, and the client hammered the
 * provider three times in one tick *while being rate limited* — which is how a primary limit
 * gets escalated into a secondary/abuse block. Bounded on BOTH sides
 * ({@link MIN_RATE_LIMIT_DELAY_MS} / {@link MAX_RATE_LIMIT_DELAY_MS}) for the same reasons.
 *
 * The fallback is NOT used as a floor for an advertised value the way `serverErrorDelayMs`
 * uses its backoff: a rate-limit reset is a fact about when the wall comes down, so a server
 * saying "5 seconds" must not be inflated to the 60-second guess we use when it says nothing.
 */
export function rateLimitDelayMs(retryAfterHeader: string | null, fallbackMs: number): number {
    const advertised = parseRetryAfterMs(retryAfterHeader);
    const wanted = advertised ?? fallbackMs;
    return Math.min(
        Math.max(wanted, MIN_RATE_LIMIT_DELAY_MS),
        MAX_RATE_LIMIT_DELAY_MS,
    );
}

/**
 * An absolute epoch-seconds reset header (GitLab's `RateLimit-Reset`, GitHub's
 * `x-ratelimit-reset`) as milliseconds from now, or `null` when absent/unusable.
 *
 * Separate from {@link parseRetryAfterMs} because the two headers carry different KINDS of
 * number and confusing them is silently catastrophic: GitLab's reset fed to a delta parser
 * (which is exactly what `parseFloat(…) * 1_000` did) yields ~1.8e12 ms, past `setTimeout`'s
 * 32-bit limit, so Node clamps it to 1 ms and the pause meant to outlast a rate limit becomes
 * an instant retry.
 */
export function parseEpochResetMs(header: string | null | undefined): number | null {
    if (header === null || header === undefined) return null;
    const trimmed = header.trim();
    // A fractional epoch is accepted and floored rather than rejected. GitHub and GitLab send
    // integers, but rejecting `1785283320.5` would be a behaviour REGRESSION: the code this
    // replaced used `parseInt`, which read it fine, and the caller's guard is `resetMs !== null`
    // — so a null here makes GitHub's primary-rate-limit branch fall through to an immediate
    // throw with no retry at all (#272 review cycle 2, TST-1). Sub-second precision is
    // irrelevant to a pause measured in minutes.
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const at = Math.floor(Number(trimmed)) * 1_000;
    if (!Number.isFinite(at)) return null;
    return Math.max(at - Date.now(), 0);
}

/**
 * Could pausing and asking again — at the REPO level, on a fixed schedule — plausibly succeed?
 *
 * Fails CLOSED: only an error this module produced, whose status says "transient", is
 * retryable. An unrecognized error is treated as permanent on purpose — the caller of this
 * predicate is the in-run repo retry, which pays minutes per attempt and re-pages the whole
 * repo, so spending that on a 401 or on a bug in our own adapter makes a bad run worse.
 *
 * Retryable:
 * - `null` status — a transport fault: no response was ever produced, which is transient by
 *   nature (the outage that returns 503 to one request resets the socket on the next).
 * - 5xx — the server said it failed and told us nothing about when to come back. By the time
 *   this surfaces the request-level budget is spent, so the outage outlived at least ~2.5 minutes
 *   (up to 10, if it was advertising a `Retry-After` — see {@link SERVER_ERROR_MAX_DELAY_MS}) and
 *   a longer, blind pause is the only remaining move.
 *
 * NOT retryable — and 429 belongs here, which is a change of mind from this module's first
 * cut (#272 review cycle 2, SEC-2):
 * - 429, and GitHub's 403 secondary limit. A rate limit is the one failure where the server
 *   tells us EXACTLY when to come back, and `rateLimitDelayMs` already waited that out
 *   {@link MAX_RATE_LIMIT_RETRIES} times, up to {@link MAX_RATE_LIMIT_DELAY_MS} each. A fixed
 *   5-minute pause cannot improve on the server's own reset instant, and re-paging an entire
 *   repo into a limit the provider just said is still up is precisely how a primary limit gets
 *   escalated into a secondary/abuse block. Worse, the repo retry would MULTIPLY the
 *   request-level waiting — three attempts each able to spend ~3 hours — and
 *   `GIT_RUN_RETRY_SLEEP_BUDGET_MS` bounds only the repo-level pauses, not that. Rate limiting
 *   is owned entirely by the request layer; the repo layer handles only the faults the request
 *   layer had no information to schedule around.
 * - 401/403/404/422 … — a deterministic answer about the request, not about the server's
 *   health. Asking again in five minutes gets the same answer.
 * - {@link GitRunDeadlineError}, which is not a `GitProviderFetchError` at all and so is
 *   caught by the fail-closed first line. Answering "the run is out of wall clock" with two
 *   more repo-level pauses would multiply exactly the quantity the deadline bounds (#283).
 */
export function isRetryableGitFetchError(err: unknown): boolean {
    if (!(err instanceof GitProviderFetchError)) return false;
    if (err.status === null) return true;
    return err.status >= 500;
}

/**
 * The provider name that opens every message {@link fetchWithGitRetry} throws.
 *
 * A closed union rather than a `string`, because these strings are a CONTRACT, not cosmetics:
 * `toprope doctor` classifies a provider failure by searching the message for ` 404`, and the
 * provider suites assert on `'GitLab API server error 502'` / `'Bitbucket API error 401'`
 * verbatim. Two literal call sites is the whole population, so the union costs nothing and a
 * third provider cannot be added by typo. (No runtime allowlist: this is not a trust boundary —
 * the value is a module-internal literal, never request-supplied.)
 */
export type GitProviderLabel = 'Bitbucket' | 'GitLab';

/**
 * The one retry loop Bitbucket and GitLab share (#284).
 *
 * After #272 moved the policy here, `fetchBitbucket` and `fetchGitLab` were line-for-line
 * identical — same five branches in the same order, same two independent counters — differing
 * only in the message prefix and in GitLab reading `ratelimit-reset` on a 429. The second is not
 * a real difference: Bitbucket does not send that header, so reading it unconditionally yields
 * `null` and falls through to {@link rateLimitFallbackMs} exactly as before. So the collapse
 * needs one extra argument, `label`, and no knob.
 *
 * That neutrality is now unconditional rather than contingent on the vendor's header spelling:
 * the 429 branch treats a non-positive reset as absent, so even a Bitbucket that started sending
 * `ratelimit-reset` — or sent it delta-shaped — degrades to the same fallback guess instead of
 * to the 1-second floor. See the branch itself for why that direction matters.
 *
 * `fetchGitHub` is deliberately NOT folded in — see this module's header.
 *
 * The two budgets are counted SEPARATELY (`attempt` for rate limits, `transientRetries` for 5xx
 * and transport faults) so a run cannot spend its 5xx allowance on rate limiting or vice versa;
 * that is also why the loop is a `for (;;)` rather than a counted one, and why every branch
 * either `continue`s or throws.
 */
export async function fetchWithGitRetry(
    url: string,
    headers: Record<string, string>,
    label: GitProviderLabel,
    // The retry budgets and run deadline the CLIENT was built with (#283) — see the identical
    // parameter on `fetchGitHub` for why this replaced a per-call transient-only override, and
    // for why it carries no default.
    policy: GitRequestPolicy,
): Promise<Response> {
    let attempt = 0;
    let transientRetries = 0;

    for (;;) {
        // Per ATTEMPT, not only before a pause — see `fetchGitHub` (#283).
        assertRunTimeRemaining(policy, url);
        let res: Response;
        // Disarmed in `finally` the moment `fetch` settles — the signal bounds the RESPONSE,
        // never the body the caller reads afterwards. See GIT_REQUEST_TIMEOUT_MS (#283).
        const timeout = requestTimeout();
        try {
            res = await fetch(url, {headers, signal: timeout.signal});
        } catch (err) {
            // A transport fault is the same outage as a 503, seen one layer down — same budget,
            // same backoff. Wrapped so the in-run repo retry (#272) can classify it; the message
            // is preserved verbatim, WITHOUT the `label` prefix, because it is the transport's
            // own wording and both providers threw it bare before #284. A
            // GIT_REQUEST_TIMEOUT_MS abort lands here too (#283).
            // Disarmed BEFORE the minutes-long backoff, not just by the `finally` — see the
            // identical note in `github.ts` (#283 review).
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
            // Idempotent, so clearing twice is safe; this stays the one guarantee no path
            // leaves a signal armed over an unread body.
            timeout.clear();
        }

        if (res.status === 429) {
            // `RateLimit-Reset` is an absolute EPOCH instant, not a delta like `Retry-After`
            // (#272). Both were previously fed to the same `parseFloat(…) * 1_000`, so the
            // reset became ~1.8e12 ms — past setTimeout's 32-bit limit, which Node clamps to
            // 1 ms. The pause meant to outlast the limit became an instant retry, and GitLab
            // was hammered while already rate-limiting us. Parsed by kind now. Read for
            // Bitbucket as well, which simply does not send it: absent → `null` → the same
            // fallback Bitbucket always used.
            //
            // ZERO IS TREATED AS ABSENT, not as "retry now" (#284 review, SO-1/SEC-1).
            // `parseEpochResetMs` floors its result at 0, so a reset instant already in the
            // past — one second of clock skew against a self-hosted GitLab is enough, and a
            // delta-shaped value from a server following the IETF draft rather than GitLab's
            // epoch spelling parses as 1970 — yields `0`, which `??` does NOT catch. That fell
            // through to `rateLimitDelayMs(null, 0)`, clamped up to MIN_RATE_LIMIT_DELAY_MS, and
            // spent the whole (deliberately small) rate-limit budget on three 1-second retries
            // INTO a provider that just said it is rate-limiting us — the primary→secondary/abuse
            // escalation MIN_RATE_LIMIT_DELAY_MS and this module's 429 policy exist to prevent.
            // A non-positive reset carries no schedulable information, so the honest reading is
            // "the server told us nothing usable" and the backoff guess is the right answer.
            const resetMs = parseEpochResetMs(res.headers.get('ratelimit-reset'));
            const rateLimitFallback =
                resetMs !== null && resetMs > 0 ? resetMs : rateLimitFallbackMs(attempt);
            if (attempt < policy.retries.rateLimit) {
                await sleepWithinRun(
                    policy,
                    rateLimitDelayMs(res.headers.get('retry-after'), rateLimitFallback),
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
                `${label} API server error ${res.status}: ${url}`,
                res.status,
            );
        }

        if (!res.ok) {
            throw new GitProviderFetchError(`${label} API error ${res.status}: ${url}`, res.status);
        }

        return res;
    }
}
