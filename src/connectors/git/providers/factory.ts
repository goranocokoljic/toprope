import type {
    GitProvider,
    GitProviderConfig,
    GitHubProviderConfig,
    BitbucketProviderConfig,
    BitbucketAppPasswordAuth,
    GitLabProviderConfig,
} from './types.js';

class NotImplementedProvider {
    constructor(public readonly name: GitProvider['name']) {}

    listRepos(): never {
        throw new Error(`${this.name} provider not yet implemented`);
    }

    getCommits(): never {
        throw new Error(`${this.name} provider not yet implemented`);
    }

    getPullRequests(): never {
        throw new Error(`${this.name} provider not yet implemented`);
    }

    getReviewComments(): never {
        throw new Error(`${this.name} provider not yet implemented`);
    }

    getCommitDiff(): never {
        throw new Error(`${this.name} provider not yet implemented`);
    }
}

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
            return new NotImplementedProvider('github') as unknown as GitProvider;
        case 'bitbucket':
            validateBitbucket(config);
            return new NotImplementedProvider('bitbucket') as unknown as GitProvider;
        case 'gitlab':
            validateGitLab(config);
            return new NotImplementedProvider('gitlab') as unknown as GitProvider;
        default: {
            const exhaustive: never = config;
            throw new Error(
                `Unsupported git provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}
