import {describe, it, expect, beforeEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {loadServerKey, type ServerKeyResult} from '../../src/connectors/git/providers/secret';
import {
    createProvider,
    deleteProvider,
    findProviderByTypeContainer,
    getDecryptedConfig,
    getProvider,
    GitProviderStoreError,
    listProviders,
    recordSyncOutcome,
    toPublicProvider,
    updateProvider,
    type GitProviderRecord,
} from '../../src/connectors/git/providers/store';
import type {GitProviderConfig} from '../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

// A valid 32-byte base64 key so loadServerKey succeeds; a second distinct key
// for the wrong-key rejection path.
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY_B64 = Buffer.alloc(32, 9).toString('base64');

function keyOk(): ServerKeyResult {
    return loadServerKey({TOPROPE_SECRET_KEY: KEY_B64});
}
function keyMissing(): ServerKeyResult {
    return loadServerKey({}); // → {ok:false, status:'not_configured'}
}

// One representative config per provider/auth shape the store must round-trip.
const GITHUB: GitProviderConfig = {
    type: 'github',
    org: 'acme',
    auth: {type: 'token', api_token: 'ghp_secretAAAA1234'},
    repos: ['include:svc-a', 'exclude:svc-b'],
    exclude_repos: ['legacy'],
};
const BITBUCKET_APP: GitProviderConfig = {
    type: 'bitbucket',
    workspace: 'acme-ws',
    auth: {type: 'app_password', username: 'jane', app_password: 'app-pw-WXYZ5678'},
};
// A DISTINCT workspace from BITBUCKET_APP: (type, container) is UNIQUE since 042 (#264),
// so two bitbucket fixtures for one workspace could never coexist in a store.
const BITBUCKET_TOKEN: GitProviderConfig = {
    type: 'bitbucket',
    workspace: 'acme-ws-2',
    auth: {type: 'access_token', token: 'bb-at-TOKN9012'},
};
const GITLAB: GitProviderConfig = {
    type: 'gitlab',
    group: 'acme-grp',
    url: 'https://gitlab.internal.acme.dev',
    include_subgroups: true,
    auth: {type: 'personal_access_token', token: 'glpat-SELFHOST3456'},
    repos: ['team/repo'],
};

let db: Database.Database;

beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
});

describe('provider store — create + read (#195)', () => {
    it('creates and reads back each provider/auth shape, encrypting the token', () => {
        for (const config of [GITHUB, BITBUCKET_APP, BITBUCKET_TOKEN, GITLAB]) {
            const rec = createProvider(db, keyOk(), {config, createdBy: null});
            expect(rec.id).toMatch(/[0-9a-f-]{36}/);
            expect(rec.type).toBe(config.type);
            // Encrypted at rest — never the plaintext.
            expect(rec.token_ciphertext).toBeInstanceOf(Buffer);
            expect(rec.token_ciphertext.length).toBeGreaterThan(0);
            const meta = JSON.parse(rec.token_meta);
            expect(meta.algo).toBe('AES-256-GCM');
            expect(typeof meta.iv).toBe('string');

            // Round-trips: decrypt back to the exact config the factory validates.
            const decoded = getDecryptedConfig(db, keyOk(), rec.id);
            expect(decoded).toEqual(config);
        }
    });

    it('stamps token_last4 from the plaintext secret', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        expect(rec.token_last4).toBe('1234'); // last 4 of ghp_secretAAAA1234
    });

    it('defaults enabled to 1 and honors enabled:false', () => {
        const on = createProvider(db, keyOk(), {config: GITHUB});
        expect(on.enabled).toBe(1);
        const off = createProvider(db, keyOk(), {config: BITBUCKET_TOKEN, enabled: false});
        expect(off.enabled).toBe(0);
    });

    it('getProvider returns undefined for an unknown id', () => {
        expect(getProvider(db, 'nope')).toBeUndefined();
    });

    // #264: one container is one independent data set, so a second provider for it is
    // refused with a typed error naming the owner — never a raw SQLITE_CONSTRAINT.
    it('refuses a second provider for the same (type, container) with a typed error', () => {
        const first = createProvider(db, keyOk(), {config: GITHUB});
        try {
            createProvider(db, keyOk(), {config: GITHUB});
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GitProviderStoreError);
            expect((e as GitProviderStoreError).code).toBe('duplicate_container');
            // Names the owner so the caller can point the admin at it.
            expect((e as GitProviderStoreError).message).toContain(first.id);
        }
        expect(listProviders(db)).toHaveLength(1);
    });

    it('allows the same container NAME under a different provider family', () => {
        createProvider(db, keyOk(), {config: GITHUB}); // github/acme
        expect(() =>
            createProvider(db, keyOk(), {
                config: {type: 'gitlab', group: 'acme', auth: {type: 'oauth', token: 'glpat-x'}},
            }),
        ).not.toThrow();
        expect(listProviders(db)).toHaveLength(2);
    });

    it('findProviderByTypeContainer resolves the owner and misses a free pair', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        expect(findProviderByTypeContainer(db, 'github', 'acme')?.id).toBe(rec.id);
        expect(findProviderByTypeContainer(db, 'github', 'other')).toBeUndefined();
        expect(findProviderByTypeContainer(db, 'gitlab', 'acme')).toBeUndefined();
    });
});

/**
 * #266 — the duplicate-container guard must not be defeatable by letter case or surrounding
 * whitespace. Before this, `Wireless_Media` and `wireless_media` were two providers for one
 * real workspace, i.e. two independent data sets whose commits `git_snapshots` then summed.
 */
describe('provider store — container normalization (#266)', () => {
    // Every write path per type, so a normalization applied to only one branch of the codec's
    // switch would fail here.
    const BASE: Record<string, (container: string) => GitProviderConfig> = {
        github: (container) => ({
            type: 'github',
            org: container,
            auth: {type: 'token', api_token: 'ghp_normAAAA1234'},
        }),
        bitbucket: (container) => ({
            type: 'bitbucket',
            workspace: container,
            auth: {type: 'access_token', token: 'bb-at-NORM9012'},
        }),
        gitlab: (container) => ({
            type: 'gitlab',
            group: container,
            auth: {type: 'personal_access_token', token: 'glpat-NORM3456'},
        }),
    };

    // The four spellings the issue names: the original plus the three that used to slip past
    // the guard.
    const VARIANTS = ['wireless_media', 'WIRELESS_MEDIA', 'Wireless_Media ', '  wireless_media'];

    for (const [type, make] of Object.entries(BASE)) {
        it(`[${type}] refuses every case/whitespace variant with a typed duplicate_container`, () => {
            const first = createProvider(db, keyOk(), {config: make('Wireless_Media')});
            for (const variant of VARIANTS) {
                try {
                    createProvider(db, keyOk(), {config: make(variant)});
                    throw new Error(`should have refused variant "${variant}"`);
                } catch (e) {
                    expect(e).toBeInstanceOf(GitProviderStoreError);
                    expect((e as GitProviderStoreError).code).toBe('duplicate_container');
                    // Names the owner, so the caller can point the admin at it.
                    expect((e as GitProviderStoreError).message).toContain(first.id);
                }
            }
            // Nothing was written by any of the refused attempts.
            expect(listProviders(db)).toHaveLength(1);
        });

        it(`[${type}] STORES the same normalized value the guard compared`, () => {
            // The #255 regression shape: the guard normalized, the write stored raw, so the
            // identifier proved free was not the identifier claimed. Asserted directly off
            // the row, not inferred from the guard's behavior.
            const rec = createProvider(db, keyOk(), {config: make('  Wireless_Media ')});
            expect(rec.container).toBe('wireless_media');
            const stored = db
                .prepare('SELECT container FROM git_providers WHERE id = ?')
                .get(rec.id) as {container: string};
            expect(stored.container).toBe('wireless_media');
            // And the canonical reader resolves it from ANY spelling — which is what makes
            // the value that was stored the value a later claim collides with.
            for (const variant of VARIANTS) {
                expect(
                    findProviderByTypeContainer(db, type as GitProviderRecord['type'], variant)?.id,
                ).toBe(rec.id);
            }
        });

        it(`[${type}] refuses a whitespace-only container with a typed error, not SQLITE_CONSTRAINT`, () => {
            for (const blank of ['', '   ', '\t\n']) {
                try {
                    createProvider(db, keyOk(), {config: make(blank)});
                    throw new Error(`should have refused blank container ${JSON.stringify(blank)}`);
                } catch (e) {
                    expect(e).toBeInstanceOf(GitProviderStoreError);
                    expect((e as GitProviderStoreError).code).toBe('blank_container');
                    // Not a raw DB failure leaking through.
                    expect((e as Error).message).not.toContain('SQLITE_CONSTRAINT');
                }
            }
            expect(listProviders(db)).toHaveLength(0);
        });
    }

    it('re-typing the same container in different case is a NO-OP update, not container_immutable', () => {
        // The pair did not actually change, so refusing the PATCH would be a lie — and the
        // admin UI's edit form re-sends the container on every save.
        const rec = createProvider(db, keyOk(), {config: BASE.github('Wireless_Media')});
        const updated = updateProvider(db, keyOk(), rec.id, {
            config: BASE.github('WIRELESS_MEDIA '),
        });
        expect(updated.container).toBe('wireless_media');
        expect(listProviders(db)).toHaveLength(1);
    });

    it('a PATCH onto a genuinely different container is still refused as container_immutable', () => {
        const rec = createProvider(db, keyOk(), {config: BASE.github('wireless_media')});
        try {
            updateProvider(db, keyOk(), rec.id, {config: BASE.github('other-org')});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as GitProviderStoreError).code).toBe('container_immutable');
        }
        expect(getProvider(db, rec.id)?.container).toBe('wireless_media');
    });

    it('a PATCH cannot blank the container', () => {
        const rec = createProvider(db, keyOk(), {config: BASE.github('wireless_media')});
        try {
            updateProvider(db, keyOk(), rec.id, {config: BASE.github('   ')});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as GitProviderStoreError).code).toBe('blank_container');
        }
        expect(getProvider(db, rec.id)?.container).toBe('wireless_media');
    });
});

describe('provider store — fail-closed on the server key (#195)', () => {
    it('rejects create when the server key is unconfigured (no plaintext-at-rest)', () => {
        expect(() => createProvider(db, keyMissing(), {config: GITHUB})).toThrow(GitProviderStoreError);
        try {
            createProvider(db, keyMissing(), {config: GITHUB});
        } catch (e) {
            expect((e as GitProviderStoreError).code).toBe('secret_key_unconfigured');
        }
        // And nothing was written.
        expect(listProviders(db)).toHaveLength(0);
    });

    it('rejects an invalid provider shape via the factory validate* seam', () => {
        const bad = {type: 'github', org: '', auth: {type: 'token', api_token: 'x'}} as GitProviderConfig;
        expect(() => createProvider(db, keyOk(), {config: bad})).toThrow(/org/);
        expect(listProviders(db)).toHaveLength(0);
    });

    it('rejects getDecryptedConfig / updateProvider when the key is unconfigured', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        expect(() => getDecryptedConfig(db, keyMissing(), rec.id)).toThrow(GitProviderStoreError);
        expect(() => updateProvider(db, keyMissing(), rec.id, {config: GITHUB})).toThrow(
            GitProviderStoreError,
        );
    });

    it('getDecryptedConfig throws (not garbage) under the wrong server key', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const wrongKey = loadServerKey({TOPROPE_SECRET_KEY: OTHER_KEY_B64});
        expect(() => getDecryptedConfig(db, wrongKey, rec.id)).toThrow(/wrong key|tampered/i);
    });

    it('getDecryptedConfig returns undefined for an unknown id', () => {
        expect(getDecryptedConfig(db, keyOk(), 'ghost')).toBeUndefined();
    });
});

describe('provider store — masked public projection never leaks secrets (#195)', () => {
    it('omits ciphertext/meta/plaintext and exposes only a masked token', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});

        // Positive control: the secret really is stored & recoverable, so a leak
        // WOULD be catchable by the scan below (the assertion isn't vacuous).
        const decoded = getDecryptedConfig(db, keyOk(), rec.id) as GitProviderConfig & {
            auth: {api_token: string};
        };
        expect(decoded.auth.api_token).toBe('ghp_secretAAAA1234');

        const pub = toPublicProvider(rec);
        expect(pub.token_last4).toBe('1234');
        expect(pub.token_masked).toBe('••••1234');
        expect(pub).not.toHaveProperty('token_ciphertext');
        expect(pub).not.toHaveProperty('token_meta');

        // Scan the serialized projection for every forbidden secret vector.
        // Decode the raw BLOB to strings first — JSON.stringify(Buffer) yields an
        // int array, which would hide a leaked ciphertext from a substring scan.
        const serialized = JSON.stringify(pub);
        expect(serialized).not.toContain('ghp_secretAAAA1234'); // plaintext
        expect(serialized).not.toContain(rec.token_ciphertext.toString('utf8'));
        expect(serialized).not.toContain(rec.token_ciphertext.toString('base64'));
        expect(serialized).not.toContain(JSON.parse(rec.token_meta).iv); // iv from meta
        expect(serialized).not.toContain('token_meta');
    });

    it('masks with bullets only when no last4 is known', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const noLast4: GitProviderRecord = {...rec, token_last4: null};
        expect(toPublicProvider(noLast4).token_masked).toBe('••••');
    });
});

describe('provider store — update (#195)', () => {
    it('without a token preserves the stored ciphertext exactly', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const beforeCipher = Buffer.from(rec.token_ciphertext);
        const beforeMeta = rec.token_meta;

        // Change the shape (repo scope) but NOT the token. The container is deliberately
        // held constant — it is immutable since #264 (see the dedicated tests below).
        const patched = updateProvider(db, keyOk(), rec.id, {
            config: {...GITHUB, repos: ['include:svc-c']} as GitProviderConfig,
        });

        expect(patched.container).toBe('acme');
        expect(patched.repos_include).toBe(JSON.stringify(['include:svc-c']));
        // Byte-for-byte identical ciphertext/meta/last4 — no re-encryption.
        expect(Buffer.compare(patched.token_ciphertext, beforeCipher)).toBe(0);
        expect(patched.token_meta).toBe(beforeMeta);
        expect(patched.token_last4).toBe(rec.token_last4);
        // The old token still decrypts.
        const decoded = getDecryptedConfig(db, keyOk(), rec.id) as GitProviderConfig & {
            auth: {api_token: string};
        };
        expect(decoded.auth.api_token).toBe('ghp_secretAAAA1234');
        expect(patched.updated_at >= rec.updated_at).toBe(true);
    });

    it('with a new token re-encrypts and refreshes last4', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const beforeCipher = Buffer.from(rec.token_ciphertext);

        const patched = updateProvider(db, keyOk(), rec.id, {
            config: GITHUB,
            token: 'ghp_rotatedZZZZ9999',
        });

        expect(Buffer.compare(patched.token_ciphertext, beforeCipher)).not.toBe(0);
        expect(patched.token_last4).toBe('9999');
        const decoded = getDecryptedConfig(db, keyOk(), rec.id) as GitProviderConfig & {
            auth: {api_token: string};
        };
        expect(decoded.auth.api_token).toBe('ghp_rotatedZZZZ9999');
    });

    it('toggles enabled and keeps it when omitted', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const disabled = updateProvider(db, keyOk(), rec.id, {config: GITHUB, enabled: false});
        expect(disabled.enabled).toBe(0);
        const untouched = updateProvider(db, keyOk(), rec.id, {
            config: {...GITHUB, repos: ['include:svc-c']},
        });
        expect(untouched.enabled).toBe(0); // omitted → kept
    });

    // #264: (type, container) keys every imported row and every sync cursor, so moving a
    // saved provider to a different pair would orphan the old container's data and cursors.
    // Refused with a typed error, in the write function itself, so no caller can bypass it.
    it('refuses to change the container (typed container_immutable), writing nothing', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        try {
            updateProvider(db, keyOk(), rec.id, {
                config: {...GITHUB, org: 'acme-renamed'} as GitProviderConfig,
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GitProviderStoreError);
            expect((e as GitProviderStoreError).code).toBe('container_immutable');
        }
        expect(getProvider(db, rec.id)?.container).toBe('acme');
    });

    // #264 review SO-4: for self-hosted GitLab the `url` is part of the real identity —
    // `platform` on two different instances is two different containers that
    // `providerContainer` spells identically. Leaving `url` mutable would let a PATCH re-point
    // a provider at another instance while all its imported rows and cursors stayed attributed
    // to it: the same silent relabelling the container guard exists to refuse.
    it('refuses to change a self-hosted GitLab url (it is part of the attribution key)', () => {
        const rec = createProvider(db, keyOk(), {config: GITLAB});
        try {
            updateProvider(db, keyOk(), rec.id, {
                config: {...GITLAB, url: 'https://gitlab.acquired.example'} as GitProviderConfig,
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GitProviderStoreError);
            expect((e as GitProviderStoreError).code).toBe('container_immutable');
            expect((e as GitProviderStoreError).message).toContain('self-hosted URL');
        }
        expect(getProvider(db, rec.id)?.url).toBe('https://gitlab.internal.acme.dev');
    });

    it('still allows an edit that leaves type, container and url alone', () => {
        const rec = createProvider(db, keyOk(), {config: GITLAB});
        const patched = updateProvider(db, keyOk(), rec.id, {
            config: {...GITLAB, repos: ['team/other']} as GitProviderConfig,
        });
        expect(patched.repos_include).toBe(JSON.stringify(['team/other']));
        expect(patched.url).toBe('https://gitlab.internal.acme.dev');
    });

    it('refuses to change the provider TYPE too (the pair is the key, not just the name)', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        try {
            updateProvider(db, keyOk(), rec.id, {
                config: {type: 'gitlab', group: 'acme', auth: {type: 'oauth', token: 'glpat-x'}},
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as GitProviderStoreError).code).toBe('container_immutable');
        }
        expect(getProvider(db, rec.id)?.type).toBe('github');
    });

    it('throws typed not_found for an unknown id (and writes nothing)', () => {
        try {
            updateProvider(db, keyOk(), 'ghost', {config: GITHUB});
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GitProviderStoreError);
            expect((e as GitProviderStoreError).code).toBe('not_found');
        }
        expect(listProviders(db)).toHaveLength(0);
    });

    it('validates the new shape via the factory (rejects an invalid patch)', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        expect(() =>
            updateProvider(db, keyOk(), rec.id, {config: {...GITHUB, org: ''} as GitProviderConfig}),
        ).toThrow(/org/);
        // The rejected update left the row unchanged.
        expect(getProvider(db, rec.id)?.container).toBe('acme');
    });
});

describe('provider store — list order is total + deterministic (#195)', () => {
    it('orders by created_at asc, then id asc as a stable tiebreak (≥2 rows)', () => {
        // Two rows written in the same instant (same created_at) must still order
        // deterministically by id — prove the tiebreak, not just the timestamp.
        const a = createProvider(db, keyOk(), {config: GITHUB});
        const b = createProvider(db, keyOk(), {config: BITBUCKET_TOKEN});
        const sameTime = '2026-01-01T00:00:00.000Z';
        db.prepare('UPDATE git_providers SET created_at = ? WHERE id IN (?, ?)').run(sameTime, a.id, b.id);

        const ids = listProviders(db).map((r) => r.id);
        const expected = [a.id, b.id].sort();
        expect(ids).toEqual(expected);

        // Total order: stable across repeated calls regardless of insert order.
        expect(listProviders(db).map((r) => r.id)).toEqual(expected);
    });

    it('orders distinct created_at chronologically', () => {
        const a = createProvider(db, keyOk(), {config: GITHUB});
        const b = createProvider(db, keyOk(), {config: GITLAB});
        db.prepare('UPDATE git_providers SET created_at = ? WHERE id = ?').run('2026-05-01T00:00:00.000Z', a.id);
        db.prepare('UPDATE git_providers SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', b.id);
        expect(listProviders(db).map((r) => r.id)).toEqual([b.id, a.id]);
    });
});

describe('provider store — delete (#195)', () => {
    it('removes a row and reports whether one was removed', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        expect(deleteProvider(db, rec.id)).toBe(true);
        expect(getProvider(db, rec.id)).toBeUndefined();
        expect(deleteProvider(db, rec.id)).toBe(false); // idempotent: already gone
    });
});

describe('provider store — recordSyncOutcome (#199)', () => {
    it('starts NULL/unset and records a successful outcome (at + ok, error cleared)', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        // A fresh provider has never synced.
        expect(rec.last_sync_at).toBeNull();
        expect(rec.last_sync_status).toBeNull();
        expect(rec.last_sync_error).toBeNull();

        const at = '2026-07-07T10:00:00.000Z';
        expect(recordSyncOutcome(db, rec.id, {status: 'ok', at})).toBe(true);

        const after = getProvider(db, rec.id);
        expect(after?.last_sync_at).toBe(at);
        expect(after?.last_sync_status).toBe('ok');
        expect(after?.last_sync_error).toBeNull();
    });

    it('records an error outcome with its message surfaced', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const at = '2026-07-07T11:00:00.000Z';
        recordSyncOutcome(db, rec.id, {status: 'error', at, error: 'GitHub API error 401'});

        const after = getProvider(db, rec.id);
        expect(after?.last_sync_status).toBe('error');
        expect(after?.last_sync_error).toBe('GitHub API error 401');
        expect(after?.last_sync_at).toBe(at);
    });

    it('clears a prior error message when a later run succeeds', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        recordSyncOutcome(db, rec.id, {status: 'error', at: '2026-07-07T11:00:00.000Z', error: 'boom'});
        recordSyncOutcome(db, rec.id, {status: 'ok', at: '2026-07-07T12:00:00.000Z'});

        const after = getProvider(db, rec.id);
        expect(after?.last_sync_status).toBe('ok');
        // The stale error text must not linger — the UI would read it as still-failing.
        expect(after?.last_sync_error).toBeNull();
    });

    it('coerces a blank/missing error message to a non-null sentinel (never swallowed as clean)', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        recordSyncOutcome(db, rec.id, {status: 'error', at: '2026-07-07T13:00:00.000Z', error: '   '});
        const after = getProvider(db, rec.id);
        // An error with no message must still be a non-null error string, so the
        // row can never present as a clean (NULL-error) failure.
        expect(after?.last_sync_status).toBe('error');
        expect(after?.last_sync_error).not.toBeNull();
        expect(after?.last_sync_error).toMatch(/no error message/);
    });

    it('returns false for an unknown id (no row updated)', () => {
        expect(recordSyncOutcome(db, 'does-not-exist', {status: 'ok', at: '2026-07-07T10:00:00.000Z'})).toBe(false);
    });

    it('fails closed on an unknown status rather than writing a bad row', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        expect(() =>
            recordSyncOutcome(db, rec.id, {
                status: 'never' as unknown as 'ok',
                at: '2026-07-07T10:00:00.000Z',
            }),
        ).toThrow(GitProviderStoreError);
        // The row is untouched — no partial write from the rejected status.
        expect(getProvider(db, rec.id)?.last_sync_status).toBeNull();
    });
});
