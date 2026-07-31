/**
 * #283 — the request POLICY every provider client carries: caller-intent retry budgets and the
 * run's wall clock.
 *
 * Table-driven over all three provider types, deliberately. The three fetch loops are
 * near-identical clones (collapsing them is #284), so a per-provider copy of these cases would
 * be the third copy of a third copy — and the failure mode that actually matters is one
 * provider being MISSED when the policy changes. Every case below therefore runs against every
 * type that `createGitProvider` builds, exactly as `diffs-contract.test.ts` does for
 * `GitCommit.diffs`.
 *
 * `listRepos()` is the call under test throughout, because it is the one #283 changed: the
 * pre-#283 interactive budget was a per-CALL argument only `checkAccess` passed, so this method
 * — reached by the admin repo picker and by `toprope doctor` — took a SYNC's budget on a path
 * where a human is waiting inside one HTTP request.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import {createGitProvider} from '../../../../src/connectors/git/providers/factory';
import type {
    GitProviderConfig,
    GitProviderType,
} from '../../../../src/connectors/git/providers/types';
import type {GitRequestPolicy} from '../../../../src/connectors/git/providers/http-retry';
import {
    GIT_REQUEST_TIMEOUT_MS,
    GitRunDeadlineError,
    INTERACTIVE_REQUEST_POLICY,
    MAX_RATE_LIMIT_RETRIES,
    SYNC_RETRY_PROFILE,
} from '../../../../src/connectors/git/providers/http-retry';
import {
    BITBUCKET_CONFIG,
    GITHUB_CONFIG,
    GITLAB_CONFIG,
} from './provider-fetch-fixtures';

interface ProviderCase {
    type: GitProviderType;
    config: GitProviderConfig;
    /** The provider's own wording for an exhausted 5xx, so the assertion cannot pass by luck. */
    serverErrorMessage: RegExp;
}

const CASES: ProviderCase[] = [
    {type: 'github', config: GITHUB_CONFIG, serverErrorMessage: /GitHub API server error 503/},
    {
        type: 'bitbucket',
        config: BITBUCKET_CONFIG,
        serverErrorMessage: /Bitbucket API server error 503/,
    },
    {type: 'gitlab', config: GITLAB_CONFIG, serverErrorMessage: /GitLab API server error 503/},
];

/** A `fetch` stub that answers every request with `status`, and logs the calls. */
function stubStatus(status: number, headers: Record<string, string> = {}): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockImplementation(() =>
        Promise.resolve({
            ok: false,
            status,
            headers: new Headers(headers),
            json: () => Promise.resolve([]),
            text: () => Promise.resolve('boom'),
        } as unknown as Response),
    );
    vi.stubGlobal('fetch', mock);
    return mock;
}

/** A policy with a run deadline whose remaining budget the test controls directly. */
function syncPolicyWithRemaining(remainingMs: number): GitRequestPolicy {
    return {retries: SYNC_RETRY_PROFILE, deadline: {remainingMs: () => remainingMs}};
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe.each(CASES)('$type request policy (#283)', ({config, serverErrorMessage}) => {
    describe('interactive budget on listRepos', () => {
        it('fails a 5xx on the first response instead of taking a sync budget', async () => {
            vi.useFakeTimers();
            const fetchMock = stubStatus(503);

            const pending = createGitProvider(config, {
                policy: INTERACTIVE_REQUEST_POLICY,
            }).listRepos();
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toThrow(serverErrorMessage);
            expect(fetchMock.mock.calls).toHaveLength(1);
        });

        it('fails a 429 on the first response, without waiting out the reset', async () => {
            vi.useFakeTimers();
            // `Retry-After: 3600` is what makes this the case that matters: on a sync budget
            // the client honours it, three times, up to MAX_RATE_LIMIT_DELAY_MS each — three
            // hours of sleeping inside the one HTTP request the repo picker is blocked on.
            const fetchMock = stubStatus(429, {'retry-after': '3600'});

            const pending = createGitProvider(config, {
                policy: INTERACTIVE_REQUEST_POLICY,
            }).listRepos();
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toThrow(/Rate limit exceeded after 0 retries/);
            expect(fetchMock.mock.calls).toHaveLength(1);
        });

        it('POSITIVE CONTROL: a sync client does wait out that same 429', async () => {
            // Without this the two assertions above would stay green if `listRepos` stopped
            // retrying for EVERY caller — which would silently undo #272's retry cover on the
            // single highest-leverage request a sync makes.
            vi.useFakeTimers();
            const fetchMock = stubStatus(429, {'retry-after': '3600'});

            const pending = createGitProvider(config).listRepos();
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toThrow(
                new RegExp(`Rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`),
            );
            expect(fetchMock.mock.calls).toHaveLength(1 + MAX_RATE_LIMIT_RETRIES);
        });
    });

    describe('run wall clock', () => {
        it('issues NO request once the run deadline has passed', async () => {
            const fetchMock = stubStatus(200);

            await expect(
                createGitProvider(config, {policy: syncPolicyWithRemaining(-1)}).listRepos(),
            ).rejects.toThrow(GitRunDeadlineError);
            // Checked per attempt, not only before a pause: a run that exhausted its clock on
            // promptly-answered work must stop doing work, not merely stop sleeping.
            expect(fetchMock.mock.calls).toHaveLength(0);
        });

        it('refuses a 5xx retry pause the remaining budget cannot absorb', async () => {
            vi.useFakeTimers();
            // 100 ms left against a first 5xx pause of at least SERVER_ERROR_BASE_DELAY_MS/2
            // (2.5 s at minimum jitter) — the pause is refused rather than truncated.
            const fetchMock = stubStatus(503);

            const pending = createGitProvider(config, {
                policy: syncPolicyWithRemaining(100),
            }).listRepos();
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toThrow(GitRunDeadlineError);
            // The attempt happened; only the retry was refused.
            expect(fetchMock.mock.calls).toHaveLength(1);
        });

        it('leaves the budget alone while time remains', async () => {
            vi.useFakeTimers();
            const fetchMock = stubStatus(503);

            const pending = createGitProvider(config, {
                policy: syncPolicyWithRemaining(60 * 60_000),
            }).listRepos();
            void pending.catch(() => {});
            await vi.runAllTimersAsync();

            await expect(pending).rejects.toThrow(serverErrorMessage);
            expect(fetchMock.mock.calls).toHaveLength(1 + SYNC_RETRY_PROFILE.transient);
        });
    });

    it('bounds every request with an abort signal', async () => {
        vi.useFakeTimers();
        const fetchMock = stubStatus(503);

        // The interactive policy never retries, so this settles with no timer to drain — which
        // matters here: `runAllTimersAsync()` would also fire the request timeout below and
        // the "live at issue time" half of the assertion could not fail.
        await expect(
            createGitProvider(config, {policy: INTERACTIVE_REQUEST_POLICY}).listRepos(),
        ).rejects.toThrow(serverErrorMessage);

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const signal = init.signal as AbortSignal;
        expect(signal).toBeInstanceOf(AbortSignal);
        // Live at issue time and aborting at the bound — a socket that connects and then
        // stalls produces no response at all, so no RETRY budget can ever fire for it.
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(GIT_REQUEST_TIMEOUT_MS + 1);
        expect(signal.aborted).toBe(true);
    });
});
