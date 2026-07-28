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
 * It is deliberately a policy + typed-error module, not a `fetchWithRetry` wrapper: the
 * three loops differ materially above the 5xx branch (GitHub alone handles a 403
 * secondary rate limit and pre-emptively pauses on `x-ratelimit-remaining`), so folding
 * them into one function would mean parameterizing those differences for no gain.
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
 * Transient-fault retries for an interactive REACHABILITY PROBE (`checkAccess`), as opposed
 * to a sync's data fetch.
 *
 * A probe's whole value is failing fast: it backs `toprope doctor` (serially, per provider)
 * and the admin "test connection" route, which answers inside one HTTP request a human is
 * waiting on. Spending the full {@link MAX_SERVER_ERROR_RETRIES} budget there would turn a
 * mistyped self-hosted URL into a ~2.5-minute hang and let any admin tie up a request that
 * long. One retry still absorbs a single blip, at a worst case of a few seconds.
 */
export const PROBE_SERVER_ERROR_RETRIES = 1;

/** First 5xx pause, before jitter. Doubles per retry. */
export const SERVER_ERROR_BASE_DELAY_MS = 5_000;

/**
 * Ceiling for a single 5xx pause. With {@link MAX_SERVER_ERROR_RETRIES} the un-jittered
 * schedule is 5s → 10s → 20s → 40s → 80s, so the total budget is ~2.5 minutes (~1.3
 * minutes at minimum jitter) instead of the pre-#272 six seconds.
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

/** A shared `sleep`, so the retry policy and its callers don't each re-declare one. */
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
    if (!/^\d+$/.test(trimmed)) return null;
    const at = Number(trimmed) * 1_000;
    if (!Number.isFinite(at)) return null;
    return Math.max(at - Date.now(), 0);
}

/**
 * Could pausing and asking again plausibly succeed?
 *
 * Fails CLOSED: only an error this module produced, whose status says "transient", is
 * retryable. An unrecognized error is treated as permanent on purpose — the caller of
 * this predicate is the in-run repo retry, which pays minutes per attempt, and spending
 * that on a 401 or on a bug in our own adapter makes a bad run worse rather than better.
 *
 * - `null` status — a transport fault: no response was ever produced, which is transient
 *   by nature (the outage that returns 503 to one request resets the socket on the next).
 * - 5xx — the server said it failed; by the time this surfaces the HTTP-level budget
 *   above is already spent, so the outage outlived ~2.5 minutes and only a longer pause
 *   can help.
 * - 429 — rate limited past the HTTP-level budget; a longer pause is precisely the fix.
 * - Everything else (401/403/404/422 …) is a deterministic answer about the request, not
 *   about the server's health. GitHub's 403 is included here even though a secondary
 *   rate limit can wear that status: `fetchGitHub` already waits out the advertised
 *   reset up to its own budget, so a 403 that escapes it is far more likely permissions.
 */
export function isRetryableGitFetchError(err: unknown): boolean {
    if (!(err instanceof GitProviderFetchError)) return false;
    if (err.status === null) return true;
    return err.status === 429 || err.status >= 500;
}
