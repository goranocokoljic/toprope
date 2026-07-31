/**
 * #272 — the shared 5xx retry policy the three git providers use.
 *
 * The incident: one transient Bitbucket 503 on a per-commit diffstat killed a multi-hour
 * initial sync, twice, because the 5xx branch retried three times over ~6 seconds total.
 * These are pure-function tests over the policy itself — no clock is advanced and nothing
 * sleeps, so they pin the SCHEDULE (which the provider-level tests can only pin the
 * request COUNT of).
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import type {GitRequestPolicy} from '../../../../src/connectors/git/providers/http-retry';
import {
    GIT_REQUEST_TIMEOUT_MS,
    GitProviderFetchError,
    GitRunDeadlineError,
    INTERACTIVE_REQUEST_POLICY,
    INTERACTIVE_RETRY_PROFILE,
    MAX_RATE_LIMIT_DELAY_MS,
    MAX_RATE_LIMIT_RETRIES,
    MAX_SERVER_ERROR_RETRIES,
    PROBE_SERVER_ERROR_RETRIES,
    SERVER_ERROR_BASE_DELAY_MS,
    SERVER_ERROR_MAX_DELAY_MS,
    SYNC_REQUEST_POLICY,
    SYNC_RETRY_PROFILE,
    assertRunTimeRemaining,
    createRunDeadline,
    isRetryableGitFetchError,
    parseEpochResetMs,
    parseRetryAfterMs,
    rateLimitDelayMs,
    rateLimitFallbackMs,
    requestTimeout,
    serverErrorDelayMs,
    sleepWithinRun,
} from '../../../../src/connectors/git/providers/http-retry';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('policy constants', () => {
    // Pinned as LITERALS, not against themselves. Every other assertion in this file derives
    // its expectation from these constants, so without this test the whole schedule could be
    // reverted to the pre-#272 six-second fuse — `SERVER_ERROR_BASE_DELAY_MS = 1_000`,
    // `MAX_SERVER_ERROR_RETRIES = 3` — and the suite would stay green. "Minutes, not seconds"
    // is the entire point of the issue, so it gets an assertion that cannot move with the code.
    it('spend minutes on a 5xx, and an hour at most on a rate limit', () => {
        expect(MAX_SERVER_ERROR_RETRIES).toBe(5);
        expect(SERVER_ERROR_BASE_DELAY_MS).toBe(5_000);
        expect(SERVER_ERROR_MAX_DELAY_MS).toBe(120_000);
        expect(MAX_RATE_LIMIT_DELAY_MS).toBe(3_600_000);
        expect(MAX_RATE_LIMIT_RETRIES).toBe(3);
        expect(rateLimitFallbackMs(0)).toBe(60_000);
        expect(rateLimitFallbackMs(2)).toBe(180_000);
        // A probe answers a waiting human — it must NOT retry at all, because even one retry is
        // worth up to SERVER_ERROR_MAX_DELAY_MS once Retry-After acts as a floor.
        expect(PROBE_SERVER_ERROR_RETRIES).toBe(0);
    });
});

describe('parseRetryAfterMs', () => {
    it('parses the delta-seconds form providers actually send', () => {
        expect(parseRetryAfterMs('30')).toBe(30_000);
        expect(parseRetryAfterMs('0')).toBe(0);
        expect(parseRetryAfterMs('  45  ')).toBe(45_000);
    });

    it('parses the HTTP-date form as a delay from now', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        expect(parseRetryAfterMs('Tue, 28 Jul 2026 10:02:00 GMT')).toBe(120_000);
    });

    it('clamps an HTTP-date already in the past to zero rather than negative', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        expect(parseRetryAfterMs('Tue, 28 Jul 2026 09:00:00 GMT')).toBe(0);
    });

    it('returns null for absent, blank or unparseable headers', () => {
        // The regression this guards: every one of these used to go through parseFloat, and
        // NaN reaches setTimeout as 0 — so the header that asked for a WAIT produced an
        // instant retry. null makes the caller fall back to its own backoff instead.
        expect(parseRetryAfterMs(null)).toBeNull();
        expect(parseRetryAfterMs(undefined)).toBeNull();
        expect(parseRetryAfterMs('')).toBeNull();
        expect(parseRetryAfterMs('   ')).toBeNull();
        expect(parseRetryAfterMs('soon')).toBeNull();
        expect(parseRetryAfterMs('-5')).toBeNull();
        // parseFloat('30s') === 30; the anchored numeric test rejects it as a date instead,
        // and Date.parse cannot read it either — so no accidental half-parse.
        expect(parseRetryAfterMs('30s')).toBeNull();
        // Not a form RFC 9110 defines; `parseFloat` accepted it as 1.5.
        expect(parseRetryAfterMs('1.5')).toBeNull();
    });
});

describe('parseEpochResetMs', () => {
    // Kept separate from parseRetryAfterMs because the two headers carry different KINDS of
    // number, and the bug this closes was exactly conflating them: GitLab's epoch
    // `RateLimit-Reset` run through a delta parser yields ~1.8e12 ms, which setTimeout clamps
    // to 1 ms — so the pause meant to outlast a rate limit became an instant retry.
    it('reads an epoch instant as a delay from now', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        const inTwoMinutes = Math.floor(Date.parse('2026-07-28T10:02:00.000Z') / 1_000);
        expect(parseEpochResetMs(String(inTwoMinutes))).toBe(120_000);
    });

    it('never produces the 1.8e12 value a delta parser would', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        const raw = '1785283320';
        expect(parseEpochResetMs(raw)).toBeLessThan(MAX_RATE_LIMIT_DELAY_MS * 24);
        expect(Number(raw) * 1_000).toBeGreaterThan(1e12); // what the old code passed to sleep
    });

    it('clamps an already-elapsed reset to zero', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        expect(parseEpochResetMs(String(Math.floor(Date.now() / 1_000) - 60))).toBe(0);
    });

    it('returns null for absent or non-numeric headers', () => {
        expect(parseEpochResetMs(null)).toBeNull();
        expect(parseEpochResetMs(undefined)).toBeNull();
        expect(parseEpochResetMs('')).toBeNull();
        expect(parseEpochResetMs('later')).toBeNull();
        expect(parseEpochResetMs('-1')).toBeNull();
    });

    it('floors a fractional epoch rather than rejecting it', () => {
        // Rejecting it would be a behaviour REGRESSION: the `parseInt` this replaced read it
        // fine, and GitHub's primary-rate-limit branch guards on `resetMs !== null`, so a null
        // makes it fall through to an immediate throw with no retry at all.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        const inThirty = Math.floor(Date.parse('2026-07-28T10:00:30.000Z') / 1_000);
        expect(parseEpochResetMs(`${inThirty}.5`)).toBe(30_000);
    });
});

describe('rateLimitDelayMs', () => {
    it('honors Retry-After over the caller fallback', () => {
        expect(rateLimitDelayMs('45', 60_000)).toBe(45_000);
    });

    it('does not inflate a short advertised wait to the fallback guess', () => {
        // A rate-limit reset is a fact about when the wall comes down. The 60s fallback is the
        // guess used when the server says nothing, so it must not become a floor.
        expect(rateLimitDelayMs('5', 60_000)).toBe(5_000);
    });

    it('uses the fallback when the header is absent or unusable', () => {
        // The regression: `parseFloat` turned each unusable form into NaN, and setTimeout(NaN)
        // fires on the next tick — so the client hammered the provider three times in one
        // tick WHILE being rate limited, which is how a primary limit becomes an abuse block.
        expect(rateLimitDelayMs(null, 30_000)).toBe(30_000);
        expect(rateLimitDelayMs('garbage', 30_000)).toBe(30_000);
        expect(rateLimitDelayMs('30s', 30_000)).toBe(30_000);
    });

    it('honors an HTTP-date Retry-After as a real interval', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        expect(rateLimitDelayMs('Tue, 28 Jul 2026 10:02:00 GMT', 30_000)).toBe(120_000);
    });

    it('never returns an instant retry, even for Retry-After: 0', () => {
        expect(rateLimitDelayMs('0', 60_000)).toBeGreaterThan(0);
        expect(rateLimitDelayMs('0', 60_000)).toBe(1_000);
    });

    it('caps a hostile or mistaken value at an hour', () => {
        expect(rateLimitDelayMs('86400', 60_000)).toBe(MAX_RATE_LIMIT_DELAY_MS);
        expect(rateLimitDelayMs(null, 999_999_999)).toBe(MAX_RATE_LIMIT_DELAY_MS);
    });

    it('allows a genuinely long rate-limit wait that the 5xx cap would have cut short', () => {
        // GitHub's primary limit resets hourly. Capping this at the 5xx ceiling (2 min) would
        // just burn the budget re-asking a wall that is still up — hence the separate cap.
        expect(rateLimitDelayMs('1800', 60_000)).toBe(1_800_000);
        expect(rateLimitDelayMs('1800', 60_000)).toBeGreaterThan(SERVER_ERROR_MAX_DELAY_MS);
    });
});

describe('serverErrorDelayMs', () => {
    it('grows exponentially from the base delay', () => {
        // Jitter pinned to its maximum so the schedule itself is visible.
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(serverErrorDelayMs(0, null)).toBe(SERVER_ERROR_BASE_DELAY_MS);
        expect(serverErrorDelayMs(1, null)).toBe(SERVER_ERROR_BASE_DELAY_MS * 2);
        expect(serverErrorDelayMs(2, null)).toBe(SERVER_ERROR_BASE_DELAY_MS * 4);
        expect(serverErrorDelayMs(3, null)).toBe(SERVER_ERROR_BASE_DELAY_MS * 8);
        expect(serverErrorDelayMs(4, null)).toBe(SERVER_ERROR_BASE_DELAY_MS * 16);
    });

    it('caps a single pause at the maximum however high the attempt goes', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(serverErrorDelayMs(10, null)).toBe(SERVER_ERROR_MAX_DELAY_MS);
        expect(serverErrorDelayMs(60, null)).toBe(SERVER_ERROR_MAX_DELAY_MS);
    });

    it('jitters within [base/2, base] — never below half the intended backoff', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(serverErrorDelayMs(2, null)).toBe((SERVER_ERROR_BASE_DELAY_MS * 4) / 2);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(serverErrorDelayMs(2, null)).toBe(SERVER_ERROR_BASE_DELAY_MS * 4 * 0.75);
    });

    it('spends minutes, not seconds, across the whole retry budget', () => {
        // The actual point of #272. At MINIMUM jitter the total must still be well past the
        // ~6 seconds the linear 1s/2s/3s schedule spent, because real provider blips last
        // minutes.
        vi.spyOn(Math, 'random').mockReturnValue(0);
        let total = 0;
        for (let attempt = 0; attempt < MAX_SERVER_ERROR_RETRIES; attempt++) {
            total += serverErrorDelayMs(attempt, null);
        }
        expect(total).toBeGreaterThan(60_000);
    });

    it('honors Retry-After without jittering it downward', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(serverErrorDelayMs(0, '45')).toBe(45_000);
    });

    it('caps Retry-After so a hostile header cannot park the run', () => {
        expect(serverErrorDelayMs(0, '86400')).toBe(SERVER_ERROR_MAX_DELAY_MS);
    });

    it('treats Retry-After as a FLOOR on the schedule, never a replacement', () => {
        // The trap this closes: `Math.min(advertised, cap)` alone meant a server advertising a
        // short wait REPLACED the exponential term. `Retry-After: 1` on a persistent 503 then
        // spent all five retries in five seconds — LESS than the six-second schedule #272
        // replaced, on exactly the input #272 exists to survive.
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(serverErrorDelayMs(4, '7')).toBe(SERVER_ERROR_BASE_DELAY_MS * 16);
        expect(serverErrorDelayMs(0, '1')).toBe(SERVER_ERROR_BASE_DELAY_MS);
    });

    it('still spends minutes when the server advertises a tiny Retry-After every time', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        let total = 0;
        for (let attempt = 0; attempt < MAX_SERVER_ERROR_RETRIES; attempt++) {
            total += serverErrorDelayMs(attempt, '1');
        }
        expect(total).toBeGreaterThan(60_000);
    });

    it('cannot be collapsed to zero by Retry-After: 0 or a clock-skewed past date', () => {
        // `Retry-After: 0`, and an HTTP-date the client's clock has already passed (one second
        // of skew is enough), both parse to a usable 0. Replacing the schedule with it spent
        // the whole budget in microseconds.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(serverErrorDelayMs(0, '0')).toBe(SERVER_ERROR_BASE_DELAY_MS);
        expect(serverErrorDelayMs(2, 'Tue, 28 Jul 2026 09:59:59 GMT')).toBe(
            SERVER_ERROR_BASE_DELAY_MS * 4,
        );
    });

    it('falls back to jittered backoff when Retry-After is unusable', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(serverErrorDelayMs(1, 'not-a-date')).toBe(SERVER_ERROR_BASE_DELAY_MS * 2);
    });
});

describe('isRetryableGitFetchError', () => {
    it('treats 5xx as worth a longer pause', () => {
        for (const status of [500, 502, 503, 504]) {
            expect(isRetryableGitFetchError(new GitProviderFetchError('boom', status))).toBe(true);
        }
    });

    it('does NOT repo-retry a rate limit — the request layer owns that', () => {
        // The request layer already waited out the server's OWN reset instant
        // MAX_RATE_LIMIT_RETRIES times, up to an hour each. A blind 5-minute repo pause cannot
        // improve on that, re-paging a whole repo into a limit the provider just said is still up
        // is how a primary limit becomes an abuse block, and the repo retry would MULTIPLY the
        // request-level waiting by three while GIT_RUN_RETRY_SLEEP_BUDGET_MS bounds none of it.
        for (const status of [429, 403]) {
            expect(isRetryableGitFetchError(new GitProviderFetchError('limited', status))).toBe(
                false,
            );
        }
    });

    it('treats a transport fault (no status) as transient', () => {
        expect(isRetryableGitFetchError(new GitProviderFetchError('socket hang up', null))).toBe(
            true,
        );
    });

    it('treats a deterministic 4xx answer as permanent', () => {
        // A 20-minute in-run pause per repo to re-ask a 401 would turn one bad credential
        // into a run that never finishes.
        for (const status of [400, 401, 404, 422]) {
            expect(isRetryableGitFetchError(new GitProviderFetchError('nope', status))).toBe(false);
        }
    });

    it('fails closed on an error it did not produce', () => {
        expect(isRetryableGitFetchError(new Error('Bitbucket API server error 503: /x'))).toBe(
            false,
        );
        expect(isRetryableGitFetchError(new TypeError('cannot read x of undefined'))).toBe(false);
        expect(isRetryableGitFetchError('503')).toBe(false);
        expect(isRetryableGitFetchError(undefined)).toBe(false);
    });

    it('fails closed on the run-deadline error too (#283)', () => {
        // Load-bearing, not stylistic. The in-run repo retry answers a retryable fault with 5-
        // and 15-minute pauses; answering "the run is out of wall clock" that way would
        // multiply exactly the quantity the deadline bounds. It fails closed here because
        // GitRunDeadlineError is deliberately NOT a GitProviderFetchError.
        expect(isRetryableGitFetchError(new GitRunDeadlineError('out of time'))).toBe(false);
        // It is equally not the 404-is-an-answer case `resolveCommitDiffstat` memoizes: a
        // deadline frozen as a commit's permanent empty diffstat would be a silent data loss.
        const err = new GitRunDeadlineError('out of time');
        expect(err instanceof GitProviderFetchError).toBe(false);
        expect((err as unknown as {status?: number}).status).toBeUndefined();
    });
});

/**
 * #283 — the caller-intent retry profiles and the run-level wall clock.
 *
 * Pure-function tests, in the same spirit as the rest of this file: the provider-level tests
 * can only pin request COUNTS, so the decisions themselves — when a pause is refused, what an
 * expired deadline throws — are pinned here, once, where they live.
 */
describe('retry profiles (#283)', () => {
    it('gives a sync fetch the full documented budgets', () => {
        expect(SYNC_RETRY_PROFILE).toEqual({
            transient: MAX_SERVER_ERROR_RETRIES,
            rateLimit: MAX_RATE_LIMIT_RETRIES,
        });
        expect(SYNC_REQUEST_POLICY.retries).toEqual(SYNC_RETRY_PROFILE);
        // No deadline until a RUN supplies one — `SYNC_REQUEST_POLICY` is the default a
        // provider client falls back to, and a default deadline would be a wall clock nobody
        // chose.
        expect(SYNC_REQUEST_POLICY.deadline).toBeUndefined();
    });

    it('gives an interactive caller NO sleeping on either budget', () => {
        // Pinned as LITERALS, not against the constants they are built from: "an interactive
        // caller never waits" is the whole of #283's bullet 4, and deriving the expectation
        // from the source would keep this green through the exact regression it guards —
        // wiring `rateLimit` back to MAX_RATE_LIMIT_RETRIES, i.e. up to three hours of
        // sleeping inside one HTTP request a human is waiting on.
        expect(INTERACTIVE_RETRY_PROFILE).toEqual({transient: 0, rateLimit: 0});
        expect(INTERACTIVE_REQUEST_POLICY.retries).toEqual({transient: 0, rateLimit: 0});
        expect(INTERACTIVE_REQUEST_POLICY.deadline).toBeUndefined();
    });
});

describe('createRunDeadline (#283)', () => {
    it('counts down from now', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
        const deadline = createRunDeadline(60_000);

        expect(deadline.remainingMs()).toBe(60_000);
        vi.setSystemTime(new Date('2026-07-31T00:00:45.000Z'));
        expect(deadline.remainingMs()).toBe(15_000);
        vi.setSystemTime(new Date('2026-07-31T00:01:30.000Z'));
        // Negative, not clamped to zero — the callers compare it against a delay, and a clamp
        // would hide how far past its budget a run already is.
        expect(deadline.remainingMs()).toBe(-30_000);
    });

    it('rejects a budget that is not a positive finite number of ms', () => {
        // Range-validated on BOTH bounds. A NaN budget makes every `remainingMs()` comparison
        // false, silently restoring the unbounded behaviour the deadline exists to remove —
        // precisely the failure a lower-bound-only check would let through.
        for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
            expect(() => createRunDeadline(bad)).toThrow(/positive finite/);
        }
        expect(() => createRunDeadline(1)).not.toThrow();
    });
});

describe('assertRunTimeRemaining (#283)', () => {
    const withRemaining = (remainingMs: number): GitRequestPolicy => ({
        retries: SYNC_RETRY_PROFILE,
        deadline: {remainingMs: () => remainingMs},
    });

    it('refuses to START a request once the budget is spent', () => {
        // Checked per attempt, not only before a pause: a run can exhaust its wall clock on
        // nothing but promptly-answered work, and a deadline guarding only pauses would not
        // bound the O(commits) fan-out at all.
        expect(() => assertRunTimeRemaining(withRemaining(0), 'https://api/x')).toThrow(
            GitRunDeadlineError,
        );
        expect(() => assertRunTimeRemaining(withRemaining(-5), 'https://api/x')).toThrow(
            /wall-clock budget/,
        );
    });

    it('names the url so an operator can see where the run stopped', () => {
        expect(() => assertRunTimeRemaining(withRemaining(0), 'https://api/repos/x')).toThrow(
            /https:\/\/api\/repos\/x/,
        );
    });

    it('allows a request while time remains, and always without a deadline', () => {
        expect(() => assertRunTimeRemaining(withRemaining(1), 'https://api/x')).not.toThrow();
        expect(() => assertRunTimeRemaining(SYNC_REQUEST_POLICY, 'https://api/x')).not.toThrow();
        expect(() =>
            assertRunTimeRemaining(INTERACTIVE_REQUEST_POLICY, 'https://api/x'),
        ).not.toThrow();
    });
});

describe('sleepWithinRun (#283)', () => {
    const withRemaining = (remainingMs: number): GitRequestPolicy => ({
        retries: SYNC_RETRY_PROFILE,
        deadline: {remainingMs: () => remainingMs},
    });

    it('refuses a pause the run cannot finish, BEFORE sleeping', async () => {
        vi.useFakeTimers();
        const timer = vi.spyOn(globalThis, 'setTimeout');

        await expect(
            sleepWithinRun(withRemaining(5_000), 60_000, 'https://api/x'),
        ).rejects.toThrow(GitRunDeadlineError);
        // Not "slept 5s and then gave up": spending the run's last seconds on a pause that
        // cannot finish burns the budget and still has not waited out the outage.
        expect(timer).not.toHaveBeenCalled();
    });

    it('refuses a pause that would land exactly on the deadline', async () => {
        // `>=`, not `>`: finishing the pause with zero budget left leaves no time to make the
        // request the pause exists to enable.
        await expect(sleepWithinRun(withRemaining(5_000), 5_000, 'https://api/x')).rejects.toThrow(
            GitRunDeadlineError,
        );
    });

    it('sleeps when the run can absorb the pause', async () => {
        vi.useFakeTimers();
        let settled = false;
        const pending = sleepWithinRun(withRemaining(60_000), 5_000, 'https://api/x').then(() => {
            settled = true;
        });
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        await pending;
        expect(settled).toBe(true);
    });

    it('sleeps unconditionally for a policy with no deadline', async () => {
        vi.useFakeTimers();
        const pending = sleepWithinRun(INTERACTIVE_REQUEST_POLICY, 5_000, 'https://api/x');
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(pending).resolves.toBeUndefined();
    });
});

describe('requestTimeout (#283)', () => {
    it('bounds one request at GIT_REQUEST_TIMEOUT_MS', async () => {
        vi.useFakeTimers();
        const {signal} = requestTimeout();
        expect(signal.aborted).toBe(false);

        // Just short of the timeout it is still live — without this half the assertion below
        // would pass against a signal that aborts immediately.
        await vi.advanceTimersByTimeAsync(GIT_REQUEST_TIMEOUT_MS - 1);
        expect(signal.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        // The gap this closes is silence, not slowness: a socket that connects and then stalls
        // produces neither a response nor an error, so every RETRY budget in this module — each
        // of which needs a COMPLETED attempt to count — simply never fires.
        expect(signal.aborted).toBe(true);
        expect((signal.reason as Error).name).toBe('TimeoutError');
    });

    it('never fires once cleared', async () => {
        // `clear` is not hygiene, it is correctness. `fetch` resolves on HEADERS; the body is a
        // stream the caller reads afterwards, and per the Fetch spec an abort while that stream
        // is open ERRORS it. A signal left armed past `fetch` therefore destroys a body the
        // caller has not read — and on GitHub's pre-emptive rate-limit path, which sleeps up to
        // an hour AFTER a 200 and then hands the response back, that is certain rather than
        // unlikely.
        vi.useFakeTimers();
        const {signal, clear} = requestTimeout();
        clear();

        await vi.advanceTimersByTimeAsync(GIT_REQUEST_TIMEOUT_MS * 10);
        expect(signal.aborted).toBe(false);
    });

    it('is a fresh timeout per call, so one request cannot disarm another', () => {
        vi.useFakeTimers();
        const first = requestTimeout();
        const second = requestTimeout();
        first.clear();

        vi.advanceTimersByTime(GIT_REQUEST_TIMEOUT_MS + 1);
        expect(first.signal.aborted).toBe(false);
        // Each attempt must arm its own — a shared one would leave every retry after the first
        // unbounded, which is the exact hang the timeout exists to prevent.
        expect(second.signal.aborted).toBe(true);
    });
});
