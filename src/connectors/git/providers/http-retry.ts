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

/** First 5xx pause, before jitter. Doubles per retry. */
export const SERVER_ERROR_BASE_DELAY_MS = 5_000;

/**
 * Ceiling for a single 5xx pause. With {@link MAX_SERVER_ERROR_RETRIES} the un-jittered
 * schedule is 5s → 10s → 20s → 40s → 80s, so the total budget is ~2.5 minutes (~1.3
 * minutes at minimum jitter) instead of the pre-#272 six seconds.
 */
export const SERVER_ERROR_MAX_DELAY_MS = 120_000;

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

    // delta-seconds — the form every git provider actually sends.
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (!Number.isFinite(seconds)) return null;
        return Math.round(seconds * 1_000);
    }

    // HTTP-date. Gated on containing a letter first, because `Date.parse` is far more
    // permissive than the header is: it reads '-5' as a year and yields a huge negative
    // instant, which the clamp below would turn into a zero wait — the same
    // unusable-header-becomes-instant-retry hole the delta-seconds path just closed. Every
    // RFC 9110 date form (and the ISO form some servers send) carries a month name, a day
    // name or a 'T'/'Z', so requiring one letter admits all of them and rejects stray
    // numerics. A date already in the past is a zero wait, not a negative one.
    if (!/[a-z]/i.test(trimmed)) return null;
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    return Math.max(at - Date.now(), 0);
}

/**
 * How long to wait before retry number `attempt` (0-based) of a 5xx or transport fault.
 *
 * A usable `Retry-After` wins outright and is NOT jittered downward — waiting less than
 * the server asked for is exactly what the header forbids. It is still capped at
 * {@link SERVER_ERROR_MAX_DELAY_MS} so a mistaken or hostile header cannot park a sync
 * indefinitely; if the outage genuinely outlasts the cap, the next 5xx re-reads the
 * header and waits again.
 *
 * Otherwise: exponential backoff with equal jitter — half the delay fixed, half random.
 * The fixed half guarantees the backoff still grows; the random half keeps a sync whose
 * many in-flight repos all hit the same outage from re-converging on one instant.
 */
export function serverErrorDelayMs(attempt: number, retryAfterHeader: string | null): number {
    const advertised = parseRetryAfterMs(retryAfterHeader);
    if (advertised !== null) {
        return Math.min(advertised, SERVER_ERROR_MAX_DELAY_MS);
    }
    const base = Math.min(
        SERVER_ERROR_BASE_DELAY_MS * 2 ** attempt,
        SERVER_ERROR_MAX_DELAY_MS,
    );
    return Math.round(base / 2 + Math.random() * (base / 2));
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
