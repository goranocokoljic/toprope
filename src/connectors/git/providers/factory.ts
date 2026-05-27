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

function validateGitHub(config: GitHubProviderConfig): void {
    if (!config.org) {
        throw new Error('GitHub provider requires org');
    }
    if (!config.auth?.api_token) {
        throw new Error('GitHub provider requires auth.api_token');
    }
}

function validateBitbucket(config: BitbucketProviderConfig): void {
    if (!config.workspace) {
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
    if (!config.group) {
        throw new Error('GitLab provider requires group');
    }
    if (!config.auth?.token) {
        throw new Error('GitLab provider requires auth.token');
    }
}

export function createGitProvider(config: GitProviderConfig): GitProvider {
    switch (config.type) {
        case 'github':
            validateGitHub(config);
            return new GitHubProvider(config);
        case 'bitbucket':
            validateBitbucket(config);
            return new BitbucketProvider(config);
        case 'gitlab':
            validateGitLab(config);
            return new GitLabProvider(config);
        default: {
            const exhaustive: never = config;
            throw new Error(
                `Unsupported git provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}
