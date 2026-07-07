import {describe, it, expect} from 'vitest';
import {
    providerConfigToRowFields,
    rowToProviderConfig,
    GitProviderCodecError,
    type GitProviderRow,
} from '../../src/connectors/git/providers/codec';
import type {GitProviderConfig} from '../../src/connectors/git/providers/types';

// The plaintext secret for a given config — the value that would be encrypted at
// rest and passed back into rowToProviderConfig on decode.
function secretOf(config: GitProviderConfig): string {
    if (config.type === 'github') return config.auth.api_token;
    if (config.type === 'bitbucket') {
        return config.auth.type === 'app_password' ? config.auth.app_password : config.auth.token;
    }
    return config.auth.token;
}

// Encode a config to row fields, then decode it back with its secret. The row
// fields are structurally a GitProviderRow, so they feed straight back in.
function roundTrip(config: GitProviderConfig): GitProviderConfig {
    const fields = providerConfigToRowFields(config);
    return rowToProviderConfig(fields, secretOf(config));
}

describe('git provider codec — round-trips (#193)', () => {
    const cases: {name: string; config: GitProviderConfig}[] = [
        {
            name: 'github / token',
            config: {type: 'github', org: 'acme', auth: {type: 'token', api_token: 'ghp_secret1234'}},
        },
        {
            name: 'bitbucket / app_password (username + secret)',
            config: {
                type: 'bitbucket',
                workspace: 'acme-ws',
                auth: {type: 'app_password', username: 'jane', app_password: 'app-pw-5678'},
            },
        },
        {
            name: 'bitbucket / access_token',
            config: {type: 'bitbucket', workspace: 'acme-ws', auth: {type: 'access_token', token: 'bb-at-9012'}},
        },
        {
            name: 'bitbucket / oauth',
            config: {type: 'bitbucket', workspace: 'acme-ws', auth: {type: 'oauth', token: 'bb-oauth-3456'}},
        },
        {
            name: 'gitlab / personal_access_token',
            config: {type: 'gitlab', group: 'acme-grp', auth: {type: 'personal_access_token', token: 'glpat-7890'}},
        },
        {
            name: 'gitlab / oauth',
            config: {type: 'gitlab', group: 'acme-grp', auth: {type: 'oauth', token: 'gl-oauth-1234'}},
        },
        {
            name: 'gitlab / job_token',
            config: {type: 'gitlab', group: 'acme-grp', auth: {type: 'job_token', token: 'gl-job-5678'}},
        },
        {
            name: 'gitlab / self-hosted url + include_subgroups true',
            config: {
                type: 'gitlab',
                group: 'acme-grp',
                url: 'https://gitlab.internal.acme.com',
                include_subgroups: true,
                auth: {type: 'personal_access_token', token: 'glpat-selfhosted'},
            },
        },
        {
            name: 'gitlab / include_subgroups false is preserved (not dropped)',
            config: {
                type: 'gitlab',
                group: 'acme-grp',
                include_subgroups: false,
                auth: {type: 'personal_access_token', token: 'glpat-false'},
            },
        },
        {
            name: 'github with repos include + exclude lists',
            config: {
                type: 'github',
                org: 'acme',
                auth: {type: 'token', api_token: 'ghp_repos'},
                repos: ['include:api-*', 'web'],
                exclude_repos: ['legacy-*'],
            },
        },
        {
            name: 'bitbucket with repos include + exclude lists',
            config: {
                type: 'bitbucket',
                workspace: 'acme-ws',
                auth: {type: 'access_token', token: 'bb-repos'},
                repos: ['api', 'web'],
                exclude_repos: ['archive-*'],
            },
        },
        {
            name: 'gitlab with an explicit repos include list',
            config: {
                type: 'gitlab',
                group: 'acme-grp',
                auth: {type: 'job_token', token: 'gl-repos'},
                repos: ['group/api', 'group/web'],
            },
        },
    ];

    for (const {name, config} of cases) {
        it(`round-trips ${name} without loss`, () => {
            expect(roundTrip(config)).toEqual(config);
        });
    }
});

describe('git provider codec — repos scope encoding (#193)', () => {
    it('encodes undefined repos as NULL (monitor all)', () => {
        const fields = providerConfigToRowFields({
            type: 'github',
            org: 'acme',
            auth: {type: 'token', api_token: 't'},
        });
        expect(fields.repos_include).toBeNull();
        expect(fields.repos_exclude).toBeNull();
    });

    it('decodes NULL repos_include to undefined ("monitor all"), not []', () => {
        const row: GitProviderRow = {
            type: 'github',
            container: 'acme',
            url: null,
            include_subgroups: null,
            auth_method: 'token',
            auth_username: null,
            repos_include: null,
            repos_exclude: null,
        };
        const config = rowToProviderConfig(row, 'tok');
        expect(config.repos).toBeUndefined();
        expect('repos' in config).toBe(false);
    });

    it('preserves an explicit empty repos array (distinct from "monitor all")', () => {
        const config: GitProviderConfig = {
            type: 'github',
            org: 'acme',
            auth: {type: 'token', api_token: 't'},
            repos: [],
        };
        const fields = providerConfigToRowFields(config);
        expect(fields.repos_include).toBe('[]');
        expect(rowToProviderConfig(fields, 't')).toEqual(config);
    });

    it('does not decode repos_exclude for gitlab (its config has no such field)', () => {
        const row: GitProviderRow = {
            type: 'gitlab',
            container: 'acme-grp',
            url: null,
            include_subgroups: null,
            auth_method: 'personal_access_token',
            auth_username: null,
            repos_include: null,
            // A stray value here must be ignored, not crash or leak into the config.
            repos_exclude: '["should-be-ignored"]',
        };
        const config = rowToProviderConfig(row, 'glpat');
        expect('exclude_repos' in config).toBe(false);
    });
});

describe('git provider codec — fail-closed on bad rows (#193)', () => {
    const baseGithubRow: GitProviderRow = {
        type: 'github',
        container: 'acme',
        url: null,
        include_subgroups: null,
        auth_method: 'token',
        auth_username: null,
        repos_include: null,
        repos_exclude: null,
    };

    it('rejects an unknown provider type on decode', () => {
        const row = {...baseGithubRow, type: 'perforce'};
        expect(() => rowToProviderConfig(row, 'tok')).toThrow(GitProviderCodecError);
    });

    it('rejects an unknown provider type on encode', () => {
        // Force an off-union value past the type system to exercise the runtime guard.
        const bad = {type: 'perforce', org: 'x', auth: {type: 'token', api_token: 't'}} as unknown as GitProviderConfig;
        expect(() => providerConfigToRowFields(bad)).toThrow(GitProviderCodecError);
    });

    it('rejects an unknown auth_method for github', () => {
        const row = {...baseGithubRow, auth_method: 'app_password'};
        expect(() => rowToProviderConfig(row, 'tok')).toThrow(GitProviderCodecError);
    });

    it('rejects an unknown auth_method for bitbucket', () => {
        const row: GitProviderRow = {...baseGithubRow, type: 'bitbucket', auth_method: 'token'};
        expect(() => rowToProviderConfig(row, 'tok')).toThrow(GitProviderCodecError);
    });

    it('rejects an unknown auth_method for gitlab', () => {
        const row: GitProviderRow = {...baseGithubRow, type: 'gitlab', auth_method: 'app_password'};
        expect(() => rowToProviderConfig(row, 'tok')).toThrow(GitProviderCodecError);
    });

    it('rejects bitbucket app_password with a missing username', () => {
        const row: GitProviderRow = {
            ...baseGithubRow,
            type: 'bitbucket',
            auth_method: 'app_password',
            auth_username: null,
        };
        expect(() => rowToProviderConfig(row, 'app-pw')).toThrow(GitProviderCodecError);
    });

    it('rejects an out-of-range include_subgroups value', () => {
        const row: GitProviderRow = {
            ...baseGithubRow,
            type: 'gitlab',
            auth_method: 'personal_access_token',
            include_subgroups: 2,
        };
        expect(() => rowToProviderConfig(row, 'glpat')).toThrow(GitProviderCodecError);
    });

    it('rejects a malformed repos_include (not JSON)', () => {
        const row = {...baseGithubRow, repos_include: 'not-json'};
        expect(() => rowToProviderConfig(row, 'tok')).toThrow(GitProviderCodecError);
    });

    it('rejects a repos_include JSON value that is not an array of strings', () => {
        const row = {...baseGithubRow, repos_include: '[1, 2, 3]'};
        expect(() => rowToProviderConfig(row, 'tok')).toThrow(GitProviderCodecError);
    });

    it('fails factory validation when the decrypted token is empty (fail-closed)', () => {
        // An empty secret must not decode into a "valid" provider — the factory
        // validate seam rejects it.
        expect(() => rowToProviderConfig(baseGithubRow, '')).toThrow();
    });
});
