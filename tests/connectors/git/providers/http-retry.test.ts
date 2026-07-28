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
    MAX_SERVER_ERROR_RETRIES,
    SERVER_ERROR_BASE_DELAY_MS,
    SERVER_ERROR_MAX_DELAY_MS,
    isRetryableGitFetchError,
    parseRetryAfterMs,
    serverErrorDelayMs,
} from '../../../../src/connectors/git/providers/http-retry';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('parseRetryAfterMs', () => {
    it('parses the delta-seconds form providers actually send', () => {
        expect(parseRetryAfterMs('30')).toBe(30_000);
        expect(parseRetryAfterMs('0')).toBe(0);
        expect(parseRetryAfterMs('1.5')).toBe(1_500);
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

    it('honors Retry-After exactly, without jittering it downward', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(serverErrorDelayMs(0, '45')).toBe(45_000);
        // Also on a late attempt, where the exponential figure would be larger — the server's
        // number wins either way.
        expect(serverErrorDelayMs(4, '7')).toBe(7_000);
    });

    it('caps Retry-After so a hostile header cannot park the run', () => {
        expect(serverErrorDelayMs(0, '86400')).toBe(SERVER_ERROR_MAX_DELAY_MS);
    });

    it('falls back to backoff when Retry-After is unusable', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(serverErrorDelayMs(1, 'not-a-date')).toBe(SERVER_ERROR_BASE_DELAY_MS * 2);
    });
});

describe('isRetryableGitFetchError', () => {
    it('treats 5xx and 429 as worth a longer pause', () => {
        for (const status of [500, 502, 503, 504, 429]) {
            expect(isRetryableGitFetchError(new GitProviderFetchError('boom', status))).toBe(true);
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
        for (const status of [400, 401, 403, 404, 422]) {
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
