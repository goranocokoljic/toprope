import {describe, it, expect, afterEach} from 'vitest';
import {resolveGitProviderConfigs} from '../../../../src/connectors/git/providers/config';
import type {GitConnectorConfig} from '../../../../src/config/types';

describe('resolveGitProviderConfigs', () => {
    const savedToken = process.env.GITHUB_TOKEN;

    afterEach(() => {
        if (savedToken === undefined) {
            delete process.env.GITHUB_TOKEN;
        } else {
            process.env.GITHUB_TOKEN = savedToken;
        }
    });

    it('returns the explicit providers array when present', () => {
        const config: GitConnectorConfig = {
            enabled: true,
            providers: [
                {type: 'bitbucket', workspace: 'ws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
                {type: 'github', org: 'o', auth: {type: 'token', api_token: 't'}},
            ],
        };
        const resolved = resolveGitProviderConfigs(config);
        expect(resolved.map((p) => p.type)).toEqual(['bitbucket', 'github']);
    });

    it('filters out malformed providers entries without a type', () => {
        const config: GitConnectorConfig = {
            enabled: true,
            providers: [{type: 'github', org: 'o', auth: {type: 'token', api_token: 't'}}, {nope: true}],
        };
        const resolved = resolveGitProviderConfigs(config);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].type).toBe('github');
    });

    it('falls back to the github shorthand when org + token are set', () => {
        delete process.env.GITHUB_TOKEN;
        const config: GitConnectorConfig = {enabled: true, org: 'myorg', api_token: 'mytoken', repos: ['r']};
        const resolved = resolveGitProviderConfigs(config);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({type: 'github', org: 'myorg'});
    });

    it('returns empty when the shorthand is missing org or token', () => {
        delete process.env.GITHUB_TOKEN;
        expect(resolveGitProviderConfigs({enabled: true, org: 'myorg'})).toEqual([]);
        expect(resolveGitProviderConfigs({enabled: true, api_token: 't'})).toEqual([]);
        expect(resolveGitProviderConfigs({enabled: true})).toEqual([]);
    });
});
