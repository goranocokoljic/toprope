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
import {
    GitProviderFetchError,
    MAX_RATE_LIMIT_DELAY_MS,
    MAX_RATE_LIMIT_RETRIES,
    MAX_SERVER_ERROR_RETRIES,
    PROBE_SERVER_ERROR_RETRIES,
    SERVER_ERROR_BASE_DELAY_MS,
    SERVER_ERROR_MAX_DELAY_MS,
    isRetryableGitFetchError,
    parseEpochResetMs,
    parseRetryAfterMs,
    rateLimitDelayMs,
    rateLimitFallbackMs,
    serverErrorDelayMs,
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
});
