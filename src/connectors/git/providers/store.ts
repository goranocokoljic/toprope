/**
 * Provider store — the data-access layer over `git_providers` (GC1.3 / #195).
 *
 * CRUD + a masked public projection, composing the two siblings that came
 * before it: the row⇄config codec (GC1.1 / #193) and the server-side secret
 * module (GC1.2 / #194). No HTTP here — the admin CRUD API (#197) and the
 * resolver merge (#196) sit on top of this.
 *
 * Three contracts callers rely on:
 *   1. **Fail-closed on the secret key.** Every write that must (en|de)crypt a
 *      token takes the typed {@link ServerKeyResult} from `loadServerKey()` and
 *      refuses — throwing a typed {@link GitProviderStoreError} — when the key
 *      is unconfigured/invalid. There is no plaintext-at-rest fallback.
 *   2. **Tokens are write-only.** A plaintext token is accepted on create/update
 *      and encrypted immediately; it is NEVER read back out. {@link getProvider}
 *      /{@link listProviders} return the raw record for internal use, and
 *      {@link toPublicProvider} is the ONLY shape crossing an API boundary — it
 *      carries `token_last4` + a masked string and never the ciphertext, meta,
 *      or plaintext.
 *   3. **Update preserves the omitted token exactly.** An update without a new
 *      token keeps the stored `token_ciphertext`/`token_meta`/`token_last4`
 *      byte-for-byte (no re-encryption, which would rotate the IV); the whole
 *      read-modify-write runs in a single transaction.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {validateGitProviderConfig} from './factory.js';
import {providerConfigToRowFields, rowToProviderConfig, type GitProviderRow} from './codec.js';
import {decryptSecret, encryptSecret, type SecretMeta, type ServerKeyResult} from './secret.js';
import type {GitProviderConfig, GitProviderType} from './types.js';

/** The mask shown in place of a secret — a fixed run of bullets, never key material. */
const TOKEN_MASK = '••••';

function nowIso(): string {
    return new Date().toISOString();
}

/** Why a store write refused — all fail-closed, typed for the API to map. */
export type GitProviderStoreErrorCode =
    | 'secret_key_unconfigured'
    | 'not_found'
    | 'duplicate_container'
    | 'container_immutable';

/**
 * A fail-closed refusal from the store: the server key is unconfigured/invalid
 * (`secret_key_unconfigured`), the target row does not exist (`not_found`), the
 * `(type, container)` pair is already owned by another provider
 * (`duplicate_container`), or a write tried to move an existing provider to a
 * different `(type, container)` (`container_immutable`, #264 — see
 * {@link updateProvider}). Typed so the API layer maps it to a real status instead of
 * leaking a raw DB error (data-integrity review-rule: validate existence + return a
 * typed error).
 */
export class GitProviderStoreError extends Error {
    readonly code: GitProviderStoreErrorCode;
    constructor(code: GitProviderStoreErrorCode, message: string) {
        super(message);
        this.name = 'GitProviderStoreError';
        this.code = code;
    }
}

/**
 * A full `git_providers` row as stored. `token_ciphertext` is a BLOB (Buffer);
 * `enabled`/`include_subgroups` are the honest 0/1 the schema CHECKs. Superset
 * of the codec's {@link GitProviderRow}, so a record feeds straight back into
 * the codec on decode.
 */
export interface GitProviderRecord {
    id: string;
    type: GitProviderType;
    container: string;
    url: string | null;
    include_subgroups: number | null;
    auth_method: string;
    auth_username: string | null;
    token_ciphertext: Buffer;
    token_meta: string;
    token_last4: string | null;
    repos_include: string | null;
    repos_exclude: string | null;
    enabled: number;
    created_at: string;
    updated_at: string;
    created_by: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
}

/**
 * The masked, secret-free projection of a provider — the ONLY shape allowed to
 * cross an API boundary. It deliberately omits `token_ciphertext` and
 * `token_meta` and replaces the secret with `token_last4` + {@link
 * PublicGitProvider.token_masked}. `enabled`/`include_subgroups` are normalized
 * to booleans; `repos_*` are passed through as the stored JSON (the API DTO
 * decodes them). NEVER contains ciphertext, meta, or plaintext.
 */
export interface PublicGitProvider {
    id: string;
    type: GitProviderType;
    container: string;
    url: string | null;
    include_subgroups: boolean | null;
    auth_method: string;
    auth_username: string | null;
    token_last4: string | null;
    /** A display mask — bullets plus the last 4 chars when known (never the secret). */
    token_masked: string;
    repos_include: string | null;
    repos_exclude: string | null;
    enabled: boolean;
    created_at: string;
    updated_at: string;
    created_by: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
}

/** Create input: the validated provider shape (its `auth` carries the plaintext token) + audit/enable flags. */
export interface CreateProviderInput {
    config: GitProviderConfig;
    /** Soft on/off; defaults to enabled. */
    enabled?: boolean;
    /** Audit: the user connecting this provider. */
    createdBy?: string | null;
}

/**
 * Update patch: the new provider shape plus an OPTIONAL new token.
 * - `token` omitted → keep the stored ciphertext exactly (no re-encryption).
 * - `token` a non-empty string → re-encrypt and refresh `token_last4`.
 * The `config.auth` token field is ignored for the keep case — the token is
 * threaded explicitly via `token` so one field never means both "a real secret"
 * and "keep the old one".
 */
export interface UpdateProviderPatch {
    config: GitProviderConfig;
    token?: string;
    /** Soft on/off; omitted keeps the current value. */
    enabled?: boolean;
}

// The plaintext secret carried inside a config's auth — the value that gets
// encrypted at rest. Mirrors the codec's per-type auth shapes.
function tokenOf(config: GitProviderConfig): string {
    switch (config.type) {
        case 'github':
            return config.auth.api_token;
        case 'bitbucket':
            return config.auth.type === 'app_password' ? config.auth.app_password : config.auth.token;
        case 'gitlab':
            return config.auth.token;
        default: {
            const exhaustive: never = config;
            throw new GitProviderStoreError(
                'not_found',
                `Cannot read token for unknown provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}

// Return a copy of `config` with `token` substituted into the correct auth
// field, so the new provider shape can be validated against the factory while
// keeping the existing secret (update-without-token). Does not mutate the input.
function withToken(config: GitProviderConfig, token: string): GitProviderConfig {
    switch (config.type) {
        case 'github':
            return {...config, auth: {...config.auth, api_token: token}};
        case 'bitbucket':
            return config.auth.type === 'app_password'
                ? {...config, auth: {...config.auth, app_password: token}}
                : {...config, auth: {...config.auth, token}};
        case 'gitlab':
            return {...config, auth: {...config.auth, token}};
        default: {
            const exhaustive: never = config;
            throw new GitProviderStoreError(
                'not_found',
                `Cannot set token for unknown provider type: "${(exhaustive as {type: string}).type}"`,
            );
        }
    }
}

// Last 4 chars of a secret for masked display. Short secrets contribute what
// they have (never padded with real bytes) — mask length is not sensitive.
function last4Of(token: string): string {
    return token.slice(-4);
}

// Fail-closed guard shared by every write/read that must touch the secret key.
// Throws the typed store error carrying the crypto module's own message so the
// "why" (not configured vs invalid) survives to the API.
function requireKey(keyResult: ServerKeyResult): Extract<ServerKeyResult, {ok: true}>['key'] {
    if (!keyResult.ok) {
        throw new GitProviderStoreError('secret_key_unconfigured', keyResult.message);
    }
    return keyResult.key;
}

/**
 * The provider that owns a `(type, container)` pair, or `undefined` when it is free.
 *
 * `(type, container)` is the ATTRIBUTION key since #264: it keys the pipeline's cursors,
 * every `raw_author_daily`/`pr_records` row, and therefore the unit a delete retracts. One
 * container must have exactly one owner, which migration 042 enforces with
 * `UNIQUE(type, container)`. This is the canonical reader for that pair — the create/update
 * guards below and the admin API's 409s all go through it rather than re-deriving the
 * lookup, so "who owns this container" has one definition.
 */
export function findProviderByTypeContainer(
    db: Database.Database,
    type: GitProviderType,
    container: string,
): GitProviderRecord | undefined {
    return db
        .prepare('SELECT * FROM git_providers WHERE type = ? AND container = ?')
        .get(type, container) as GitProviderRecord | undefined;
}

/**
 * Create a provider: validate the shape via the canonical factory seam, encrypt
 * the token with the server key (fail-closed if unconfigured), stamp
 * `token_last4`, and write the row. Returns the stored record.
 *
 * Refuses a `(type, container)` another row already owns with a typed
 * `duplicate_container` (#264), so the caller can name the owner instead of surfacing a raw
 * `SQLITE_CONSTRAINT`. The check-then-insert runs in ONE transaction: the UNIQUE index is a
 * fail-fast backstop against a race, it does not serialize one.
 */
export function createProvider(
    db: Database.Database,
    keyResult: ServerKeyResult,
    input: CreateProviderInput,
): GitProviderRecord {
    const key = requireKey(keyResult);
    // Validate BEFORE encrypting so a bad shape / missing token surfaces the
    // factory's clear message, not the crypto layer's empty-secret guard.
    validateGitProviderConfig(input.config);

    const fields = providerConfigToRowFields(input.config);
    const token = tokenOf(input.config);
    const encrypted = encryptSecret(token, key);

    const id = randomUUID();
    const now = nowIso();
    const enabled = input.enabled === false ? 0 : 1;
    const createdBy = input.createdBy ?? null;

    return db.transaction((): GitProviderRecord => {
        const owner = findProviderByTypeContainer(db, fields.type, fields.container);
        if (owner !== undefined) {
            throw new GitProviderStoreError(
                'duplicate_container',
                `A ${fields.type} provider for '${fields.container}' already exists (id=${owner.id}). ` +
                    'One container is one independent data set — edit or delete that provider instead.',
            );
        }

        db.prepare(
            `INSERT INTO git_providers (
                id, type, container, url, include_subgroups, auth_method, auth_username,
                token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
                enabled, created_at, updated_at, created_by,
                last_sync_at, last_sync_status, last_sync_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        ).run(
            id,
            fields.type,
            fields.container,
            fields.url,
            fields.include_subgroups,
            fields.auth_method,
            fields.auth_username,
            encrypted.ciphertext,
            JSON.stringify(encrypted.meta),
            last4Of(token),
            fields.repos_include,
            fields.repos_exclude,
            enabled,
            now,
            now,
            createdBy,
        );

        const stored = getProvider(db, id);
        if (stored === undefined) {
            // The insert just ran on this synchronous connection, so the row is
            // always present; guard rather than cast so a future regression fails loudly.
            throw new GitProviderStoreError(
                'not_found',
                `git_providers row vanished immediately after insert (id=${id})`,
            );
        }
        return stored;
    })();
}

/**
 * Fetch one provider record by id, or `undefined` if none exists. The raw record
 * (incl. ciphertext) is internal — never hand it to an API without
 * {@link toPublicProvider}.
 */
export function getProvider(db: Database.Database, id: string): GitProviderRecord | undefined {
    const row = db.prepare('SELECT * FROM git_providers WHERE id = ?').get(id) as
        | GitProviderRecord
        | undefined;
    return row;
}

/**
 * List every provider in a total, deterministic order: `created_at` ascending,
 * then `id` ascending as a stable tiebreak (every row has a distinct id, so the
 * comparator is total and never depends on insertion timing). Raw records —
 * project with {@link toPublicProvider} before returning over an API.
 */
export function listProviders(db: Database.Database): GitProviderRecord[] {
    return db
        .prepare('SELECT * FROM git_providers ORDER BY created_at ASC, id ASC')
        .all() as GitProviderRecord[];
}

/**
 * Update a provider's shape and (optionally) its token. Without `patch.token`
 * the stored ciphertext/meta/last4 are preserved exactly; with a new token they
 * are re-encrypted and `token_last4` refreshed. The whole read-modify-write runs
 * in one transaction (data-integrity review-rule). Fail-closed: unknown id →
 * `not_found`, unconfigured key → `secret_key_unconfigured`. Returns the updated
 * record.
 *
 * `(type, container)` IS IMMUTABLE (#264). Since that pair keys the pipeline's cursors and
 * every imported `raw_author_daily`/`pr_records` row, moving a provider to a different pair
 * would leave the old container's data and cursors owned by nobody — un-syncable, and
 * un-retractable because no provider row resolves to them any more (the PATCH-orphan
 * finding deferred from #262). The two honest options are "move the data with it" or
 * "refuse"; refusing is the one chosen, because a container change is not always a rename —
 * it is just as often a re-point at a genuinely different workspace, and relabelling
 * workspace A's commits as workspace B's would be silent data corruption that no later
 * operation can undo. Delete the provider (which now cleanly retracts its data) and add the
 * new container instead. Reported as a typed `container_immutable`, never a silent no-op.
 */
export function updateProvider(
    db: Database.Database,
    keyResult: ServerKeyResult,
    id: string,
    patch: UpdateProviderPatch,
): GitProviderRecord {
    const key = requireKey(keyResult);
    const replacingToken = patch.token !== undefined && patch.token !== '';

    const run = db.transaction((): GitProviderRecord => {
        const existing = getProvider(db, id);
        if (existing === undefined) {
            throw new GitProviderStoreError('not_found', `git_providers row not found (id=${id})`);
        }

        // The token used to VALIDATE the new shape: the incoming one when
        // replacing, otherwise the existing decrypted secret so the new shape is
        // still checked against a real token without re-encrypting it.
        const validationToken = replacingToken
            ? (patch.token as string)
            : decryptSecret(existing.token_ciphertext, JSON.parse(existing.token_meta) as SecretMeta, key);

        const config = withToken(patch.config, validationToken);
        validateGitProviderConfig(config);
        const fields = providerConfigToRowFields(config);

        // The attribution key is immutable — see the doc above. Checked here, inside the
        // write transaction, so no caller can bypass it (the admin route validates the
        // COLLIDING case first, to name the owner; this is the total guard).
        if (fields.type !== existing.type || fields.container !== existing.container) {
            throw new GitProviderStoreError(
                'container_immutable',
                `A provider's type and container cannot be changed (${existing.type}/${existing.container} → ` +
                    `${fields.type}/${fields.container}): its imported data and sync cursors are keyed by that pair. ` +
                    'Delete this provider — which now removes exactly its own data — and add the new one.',
            );
        }

        const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;

        const sets = [
            'type = ?',
            'container = ?',
            'url = ?',
            'include_subgroups = ?',
            'auth_method = ?',
            'auth_username = ?',
            'repos_include = ?',
            'repos_exclude = ?',
            'enabled = ?',
            'updated_at = ?',
        ];
        const params: unknown[] = [
            fields.type,
            fields.container,
            fields.url,
            fields.include_subgroups,
            fields.auth_method,
            fields.auth_username,
            fields.repos_include,
            fields.repos_exclude,
            enabled,
            nowIso(),
        ];

        if (replacingToken) {
            const encrypted = encryptSecret(patch.token as string, key);
            sets.push('token_ciphertext = ?', 'token_meta = ?', 'token_last4 = ?');
            params.push(encrypted.ciphertext, JSON.stringify(encrypted.meta), last4Of(patch.token as string));
        }
        // else: token columns are left untouched → the ciphertext is preserved exactly.

        params.push(id);
        db.prepare(`UPDATE git_providers SET ${sets.join(', ')} WHERE id = ?`).run(...params);

        const updated = getProvider(db, id);
        if (updated === undefined) {
            throw new GitProviderStoreError('not_found', `git_providers row vanished during update (id=${id})`);
        }
        return updated;
    });

    return run();
}

/**
 * Delete a provider ROW by id. Returns true when a row was actually removed.
 *
 * This is the row delete only. Since #264 a provider owns imported data and sync cursors
 * keyed by its `(type, container)`, and removing a provider means retracting those too —
 * that whole cascade lives in `delete-cascade.ts`, which composes this as its last step.
 * Call this directly only when you genuinely mean "drop the row and leave the data".
 */
export function deleteProvider(db: Database.Database, id: string): boolean {
    return db.prepare('DELETE FROM git_providers WHERE id = ?').run(id).changes > 0;
}

/** The terminal outcome of a sync run for a provider — mirrors the row's closed
 *  `last_sync_status` set (never `'never'`; that is the pre-first-sync default). */
export type SyncOutcomeStatus = 'ok' | 'error';

/** What {@link recordSyncOutcome} persists onto a provider row after a sync run. */
export interface SyncOutcome {
    status: SyncOutcomeStatus;
    /** When the run finished — UTC ISO. */
    at: string;
    /** The failure summary on `status: 'error'`; ignored (cleared) on `'ok'`. */
    error?: string | null;
}

// Runtime allowlist for the outcome status (review-rule: allowlist at the write
// boundary, not just the compile-time union) — a value the row CHECK would reject
// is refused here first, with a clear message rather than a raw SQLITE_CONSTRAINT.
const SYNC_OUTCOME_STATUSES: readonly SyncOutcomeStatus[] = ['ok', 'error'];

/**
 * Persist the terminal result of a sync-now run (GC1.7 / #199) onto the provider
 * row: `last_sync_at`, `last_sync_status`(ok|error), and `last_sync_error`. On
 * `ok` the error column is cleared; on `error` a non-blank summary is stored (a
 * failed sync must surface its message to the UI, never a swallowed error — so a
 * missing/blank message is coerced to a generic non-null sentinel rather than
 * left NULL, which the UI would read as "clean"). Returns true when the row
 * existed and was updated. Fail-closed on an unknown status.
 */
export function recordSyncOutcome(db: Database.Database, id: string, outcome: SyncOutcome): boolean {
    if (!SYNC_OUTCOME_STATUSES.includes(outcome.status)) {
        throw new GitProviderStoreError(
            'not_found',
            `Refusing to record unknown sync status: "${String(outcome.status)}"`,
        );
    }
    // On error a non-null message is mandatory (see doc); on ok it is always NULL.
    const errorText =
        outcome.status === 'error'
            ? (outcome.error && outcome.error.trim() !== '' ? outcome.error : 'Sync failed (no error message)')
            : null;
    const changes = db
        .prepare(
            'UPDATE git_providers SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ? WHERE id = ?',
        )
        .run(outcome.at, outcome.status, errorText, id).changes;
    return changes > 0;
}

/**
 * The masked, secret-free projection — the ONLY provider shape allowed to leave
 * the server. Drops `token_ciphertext`/`token_meta`, exposes `token_last4` + a
 * bullet mask, and normalizes the boolean columns. Guarantees no ciphertext,
 * meta, or plaintext is present.
 */
export function toPublicProvider(record: GitProviderRecord): PublicGitProvider {
    const last4 = record.token_last4;
    return {
        id: record.id,
        type: record.type,
        container: record.container,
        url: record.url,
        include_subgroups:
            record.include_subgroups === null ? null : record.include_subgroups === 1,
        auth_method: record.auth_method,
        auth_username: record.auth_username,
        token_last4: last4,
        token_masked: last4 ? `${TOKEN_MASK}${last4}` : TOKEN_MASK,
        repos_include: record.repos_include,
        repos_exclude: record.repos_exclude,
        enabled: record.enabled === 1,
        created_at: record.created_at,
        updated_at: record.updated_at,
        created_by: record.created_by,
        last_sync_at: record.last_sync_at,
        last_sync_status: record.last_sync_status,
        last_sync_error: record.last_sync_error,
    };
}

/**
 * Decrypt a stored provider back into its `GitProviderConfig` — INTERNAL ONLY
 * (test-connection / sync / resolver). Fail-closed on an unconfigured key;
 * returns `undefined` when the id is unknown. A wrong key or tampered
 * ciphertext/meta makes the underlying crypto throw (never garbage), and the
 * decoded config is run through the codec's factory `validate*` seam.
 */
export function getDecryptedConfig(
    db: Database.Database,
    keyResult: ServerKeyResult,
    id: string,
): GitProviderConfig | undefined {
    const key = requireKey(keyResult);
    const record = getProvider(db, id);
    if (record === undefined) return undefined;

    const token = decryptSecret(
        record.token_ciphertext,
        JSON.parse(record.token_meta) as SecretMeta,
        key,
    );
    // `record` is a structural superset of the codec's GitProviderRow.
    return rowToProviderConfig(record as GitProviderRow, token);
}
