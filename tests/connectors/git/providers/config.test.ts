import {describe, it, expect, afterEach} from 'vitest';
import {
    containerKey,
    containerKeyOf,
    providerContainer,
    resolveGitProviderConfigs,
} from '../../../../src/connectors/git/providers/config';
import type {GitConnectorConfig} from '../../../../src/config/types';
import type {GitProviderConfig} from '../../../../src/connectors/git/providers/types';

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

    it('returns the blank container for a provider type this build does not know (#266)', () => {
        // `resolveGitProviderConfigs` filters only on `typeof p.type === 'string'`, so a YAML
        // `type: gitea` reaches `providerContainer` — and `containerKey` on it feeds
        // `runSync`'s config-owned-keys set, which is built OUTSIDE the per-provider try/catch.
        // Total, so it yields the blank container every write guard refuses by name rather than
        // throwing there or leaking `undefined` into a `${type}:${container}` key.
        const unknown = {type: 'gitea', org: 'Acme'} as unknown as GitProviderConfig;
        expect(providerContainer(unknown)).toBe('');
        expect(containerKey(unknown)).toBe('gitea:');
    });

    it('leaves the YAML container VERBATIM, so doctor reports what the operator wrote (#266)', () => {
        // Normalization deliberately does NOT happen here. It happens at the two places the value
        // is USED — `providerContainer` (attribution, cursors, the stored row) and each provider
        // client's constructor (the API request path) — both from the same shared helper, so they
        // cannot disagree. Rewriting the entry here would additionally make `doctor` print a
        // spelling the operator never typed.
        const resolved = resolveGitProviderConfigs({
            enabled: true,
            providers: [
                {type: 'github', org: '  Wireless_Media ', auth: {type: 'token', api_token: 't'}},
                {type: 'bitbucket', workspace: 'ACME-WS', auth: {type: 'oauth', token: 't'}},
                {type: 'gitlab', group: ' Platform	', auth: {type: 'oauth', token: 't'}},
            ],
        });
        expect(resolved[0]).toMatchObject({type: 'github', org: '  Wireless_Media '});
        expect(resolved[1]).toMatchObject({type: 'bitbucket', workspace: 'ACME-WS'});
        expect(resolved[2]).toMatchObject({type: 'gitlab', group: ' Platform	'});
        // …while the attribution key every imported row and cursor is keyed by IS normalized.
        expect(resolved.map((c) => providerContainer(c))).toEqual([
            'wireless_media',
            'acme-ws',
            'platform',
        ]);
    });

    it('containerKeyOf does NOT normalize — the key must match the raw stored column', () => {
        // Its callers pass values already derived from `providerContainer` or from the stored
        // (canonical) column. Normalizing here would be inert for all of them, and in the one state
        // where it would fire it makes the delete cascade WORSE: the key would match a config
        // sibling while the row-level retraction SQL two lines later still compares raw bytes, so
        // the cascade would be skipped and the rows orphaned instead of retracted.
        expect(containerKeyOf('github', ' Wireless_Media ')).toBe('github: Wireless_Media ');
        expect(containerKeyOf('github', 'wireless_media')).toBe('github:wireless_media');
    });

    it('passes an entry with an unknown type through untouched, so doctor can still name it', () => {
        // A YAML `type: gitea` is untrusted text this resolver deliberately does not filter (that
        // is what lets `doctor` report the entry specifically). It must not throw or strip fields —
        // the pipeline's own `validateGitProviderConfig` is what refuses it, per-provider, inside
        // `runSync`'s try/catch.
        const resolved = resolveGitProviderConfigs({
            enabled: true,
            providers: [{type: 'gitea', org: 'Acme', auth: {type: 'token', api_token: 't'}}],
        });
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({type: 'gitea', org: 'Acme'});
        // …and it resolves to the blank container every write guard refuses by name.
        expect(providerContainer(resolved[0])).toBe('');
        expect(containerKey(resolved[0])).toBe('gitea:');
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
