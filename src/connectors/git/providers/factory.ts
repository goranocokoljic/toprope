import type {
    GitProvider,
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

export function createGitProvider(config: GitProviderConfig): GitProvider {
    validateGitProviderConfig(config);
    switch (config.type) {
        case 'github':
            return new GitHubProvider(config);
        case 'bitbucket':
            return new BitbucketProvider(config);
        case 'gitlab':
            return new GitLabProvider(config);
        default: {
            const exhaustive: never = config;
            throw new Error(
                `Unsupported git provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}
