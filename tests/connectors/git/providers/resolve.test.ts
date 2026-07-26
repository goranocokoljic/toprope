import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../../src/storage/migrator';
import {resolveAllGitProviders} from '../../../../src/connectors/git/providers/resolve';
import {createProvider} from '../../../../src/connectors/git/providers/store';
import {loadServerKey, type ServerKeyResult} from '../../../../src/connectors/git/providers/secret';
import type {GitConnectorConfig} from '../../../../src/config/types';
import type {GitProviderConfig} from '../../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../src/storage/migrations');

// A stable, valid base64-encoded 32-byte key so loadServerKey() succeeds.
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function okKey(): ServerKeyResult {
    return loadServerKey({TOPROPE_SECRET_KEY: TEST_KEY});
}

function githubConfig(org: string, token: string): GitProviderConfig {
    return {type: 'github', org, auth: {type: 'token', api_token: token}};
}

function gitlabConfig(group: string, token: string): GitProviderConfig {
    return {type: 'gitlab', group, auth: {type: 'personal_access_token', token}};
}

describe('resolveAllGitProviders', () => {
    let db: Database.Database;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        db = makeDb();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    it('returns only config providers when there are no DB providers (config-only unchanged)', () => {
        const gitConfig: GitConnectorConfig = {
            enabled: true,
            providers: [githubConfig('cfg-org', 'cfg-token'), gitlabConfig('cfg-group', 'gl-token')],
        };

        const resolved = resolveAllGitProviders(db, okKey(), gitConfig);

        expect(resolved.map((p) => p.type)).toEqual(['github', 'gitlab']);
        expect(resolved[0]).toMatchObject({type: 'github', org: 'cfg-org'});
        expect(warn).not.toHaveBeenCalled();
    });

    it('includes an enabled DB provider (decrypted) and lists DB providers before config ones', () => {
        createProvider(db, okKey(), {config: githubConfig('db-org', 'db-secret-1234'), enabled: true});

        const gitConfig: GitConnectorConfig = {
            enabled: true,
            providers: [githubConfig('cfg-org', 'cfg-token')],
        };

        const resolved = resolveAllGitProviders(db, okKey(), gitConfig);

        expect(resolved).toHaveLength(2);
        // DB provider first, with its decrypted token.
        expect(resolved[0]).toMatchObject({type: 'github', org: 'db-org'});
        expect(resolved[0].type === 'github' && resolved[0].auth.api_token).toBe('db-secret-1234');
        // Then the (non-overlapping) config provider.
        expect(resolved[1]).toMatchObject({type: 'github', org: 'cfg-org'});
    });

    it('shadows a config provider that collides on (type, container): DB wins and it is logged', () => {
        createProvider(db, okKey(), {config: githubConfig('acme', 'db-token'), enabled: true});

        const gitConfig: GitConnectorConfig = {
            enabled: true,
            providers: [
                githubConfig('acme', 'config-token'), // same (github, acme) → shadowed
                gitlabConfig('acme', 'gl-token'), // different type → NOT shadowed
                githubConfig('other', 'other-token'), // different container → NOT shadowed
            ],
        };

        const resolved = resolveAllGitProviders(db, okKey(), gitConfig);

        // Exactly one (github, acme): the DB one.
        const acme = resolved.filter((p) => p.type === 'github' && p.org === 'acme');
        expect(acme).toHaveLength(1);
        expect(acme[0].type === 'github' && acme[0].auth.api_token).toBe('db-token');

        // The other-container and other-type config providers survive.
        expect(resolved.some((p) => p.type === 'github' && p.org === 'other')).toBe(true);
        expect(resolved.some((p) => p.type === 'gitlab' && p.group === 'acme')).toBe(true);

        // The shadowing was logged.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('shadowed'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('github:acme'));
    });

    it('excludes disabled DB providers from the merge', () => {
        createProvider(db, okKey(), {config: githubConfig('disabled-org', 'db-token'), enabled: false});

        const gitConfig: GitConnectorConfig = {enabled: true, providers: [githubConfig('cfg-org', 'cfg-token')]};

        const resolved = resolveAllGitProviders(db, okKey(), gitConfig);

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({type: 'github', org: 'cfg-org'});
        expect(resolved.some((p) => p.type === 'github' && p.org === 'disabled-org')).toBe(false);
    });

    it('a disabled DB provider does NOT shadow a colliding config provider', () => {
        createProvider(db, okKey(), {config: githubConfig('acme', 'db-token'), enabled: false});

        const gitConfig: GitConnectorConfig = {enabled: true, providers: [githubConfig('acme', 'config-token')]};

        const resolved = resolveAllGitProviders(db, okKey(), gitConfig);

        // The config provider runs (the disabled DB row is not a shadowing source).
        expect(resolved).toHaveLength(1);
        expect(resolved[0].type === 'github' && resolved[0].auth.api_token).toBe('config-token');
        expect(warn).not.toHaveBeenCalled();
    });

    it('fails closed: with the server key unconfigured, enabled DB providers are skipped (config still resolves)', () => {
        createProvider(db, okKey(), {config: githubConfig('db-org', 'db-token'), enabled: true});

        const noKey = loadServerKey({}); // TOPROPE_SECRET_KEY absent → not ok
        expect(noKey.ok).toBe(false);

        const gitConfig: GitConnectorConfig = {enabled: true, providers: [githubConfig('cfg-org', 'cfg-token')]};

        const resolved = resolveAllGitProviders(db, noKey, gitConfig);

        // DB provider dropped (never a plaintext fallback); config provider survives.
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({type: 'github', org: 'cfg-org'});
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping'));
    });

    it('does not warn about a missing key when there are no enabled DB providers', () => {
        const noKey = loadServerKey({});
        const gitConfig: GitConnectorConfig = {enabled: true, providers: [githubConfig('cfg-org', 'cfg-token')]};

        const resolved = resolveAllGitProviders(db, noKey, gitConfig);

        expect(resolved).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it('skips a single corrupt DB row (undecryptable) without sinking the rest of the run', () => {
        const good = createProvider(db, okKey(), {config: githubConfig('good-org', 'good-token'), enabled: true});
        const bad = createProvider(db, okKey(), {config: githubConfig('bad-org', 'bad-token'), enabled: true});

        // Corrupt the ciphertext of one row so GCM auth fails on decrypt.
        db.prepare('UPDATE git_providers SET token_ciphertext = ? WHERE id = ?').run(
            Buffer.from('not-real-ciphertext'),
            bad.id,
        );

        const resolved = resolveAllGitProviders(db, okKey(), {enabled: true});

        // The good provider survives; the corrupt one is dropped with a warning.
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({type: 'github', org: 'good-org'});
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping DB provider'));
        // Sanity: the good row was genuinely present alongside the bad one.
        expect(good.id).not.toBe(bad.id);
    });

    it('returns an empty list when neither DB nor config has providers', () => {
        const resolved = resolveAllGitProviders(db, okKey(), {enabled: true});
        expect(resolved).toEqual([]);
    });

    // #264 review OR-5/SO-5: two YAML entries naming ONE container are the same commits fetched
    // twice. The run's per-(container, author, day) accumulator sums them — a permanent
    // double-count — and the two entries also fight over one cursor and one stall key.
    // `UNIQUE(type, container)` cannot see it (it constrains `git_providers` rows, not config),
    // so the de-dupe belongs at this seam, where every consumer resolves through.
    it('de-dupes config-against-config, keeping the first entry and warning', () => {
        const resolved = resolveAllGitProviders(db, okKey(), {
            enabled: true,
            providers: [
                {type: 'github', org: 'dup-org', auth: {type: 'token', api_token: 'a'}, repos: ['x']},
                {type: 'github', org: 'dup-org', auth: {type: 'token', api_token: 'b'}, repos: ['y']},
                {type: 'github', org: 'other-org', auth: {type: 'token', api_token: 'c'}},
            ],
        });

        expect(resolved.map((p) => (p as {org: string}).org)).toEqual(['dup-org', 'other-org']);
        // The FIRST entry survives (its repo scope, not the duplicate's).
        expect(resolved[0]).toMatchObject({repos: ['x']});
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('declared more than once'));
    });

    it('still allows the same container NAME under a different provider family', () => {
        const resolved = resolveAllGitProviders(db, okKey(), {
            enabled: true,
            providers: [
                {type: 'github', org: 'shared', auth: {type: 'token', api_token: 'a'}},
                {type: 'gitlab', group: 'shared', auth: {type: 'oauth', token: 'b'}},
            ],
        });
        expect(resolved).toHaveLength(2);
    });
});
