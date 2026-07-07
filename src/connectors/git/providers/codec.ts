import type {
    GitProviderConfig,
    GitProviderType,
    GitHubProviderConfig,
    BitbucketProviderConfig,
    GitLabProviderConfig,
} from './types.js';
import {validateGitProviderConfig} from './factory.js';

/**
 * Lossless codec between a `git_providers` DB row and the `GitProviderConfig`
 * union the factory validates (GC1.1 / #193). The persistence spine: encode a
 * validated config into the provider-shape columns on write, decode an
 * (untrusted) row plus its decrypted token back into a config on read.
 *
 * Fail-closed: an unknown `type` or `auth_method`, a missing bitbucket
 * app_password username, or a malformed repos JSON array throws a typed
 * {@link GitProviderCodecError} rather than producing a partial/permissive
 * config. The decoded config is additionally run through the factory's
 * `validate*` seam so a decoded provider is guaranteed to be one the pipeline
 * accepts.
 */
export class GitProviderCodecError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GitProviderCodecError';
    }
}

/**
 * The provider-shape columns the codec reads back. Token columns
 * (`token_ciphertext`/`token_meta`/`token_last4`) and lifecycle/audit columns
 * (`id`/`enabled`/`created_at`/…) are owned by the store, not the codec — the
 * decrypted secret is passed to {@link rowToProviderConfig} separately.
 */
export interface GitProviderRow {
    type: string;
    container: string;
    url: string | null;
    include_subgroups: number | null;
    auth_method: string;
    auth_username: string | null;
    repos_include: string | null;
    repos_exclude: string | null;
}

/**
 * The provider-shape column values {@link providerConfigToRowFields} produces
 * from a config — everything except the encrypted token columns and the
 * lifecycle/audit columns. A well-typed subset of {@link GitProviderRow}.
 */
export interface GitProviderRowFields {
    type: GitProviderType;
    container: string;
    url: string | null;
    include_subgroups: number | null;
    auth_method: string;
    auth_username: string | null;
    repos_include: string | null;
    repos_exclude: string | null;
}

// Encode a repos list: undefined -> NULL ("monitor all"); an explicit (even
// empty) array is preserved verbatim as a JSON string so it round-trips as-is.
function reposToJson(repos: string[] | undefined): string | null {
    return repos === undefined ? null : JSON.stringify(repos);
}

// Decode a repos column: NULL -> undefined ("monitor all"). A non-NULL value
// must be a JSON array of strings, or we fail closed.
function jsonToRepos(value: string | null, column: string): string[] | undefined {
    if (value === null) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new GitProviderCodecError(`git_providers.${column} is not valid JSON`);
    }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new GitProviderCodecError(`git_providers.${column} must be a JSON array of strings`);
    }
    return parsed as string[];
}

/**
 * Encode a validated config into the provider-shape column values (minus the
 * encrypted token, which the store encrypts and writes separately).
 */
export function providerConfigToRowFields(config: GitProviderConfig): GitProviderRowFields {
    switch (config.type) {
        case 'github':
            return {
                type: 'github',
                container: config.org,
                url: null,
                include_subgroups: null,
                auth_method: config.auth.type,
                auth_username: null,
                repos_include: reposToJson(config.repos),
                repos_exclude: reposToJson(config.exclude_repos),
            };
        case 'bitbucket':
            return {
                type: 'bitbucket',
                container: config.workspace,
                url: null,
                include_subgroups: null,
                auth_method: config.auth.type,
                auth_username: config.auth.type === 'app_password' ? config.auth.username : null,
                repos_include: reposToJson(config.repos),
                repos_exclude: reposToJson(config.exclude_repos),
            };
        case 'gitlab':
            return {
                type: 'gitlab',
                container: config.group,
                url: config.url ?? null,
                include_subgroups:
                    config.include_subgroups === undefined ? null : config.include_subgroups ? 1 : 0,
                auth_method: config.auth.type,
                auth_username: null,
                repos_include: reposToJson(config.repos),
                // GitLab's config has no exclude_repos field — nothing to encode.
                repos_exclude: null,
            };
        default: {
            const exhaustive: never = config;
            throw new GitProviderCodecError(
                `Cannot encode unknown git provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}

// Bitbucket app_password requires the username stored alongside the secret; a
// missing one is a corrupt row, so fail closed.
function requireUsername(username: string | null): string {
    if (username === null || username === '') {
        throw new GitProviderCodecError(
            'git_providers row for bitbucket app_password auth is missing auth_username',
        );
    }
    return username;
}

// Decode the nullable 0/1 include_subgroups column into an optional boolean,
// failing closed on any other integer.
function decodeIncludeSubgroups(value: number | null): boolean | undefined {
    if (value === null) return undefined;
    if (value === 1) return true;
    if (value === 0) return false;
    throw new GitProviderCodecError(
        `git_providers.include_subgroups must be 0, 1 or NULL (got ${value})`,
    );
}

function rowToGitHubConfig(row: GitProviderRow, token: string): GitHubProviderConfig {
    if (row.auth_method !== 'token') {
        throw new GitProviderCodecError(
            `github provider has unsupported auth_method "${row.auth_method}"`,
        );
    }
    const config: GitHubProviderConfig = {
        type: 'github',
        org: row.container,
        auth: {type: 'token', api_token: token},
    };
    const repos = jsonToRepos(row.repos_include, 'repos_include');
    if (repos !== undefined) config.repos = repos;
    const excludeRepos = jsonToRepos(row.repos_exclude, 'repos_exclude');
    if (excludeRepos !== undefined) config.exclude_repos = excludeRepos;
    return config;
}

function rowToBitbucketConfig(row: GitProviderRow, token: string): BitbucketProviderConfig {
    let auth: BitbucketProviderConfig['auth'];
    switch (row.auth_method) {
        case 'app_password':
            auth = {type: 'app_password', username: requireUsername(row.auth_username), app_password: token};
            break;
        case 'access_token':
            auth = {type: 'access_token', token};
            break;
        case 'oauth':
            auth = {type: 'oauth', token};
            break;
        default:
            throw new GitProviderCodecError(
                `bitbucket provider has unsupported auth_method "${row.auth_method}"`,
            );
    }
    const config: BitbucketProviderConfig = {type: 'bitbucket', workspace: row.container, auth};
    const repos = jsonToRepos(row.repos_include, 'repos_include');
    if (repos !== undefined) config.repos = repos;
    const excludeRepos = jsonToRepos(row.repos_exclude, 'repos_exclude');
    if (excludeRepos !== undefined) config.exclude_repos = excludeRepos;
    return config;
}

function rowToGitLabConfig(row: GitProviderRow, token: string): GitLabProviderConfig {
    let auth: GitLabProviderConfig['auth'];
    switch (row.auth_method) {
        case 'personal_access_token':
            auth = {type: 'personal_access_token', token};
            break;
        case 'oauth':
            auth = {type: 'oauth', token};
            break;
        case 'job_token':
            auth = {type: 'job_token', token};
            break;
        default:
            throw new GitProviderCodecError(
                `gitlab provider has unsupported auth_method "${row.auth_method}"`,
            );
    }
    const config: GitLabProviderConfig = {type: 'gitlab', group: row.container, auth};
    if (row.url !== null) config.url = row.url;
    const includeSubgroups = decodeIncludeSubgroups(row.include_subgroups);
    if (includeSubgroups !== undefined) config.include_subgroups = includeSubgroups;
    const repos = jsonToRepos(row.repos_include, 'repos_include');
    if (repos !== undefined) config.repos = repos;
    return config;
}

/**
 * Decode an (untrusted) `git_providers` row plus its already-decrypted token
 * back into a `GitProviderConfig`. Fail-closed on unknown type/auth_method or a
 * malformed row; the result is run through the factory's `validate*` seam so a
 * decoded config is guaranteed to be one the pipeline accepts.
 */
export function rowToProviderConfig(row: GitProviderRow, decryptedToken: string): GitProviderConfig {
    let config: GitProviderConfig;
    switch (row.type) {
        case 'github':
            config = rowToGitHubConfig(row, decryptedToken);
            break;
        case 'bitbucket':
            config = rowToBitbucketConfig(row, decryptedToken);
            break;
        case 'gitlab':
            config = rowToGitLabConfig(row, decryptedToken);
            break;
        default:
            throw new GitProviderCodecError(`Cannot decode unknown git provider type: "${row.type}"`);
    }
    // The decoded config must be one the existing factory accepts — reuse the
    // canonical validation seam rather than re-checking here.
    validateGitProviderConfig(config);
    return config;
}
