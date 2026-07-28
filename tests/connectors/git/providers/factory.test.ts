import {describe, it, expect} from 'vitest';
import {createGitProvider} from '../../../../src/connectors/git/providers/factory';
import type {GitProviderConfig} from '../../../../src/connectors/git/providers/types';

const validGitHub: GitProviderConfig = {
    type: 'github',
    org: 'test-org',
    auth: {type: 'token', api_token: 'ghp_test'},
};

const validBitbucket: GitProviderConfig = {
    type: 'bitbucket',
    workspace: 'test-workspace',
    auth: {type: 'app_password', username: 'test-user', app_password: 'test-pass'},
};

const validGitLab: GitProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    auth: {type: 'personal_access_token', token: 'glpat-test'},
};

describe('createGitProvider', () => {
    describe('github', () => {
        it('creates a github provider with correct name', () => {
            const provider = createGitProvider(validGitHub);
            expect(provider.name).toBe('github');
        });

        it('throws when org is missing', () => {
            expect(() =>
                createGitProvider({...validGitHub, org: ''} as GitProviderConfig),
            ).toThrow('GitHub provider requires org');
        });

        // #266: '   ' is truthy, so the old `!config.org` check accepted it and the pipeline
        // then fetched (and attributed rows) under a blank container.
        it('throws when org is only whitespace', () => {
            expect(() =>
                createGitProvider({...validGitHub, org: '   '} as GitProviderConfig),
            ).toThrow('GitHub provider requires org');
            expect(() =>
                createGitProvider({...validGitHub, org: '\t\n'} as GitProviderConfig),
            ).toThrow('GitHub provider requires org');
        });

        it('throws when api_token is missing', () => {
            expect(() =>
                createGitProvider({
                    type: 'github',
                    org: 'test-org',
                    auth: {type: 'token', api_token: ''},
                }),
            ).toThrow('GitHub provider requires auth.api_token');
        });
    });

    describe('bitbucket', () => {
        it('creates a bitbucket provider with correct name', () => {
            const provider = createGitProvider(validBitbucket);
            expect(provider.name).toBe('bitbucket');
        });

        it('throws when workspace is missing', () => {
            expect(() =>
                createGitProvider({...validBitbucket, workspace: ''} as GitProviderConfig),
            ).toThrow('Bitbucket provider requires workspace');
        });

        it('throws when workspace is only whitespace (#266)', () => {
            expect(() =>
                createGitProvider({...validBitbucket, workspace: '  '} as GitProviderConfig),
            ).toThrow('Bitbucket provider requires workspace');
        });

        it('throws when app_password username is missing', () => {
            expect(() =>
                createGitProvider({
                    type: 'bitbucket',
                    workspace: 'ws',
                    auth: {type: 'app_password', username: '', app_password: 'pass'},
                }),
            ).toThrow('Bitbucket app_password auth requires username');
        });

        it('throws when app_password is missing', () => {
            expect(() =>
                createGitProvider({
                    type: 'bitbucket',
                    workspace: 'ws',
                    auth: {type: 'app_password', username: 'user', app_password: ''},
                }),
            ).toThrow('Bitbucket app_password auth requires app_password');
        });

        it('creates with access_token auth', () => {
            const provider = createGitProvider({
                type: 'bitbucket',
                workspace: 'ws',
                auth: {type: 'access_token', token: 'tok'},
            });
            expect(provider.name).toBe('bitbucket');
        });

        it('throws when access_token token is missing', () => {
            expect(() =>
                createGitProvider({
                    type: 'bitbucket',
                    workspace: 'ws',
                    auth: {type: 'access_token', token: ''},
                }),
            ).toThrow('Bitbucket access_token auth requires token');
        });
    });

    describe('gitlab', () => {
        it('creates a gitlab provider with correct name', () => {
            const provider = createGitProvider(validGitLab);
            expect(provider.name).toBe('gitlab');
        });

        it('throws when group is missing', () => {
            expect(() =>
                createGitProvider({...validGitLab, group: ''} as GitProviderConfig),
            ).toThrow('GitLab provider requires group');
        });

        it('throws when group is only whitespace (#266)', () => {
            expect(() =>
                createGitProvider({...validGitLab, group: ' \t '} as GitProviderConfig),
            ).toThrow('GitLab provider requires group');
        });

        it('throws when token is missing', () => {
            expect(() =>
                createGitProvider({
                    type: 'gitlab',
                    group: 'grp',
                    auth: {type: 'personal_access_token', token: ''},
                }),
            ).toThrow('GitLab provider requires auth.token');
        });

        it('creates with oauth auth', () => {
            const provider = createGitProvider({
                type: 'gitlab',
                group: 'grp',
                auth: {type: 'oauth', token: 'oauth-tok'},
            });
            expect(provider.name).toBe('gitlab');
        });

        it('creates with job_token auth', () => {
            const provider = createGitProvider({
                type: 'gitlab',
                group: 'grp',
                auth: {type: 'job_token', token: 'job-tok'},
            });
            expect(provider.name).toBe('gitlab');
        });

        it('accepts valid https url', () => {
            const provider = createGitProvider({
                ...validGitLab,
                url: 'https://gitlab.example.com',
            });
            expect(provider.name).toBe('gitlab');
        });

        it('throws when url is not a valid URL', () => {
            expect(() =>
                createGitProvider({
                    ...validGitLab,
                    url: 'not-a-url',
                }),
            ).toThrow('GitLab provider url must be a valid URL');
        });

        it('throws when url uses a non-http scheme', () => {
            expect(() =>
                createGitProvider({
                    ...validGitLab,
                    url: 'ftp://gitlab.example.com',
                }),
            ).toThrow('GitLab provider url must use http or https scheme');
        });

        it('rejects a url embedding credentials (#272)', () => {
            // The provider keeps `url` verbatim as its baseUrl and interpolates it into every
            // error it throws — and those messages are persisted to sync_logs / last_sync_error
            // and returned verbatim to any admin by the test-connection route. A token in the URL
            // would leak to admins who never supplied it.
            expect(() =>
                createGitProvider({
                    ...validGitLab,
                    url: 'https://oauth2:glpat-secret@gitlab.internal',
                }),
            ).toThrow('must not embed credentials');
            expect(() =>
                createGitProvider({...validGitLab, url: 'https://someuser@gitlab.internal'}),
            ).toThrow('must not embed credentials');
        });

        it('still accepts a plain self-managed url', () => {
            expect(
                createGitProvider({...validGitLab, url: 'https://gitlab.internal:8443/'}).name,
            ).toBe('gitlab');
        });
    });

    describe('invalid provider type', () => {
        it('throws a descriptive error for unknown provider type', () => {
            expect(() =>
                createGitProvider({type: 'azure'} as unknown as GitProviderConfig),
            ).toThrow('Unsupported git provider type: "azure"');
        });
    });

    describe('provider method availability', () => {
        it('github provider exposes all required GitProvider methods', () => {
            const provider = createGitProvider(validGitHub);
            expect(typeof provider.listRepos).toBe('function');
            expect(typeof provider.getCommits).toBe('function');
            expect(typeof provider.getPullRequests).toBe('function');
            expect(typeof provider.getReviewComments).toBe('function');
            expect(typeof provider.getCommitDiff).toBe('function');
            expect(typeof provider.checkAccess).toBe('function');
        });

        it('bitbucket provider exposes all required GitProvider methods', () => {
            const provider = createGitProvider(validBitbucket);
            expect(typeof provider.listRepos).toBe('function');
            expect(typeof provider.getCommits).toBe('function');
            expect(typeof provider.getPullRequests).toBe('function');
            expect(typeof provider.getReviewComments).toBe('function');
            expect(typeof provider.getCommitDiff).toBe('function');
            expect(typeof provider.checkAccess).toBe('function');
        });

        it('gitlab provider exposes all required GitProvider methods', () => {
            const provider = createGitProvider(validGitLab);
            expect(typeof provider.listRepos).toBe('function');
            expect(typeof provider.getCommits).toBe('function');
            expect(typeof provider.getPullRequests).toBe('function');
            expect(typeof provider.getReviewComments).toBe('function');
            expect(typeof provider.getCommitDiff).toBe('function');
            expect(typeof provider.checkAccess).toBe('function');
        });
    });
});
