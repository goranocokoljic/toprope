import {describe, it, expect, beforeEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {loadServerKey, type ServerKeyResult} from '../../src/connectors/git/providers/secret';
import {
    advisoriesTruncatedLine,
    advisoryLineTruncatedSuffix,
    createProvider,
    deleteProvider,
    MAX_STORED_ADVISORIES,
    MAX_STORED_ADVISORY_CHARS,
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

        it(`[${type}] refuses a blank or whitespace-only container inside the write, not with SQLITE_CONSTRAINT`, () => {
            // The refusal comes from `validateGitProviderConfig`, which `createProvider` calls
            // INSIDE the write and which checks the container FIRST in all three per-type
            // validators. Pre-#266 it used `!config.org`, and `'   '` is truthy — so a
            // whitespace-only container reached the row and `(type, '')` became a real
            // attribution key two workspaces could share.
            const expected = {
                github: 'GitHub provider requires org',
                bitbucket: 'Bitbucket provider requires workspace',
                gitlab: 'GitLab provider requires group',
            }[type] as string;
            for (const blank of ['', '   ', '\t\n']) {
                expect(
                    () => createProvider(db, keyOk(), {config: make(blank)}),
                    `container ${JSON.stringify(blank)}`,
                ).toThrow(expected);
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

    it('is the ONLY writer of the container column, so every stored value is canonical', () => {
        // The invariant the whole guard rests on, asserted rather than assumed: whatever spelling
        // a caller hands in, the column ends up canonical — which is what lets the reader stay a
        // single indexed point-read and keeps it consistent with the other readers of
        // `record.container` (the delete cascade, `syncStateKey`), which compare raw bytes.
        // Migration 043 is the other half (it normalizes pre-#266 rows and deletes the ones SQL
        // cannot canonicalize); the two together are why a non-canonical row cannot exist.
        for (const spelling of ['Wireless_Media', '  WIRELESS_MEDIA ', '\tWireless_Media\n']) {
            const rec = createProvider(db, keyOk(), {config: BASE.github(spelling)});
            expect(rec.container).toBe('wireless_media');
            // Re-sending any other spelling on the edit path is a no-op, not a refused move.
            const updated = updateProvider(db, keyOk(), rec.id, {
                config: BASE.github('wireless_media '),
            });
            expect(updated.container).toBe('wireless_media');
            deleteProvider(db, rec.id);
        }
        expect(
            db
                .prepare('SELECT COUNT(*) AS n FROM git_providers WHERE container <> lower(container)')
                .get(),
        ).toEqual({n: 0});
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
        expect(() =>
            updateProvider(db, keyOk(), rec.id, {config: BASE.github('   ')}),
        ).toThrow('GitHub provider requires org');
        expect(getProvider(db, rec.id)?.container).toBe('wireless_media');
    });

    it('findProviderByTypeContainer misses a blank lookup even when a blank row exists', () => {
        // The early return has to be exercised against a row it could otherwise MATCH, or the
        // test passes for the wrong reason (nothing matches a blank container in a table of
        // ordinary rows either). Seeded by direct UPDATE, bypassing the store, because the store
        // refuses to write a blank container — which is exactly why such a row can only come from
        // outside it, and why answering a blank query with it would let a malformed config entry
        // claim an existing provider's identity.
        const blankRow = createProvider(db, keyOk(), {config: BASE.github('placeholder')});
        db.prepare('UPDATE git_providers SET container = ? WHERE id = ?').run('   ', blankRow.id);
        createProvider(db, keyOk(), {config: BASE.github('wireless_media')});

        for (const blank of ['', '   ', '\t']) {
            expect(findProviderByTypeContainer(db, 'github', blank)).toBeUndefined();
        }
        // …and a real lookup still resolves.
        expect(findProviderByTypeContainer(db, 'github', 'WIRELESS_MEDIA')?.container).toBe(
            'wireless_media',
        );
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

/**
 * The advisory column (#289): the half of a run's report that must be VISIBLE without being
 * RED. Its whole reason to exist is that the `ok` branch NULLs `last_sync_error`, so before
 * this an advisory recorded on the scoped admin path was indistinguishable from no advisory.
 */
describe('provider store — recordSyncOutcome advisories (#289)', () => {
    const DROP_LINE = 'Commits dropped as unattributable: [github/api] 3 commit(s)';

    it('stores advisories on an OK outcome without populating the error column', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        expect(rec.last_sync_advisories).toBeNull();

        recordSyncOutcome(db, rec.id, {
            status: 'ok',
            at: '2026-07-07T10:00:00.000Z',
            advisories: [DROP_LINE],
        });

        const after = getProvider(db, rec.id);
        expect(after?.last_sync_status).toBe('ok');
        // Visible…
        expect(toPublicProvider(after!).last_sync_advisories).toEqual([DROP_LINE]);
        // …and not red. Both halves matter: a fix that wrote the line into `last_sync_error`
        // would satisfy "durably recorded" and break the classification the route exists to keep.
        expect(after?.last_sync_error).toBeNull();
    });

    it('stores advisories alongside a failure on an ERROR outcome', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        recordSyncOutcome(db, rec.id, {
            status: 'error',
            at: '2026-07-07T11:00:00.000Z',
            error: 'GitHub API error 401',
            advisories: [DROP_LINE],
        });

        const pub = toPublicProvider(getProvider(db, rec.id)!);
        expect(pub.last_sync_status).toBe('error');
        expect(pub.last_sync_error).toBe('GitHub API error 401');
        expect(pub.last_sync_advisories).toEqual([DROP_LINE]);
    });

    it('clears a prior run\'s advisories when a later run reports none', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        recordSyncOutcome(db, rec.id, {
            status: 'ok',
            at: '2026-07-07T10:00:00.000Z',
            advisories: [DROP_LINE],
        });
        recordSyncOutcome(db, rec.id, {status: 'ok', at: '2026-07-07T12:00:00.000Z'});

        // The column describes the LAST run, exactly like `last_sync_error` beside it: a stale
        // drop line standing next to a newer timestamp attributes it to a run that never
        // reported it, and nothing would ever clear it.
        expect(getProvider(db, rec.id)?.last_sync_advisories).toBeNull();
        expect(toPublicProvider(getProvider(db, rec.id)!).last_sync_advisories).toEqual([]);
    });

    it('caps the stored list and says how many lines it dropped', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const overflow = 7;
        const lines = Array.from(
            {length: MAX_STORED_ADVISORIES + overflow},
            (_, i) => `${DROP_LINE} #${i}`,
        );
        recordSyncOutcome(db, rec.id, {status: 'ok', at: '2026-07-07T10:00:00.000Z', advisories: lines});

        const stored = toPublicProvider(getProvider(db, rec.id)!).last_sync_advisories;
        // Capped… (the cap + one line about the cap)
        expect(stored).toHaveLength(MAX_STORED_ADVISORIES + 1);
        expect(stored.slice(0, MAX_STORED_ADVISORIES)).toEqual(lines.slice(0, MAX_STORED_ADVISORIES));
        // …but never SILENTLY: the reader is told the count it is not seeing. Asserted against
        // the builder, not a copy of its wording, so a reword cannot quietly pass this.
        expect(stored[MAX_STORED_ADVISORIES]).toBe(advisoriesTruncatedLine(overflow));
        expect(stored[MAX_STORED_ADVISORIES]).toContain(String(overflow));
    });

    it('stores a list exactly at the cap with no truncation line', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const lines = Array.from({length: MAX_STORED_ADVISORIES}, (_, i) => `${DROP_LINE} #${i}`);
        recordSyncOutcome(db, rec.id, {status: 'ok', at: '2026-07-07T10:00:00.000Z', advisories: lines});

        // The boundary: `<=` not `<`, so a full-but-not-over list is not reported as truncated.
        expect(toPublicProvider(getProvider(db, rec.id)!).last_sync_advisories).toEqual(lines);
    });

    it('truncates one over-long line without dropping it, and says so', () => {
        // The second axis of the bound. UNMATCHED_AUTHORS_PREFIX joins the WHOLE unmatched set
        // into ONE entry, so a first sync of a 2,000-author org writes ~70-100 KB in a single
        // line — which a 20-LINE cap passes untouched, into a row the admin list serves for
        // every provider on every 1s poll while a sync is in flight.
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const huge = `${DROP_LINE} ${'x'.repeat(MAX_STORED_ADVISORY_CHARS * 3)}`;
        recordSyncOutcome(db, rec.id, {status: 'ok', at: '2026-07-07T10:00:00.000Z', advisories: [huge]});

        const stored = toPublicProvider(getProvider(db, rec.id)!).last_sync_advisories;
        // Kept, not dropped — the line still identifies what it is about…
        expect(stored).toHaveLength(1);
        expect(stored[0].startsWith(DROP_LINE)).toBe(true);
        // …bounded…
        expect(stored[0]).toHaveLength(MAX_STORED_ADVISORY_CHARS + advisoryLineTruncatedSuffix().length);
        // …and not silently: a shortened line must not read as a complete one.
        expect(stored[0].endsWith(advisoryLineTruncatedSuffix())).toBe(true);
    });

    it('leaves a line exactly at the character cap untouched', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        const exact = 'y'.repeat(MAX_STORED_ADVISORY_CHARS);
        recordSyncOutcome(db, rec.id, {status: 'ok', at: '2026-07-07T10:00:00.000Z', advisories: [exact]});
        // `<=` not `<` on this axis too.
        expect(toPublicProvider(getProvider(db, rec.id)!).last_sync_advisories).toEqual([exact]);
    });

    it('surfaces a malformed stored value as its raw text rather than failing the row', () => {
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        // Reachable from a hand-edited row: the column is untyped TEXT with no CHECK.
        db.prepare('UPDATE git_providers SET last_sync_advisories = ? WHERE id = ?').run(
            'half-written {',
            rec.id,
        );
        expect(toPublicProvider(getProvider(db, rec.id)!).last_sync_advisories).toEqual([
            'half-written {',
        ]);
    });

    it('reports no advisories for column values a `=== null` guard would let through', () => {
        // The two inputs only the TYPE guard handles. A `record.last_sync_advisories === null`
        // test passes both straight into the tolerant decoder, which returns a one-entry list
        // — and the row then renders "reported 1 advisory line(s)" with a blank bullet on
        // EVERY provider. `undefined` is the serious one: it is what `SELECT *` yields on a
        // database where migration 045 has not been applied, and the record type is a cast,
        // not a runtime check.
        const rec = createProvider(db, keyOk(), {config: GITHUB});
        db.prepare('UPDATE git_providers SET last_sync_advisories = ? WHERE id = ?').run('', rec.id);
        expect(toPublicProvider(getProvider(db, rec.id)!).last_sync_advisories).toEqual([]);

        const noColumn = {...getProvider(db, rec.id)!} as GitProviderRecord & {
            last_sync_advisories?: string | null;
        };
        delete noColumn.last_sync_advisories;
        expect(toPublicProvider(noColumn as GitProviderRecord).last_sync_advisories).toEqual([]);
    });
});
