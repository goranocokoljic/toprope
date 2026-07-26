import {describe, it, expect, afterEach} from 'vitest';
import {
    providerContainer,
    resolveGitProviderConfigs,
} from '../../../../src/connectors/git/providers/config';
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

    // Deliberately KEPT: `doctor` resolves through here in order to report a malformed entry
    // by name ("bitbucket provider with no workspace"), so this resolver must not swallow it.
    // The sync pipeline guards itself instead — see the container-less provider tests in
    // tests/connectors/git/sync.test.ts.
    it('keeps an entry with a type but no container, so doctor can diagnose it', () => {
        const resolved = resolveGitProviderConfigs({
            enabled: true,
            providers: [{type: 'bitbucket', auth: {type: 'oauth', token: 't'}}],
        });
        expect(resolved).toHaveLength(1);
        // '' — not `undefined` — since #266: `providerContainer` normalizes, and that
        // normalization is TOTAL over the untrusted config entries this resolver
        // deliberately passes through. A missing container becomes the blank container the
        // write guards refuse by name, instead of `undefined` leaking into a
        // `${type}:${container}` cursor key (or throwing where sync builds those keys,
        // which is outside its per-provider try/catch).
        expect(providerContainer(resolved[0])).toBe('');
    });

    it('normalizes case and surrounding whitespace on every provider type (#266)', () => {
        const resolved = resolveGitProviderConfigs({
            enabled: true,
            providers: [
                {type: 'github', org: '  Wireless_Media ', auth: {type: 'token', api_token: 't'}},
                {type: 'bitbucket', workspace: 'ACME-WS', auth: {type: 'oauth', token: 't'}},
                {type: 'gitlab', group: ' Platform\t', auth: {type: 'oauth', token: 't'}},
            ],
        });
        expect(resolved.map((c) => providerContainer(c))).toEqual([
            'wireless_media',
            'acme-ws',
            'platform',
        ]);
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
