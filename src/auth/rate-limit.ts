export interface RateLimitOptions {
    maxAttempts: number;
    windowMs: number;
}

export const DEFAULT_LOGIN_RATE_LIMIT: RateLimitOptions = {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000, // 15 minutes
};

/**
 * Small in-memory sliding-window limiter for failed login attempts, keyed by
 * client (IP). It throttles online password brute force without a new
 * dependency. A successful login clears the key. One instance lives per server,
 * so it resets with the process — adequate for a single-node deployment.
 */
export class LoginRateLimiter {
    private readonly failures = new Map<string, number[]>();
    private readonly maxAttempts: number;
    private readonly windowMs: number;

    constructor(options: RateLimitOptions = DEFAULT_LOGIN_RATE_LIMIT) {
        this.maxAttempts = options.maxAttempts;
        this.windowMs = options.windowMs;
    }

    private recent(key: string, now: number): number[] {
        const cutoff = now - this.windowMs;
        const times = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
        if (times.length > 0) {
            this.failures.set(key, times);
        } else {
            this.failures.delete(key);
        }
        return times;
    }

    /** True if the key has reached the failure cap within the window. */
    isLimited(key: string, now: number = Date.now()): boolean {
        return this.recent(key, now).length >= this.maxAttempts;
    }

    recordFailure(key: string, now: number = Date.now()): void {
        const times = this.recent(key, now);
        times.push(now);
        this.failures.set(key, times);
    }

    reset(key: string): void {
        this.failures.delete(key);
    }
}
