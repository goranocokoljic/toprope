import type {
    GitProvider,
    GitProviderClientOptions,
    GitProviderConfig,
    GitHubProviderConfig,
    BitbucketProviderConfig,
    BitbucketAppPasswordAuth,
    GitLabProviderConfig,
} from './types.js';
import {GitHubProvider} from './github.js';
import {BitbucketProvider} from './bitbucket.js';
import {GitLabProvider} from './gitlab.js';
import {isBlankContainer} from './container.js';

// The container checks below use `isBlankContainer`, not `!config.org` (#266): a plain
// truthiness test passes '   ', which then reaches the pipeline as a real container and — since
// #264 — as a real attribution key. This is the canonical validation seam `createGitProvider`
// runs on every sync/probe path, so closing it here also stops a whitespace-only org from
// being fetched under, not just from being stored.
function validateGitHub(config: GitHubProviderConfig): void {
    if (isBlankContainer(config.org)) {
        throw new Error('GitHub provider requires org');
    }
    if (!config.auth?.api_token) {
        throw new Error('GitHub provider requires auth.api_token');
    }
}

function validateBitbucket(config: BitbucketProviderConfig): void {
    if (isBlankContainer(config.workspace)) {
        throw new Error('Bitbucket provider requires workspace');
    }
    if (config.auth.type === 'app_password') {
        const auth = config.auth as BitbucketAppPasswordAuth;
        if (!auth.username) {
            throw new Error('Bitbucket app_password auth requires username');
        }
        if (!auth.app_password) {
            throw new Error('Bitbucket app_password auth requires app_password');
        }
    } else if (!config.auth.token) {
        throw new Error(`Bitbucket ${config.auth.type} auth requires token`);
    }
}

function validateGitLab(config: GitLabProviderConfig): void {
    if (isBlankContainer(config.group)) {
        throw new Error('GitLab provider requires group');
    }
    if (!config.auth?.token) {
        throw new Error('GitLab provider requires auth.token');
    }
    if (config.url !== undefined) {
        let parsed: URL;
        try {
            parsed = new URL(config.url);
        } catch {
            throw new Error('GitLab provider url must be a valid URL');
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error('GitLab provider url must use http or https scheme');
        }
        // Reject userinfo (#272 review cycle 2, SEC-5). `GitLabProvider` keeps `config.url`
        // verbatim as `this.baseUrl` and interpolates it into every error message it throws —
        // and those messages are persisted to `sync_logs.errors` / `git_providers.last_sync_error`
        // and returned verbatim to any admin by the test-connection route. A token embedded as
        // `https://oauth2:glpat-xxx@gitlab.internal` would therefore leak to admins who never
        // supplied it. Credentials belong in `auth`, which is encrypted at rest.
        if (parsed.username !== '' || parsed.password !== '') {
            throw new Error(
                'GitLab provider url must not embed credentials — put the token in auth.token',
            );
        }
    }
}

// Validate a provider config with the per-type rules, fail-closed on an
// unknown type. This is the single canonical validation seam — `createGitProvider`
// and any write path (e.g. the git_providers codec, #193) reuse it rather than
// re-implementing provider validation.
export function validateGitProviderConfig(config: GitProviderConfig): void {
    switch (config.type) {
        case 'github':
            validateGitHub(config);
            return;
        case 'bitbucket':
            validateBitbucket(config);
            return;
        case 'gitlab':
            validateGitLab(config);
            return;
        default: {
            const exhaustive: never = config;
            throw new Error(
                `Unsupported git provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}

/**
 * Build the provider client for a config.
 *
 * `options.diffstatCache` (#273) is the persistent per-commit diffstat memo the client
 * consults instead of re-fetching. OPTIONAL, and omitted by every non-sync caller on purpose:
 * `toprope doctor`, the admin test-connection route and the repo-listing route are probes that
 * never walk commits, so handing them a cache would be dead weight. Only the sync pipeline
 * supplies one — it is also the only caller that has resolved the `(type, container)` scope
 * the cache must be keyed by.
 *
 * `options.policy` (#283) is how much this client may sleep inside one request, and — for a
 * sync — the run deadline every request measures itself against. This is the ONLY place the
 * distinction is made, which is the point: before #283 the interactive budget was a per-CALL
 * argument that only `checkAccess` passed, so `listRepos()` on the admin repo picker and in
 * `toprope doctor` silently took a sync's budget. Binding it to the client makes the two
 * kinds of caller structurally distinct instead of relying on every call site to remember.
 * Defaulting to the SYNC policy (see {@link GitProviderClientOptions}) means an omission can
 * only ever be over-patient, never a silent weakening of #272's retry cover.
 */
export function createGitProvider(
    config: GitProviderConfig,
    options: GitProviderClientOptions = {},
): GitProvider {
    validateGitProviderConfig(config);
    switch (config.type) {
        case 'github':
            return new GitHubProvider(config, options);
        case 'bitbucket':
            return new BitbucketProvider(config, options);
        case 'gitlab':
            return new GitLabProvider(config, options);
        default: {
            const exhaustive: never = config;
            throw new Error(
                `Unsupported git provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}
