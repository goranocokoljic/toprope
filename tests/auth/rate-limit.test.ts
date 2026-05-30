import {describe, it, expect} from 'vitest';
import {LoginRateLimiter} from '../../src/auth/rate-limit';

describe('LoginRateLimiter', () => {
    it('permits attempts below the cap and blocks at the cap', () => {
        const limiter = new LoginRateLimiter({maxAttempts: 3, windowMs: 60_000});
        expect(limiter.isLimited('ip')).toBe(false);
        limiter.recordFailure('ip');
        limiter.recordFailure('ip');
        expect(limiter.isLimited('ip')).toBe(false);
        limiter.recordFailure('ip');
        expect(limiter.isLimited('ip')).toBe(true);
    });

    it('reset clears a blocked key (successful login)', () => {
        const limiter = new LoginRateLimiter({maxAttempts: 2, windowMs: 60_000});
        limiter.recordFailure('ip');
        limiter.recordFailure('ip');
        expect(limiter.isLimited('ip')).toBe(true);
        limiter.reset('ip');
        expect(limiter.isLimited('ip')).toBe(false);
    });

    it('forgets failures older than the window', () => {
        const limiter = new LoginRateLimiter({maxAttempts: 2, windowMs: 1_000});
        const t0 = 10_000;
        limiter.recordFailure('ip', t0);
        limiter.recordFailure('ip', t0);
        expect(limiter.isLimited('ip', t0)).toBe(true);
        // Past the window, the old failures no longer count.
        expect(limiter.isLimited('ip', t0 + 2_000)).toBe(false);
    });

    it('tracks keys independently', () => {
        const limiter = new LoginRateLimiter({maxAttempts: 1, windowMs: 60_000});
        limiter.recordFailure('a');
        expect(limiter.isLimited('a')).toBe(true);
        expect(limiter.isLimited('b')).toBe(false);
    });
});
