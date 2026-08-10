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
import {normalizeContainer, sameContainer} from './container.js';
import type {GitProviderConfig, GitProviderType} from './types.js';
import {
    decodeStringArrayColumn,
    encodeStringArrayColumn,
} from '../../../storage/string-array-column.js';

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
 *
 * A blank container is NOT a code here: `validateGitProviderConfig` — which every write below
 * calls, inside the write function, before the row is built — rejects it via
 * `isBlankContainer` (#266). One refusal, at the canonical validation seam that
 * `createGitProvider` shares, rather than a second store-only code the routes can never reach.
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
    /** JSON array of the last run's advisory lines, or NULL for none (#289). */
    last_sync_advisories: string | null;
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
    /**
     * The last run's ADVISORY lines — decoded, and `[]` (never null) when there were none
     * (#289). Separate from `last_sync_error` because an advisory must be visible WITHOUT
     * being a failure: a non-empty list here says nothing about `last_sync_status`, and a
     * run can legitimately be `ok` with entries, or `error` with both.
     */
    last_sync_advisories: string[];
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
 *
 * The lookup NORMALIZES ITS ARGUMENT (#266). SQLite's `=` on TEXT is case-sensitive and
 * nothing trims, so a raw comparison answered "free" for `wireless_media` while
 * `Wireless_Media` sat in the table — and since #264 that means two independent data sets
 * for one real workspace, i.e. a permanent double-count through the front door of the guard
 * added to prevent it.
 *
 * Comparing the normalized argument against the raw column is sound because the column is
 * canonical BY CONSTRUCTION, at both ends:
 *   - every write goes through `providerConfigToRowFields` → `providerContainer` →
 *     `normalizeContainer` (this module is the only writer of `git_providers`), and
 *   - migration 043 brought existing rows to that same spelling, deleting the ones SQLite
 *     could not canonicalize the way JS does rather than storing a guess.
 * So a stored container that `normalizeContainer` would change cannot survive, which is what
 * lets this stay a single indexed point-read on the `UNIQUE(type, container)` index instead of
 * a scan — and what keeps it consistent with the other readers of `record.container` (the
 * delete cascade, `syncStateKey`), which compare raw bytes and would silently retract nothing
 * for a non-canonical row no matter how tolerant this function was.
 *
 * A blank lookup returns `undefined` rather than matching: no valid row can hold a blank
 * container (`validateGitProviderConfig` refuses it and 043 deletes it), so a blank query is a
 * caller bug, and answering it with "the row whose container is also blank" would let a
 * malformed config claim an existing provider's identity.
 */
export function findProviderByTypeContainer(
    db: Database.Database,
    type: GitProviderType,
    container: string,
): GitProviderRecord | undefined {
    const wanted = normalizeContainer(container);
    if (wanted === '') return undefined;
    return db
        .prepare('SELECT * FROM git_providers WHERE type = ? AND container = ?')
        .get(type, wanted) as GitProviderRecord | undefined;
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
 *
 * The container the guard compares IS the container the INSERT writes — one
 * `fields.container`, produced once by the codec's normalizing extraction (#266/#255).
 */
export function createProvider(
    db: Database.Database,
    keyResult: ServerKeyResult,
    input: CreateProviderInput,
): GitProviderRecord {
    const key = requireKey(keyResult);
    // Validate BEFORE encrypting so a bad shape / missing token surfaces the
    // factory's clear message, not the crypto layer's empty-secret guard. This is also the
    // blank-container refusal (#266): `validateGitProviderConfig` checks the container FIRST
    // in all three per-type validators, via `isBlankContainer` — so a whitespace-only
    // org/workspace/group is refused here, inside the write function, before any row is built.
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
                last_sync_at, last_sync_status, last_sync_error, last_sync_advisories
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
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
        //
        // `url` is part of it for self-hosted GitLab: `platform` on `gitlab.corp.example` and
        // `platform` on `gitlab.acquired.example` are DIFFERENT containers that
        // `providerContainer` spells identically, so leaving `url` mutable would let a PATCH
        // re-point a provider at another instance while every imported row, cursor and day of
        // retained history stayed attributed to it — exactly the silent relabelling this guard
        // exists to refuse. (The converse — two instances that both have a group named
        // `platform` — is not connectable under `UNIQUE(type, container)`; that limitation is
        // stated in the 409 rather than worked around here.)
        //
        // The container comparison goes through the shared `sameContainer` (#266), so BOTH
        // sides are normalized and the predicate has one definition here, in the admin route's
        // collision pre-check, and in the client's inline check. Without it, "re-typing the
        // same workspace in different case" would read as a move and be refused — a lie, since
        // the pair did not change, and one the admin edit form would hit on every save (it
        // re-sends the container verbatim).
        //
        // `url` is deliberately still compared RAW, and that asymmetry is out of #266's scope
        // rather than an oversight. It is not a double-count risk — `UNIQUE(type, container)`
        // already makes two same-named groups on different instances unconnectable, so no two rows
        // can disagree only by `url`. It IS a UX wart: a client that re-sent
        // `https://gitlab.example.com/` where the row stores it without the trailing slash would
        // get `container_immutable` on a PATCH that changed nothing. The admin form round-trips the
        // stored value verbatim, so it cannot happen from the UI. Normalizing a URL is a different
        // rule from normalizing a container (scheme, host case, default port, trailing slash), and
        // `trimTrailingSlash` in `summaries/model-client.ts` is only a third of it.
        if (
            fields.type !== existing.type ||
            !sameContainer(fields.container, existing.container) ||
            fields.url !== existing.url
        ) {
            throw new GitProviderStoreError(
                'container_immutable',
                `A provider's type, container and self-hosted URL cannot be changed ` +
                    `(${existing.type}/${existing.container}${existing.url ? ` @ ${existing.url}` : ''} → ` +
                    `${fields.type}/${fields.container}${fields.url ? ` @ ${fields.url}` : ''}): its imported ` +
                    'data and sync cursors are keyed by them. Delete this provider — which now removes ' +
                    'exactly its own data — and add the new one.',
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
    /**
     * The run's ADVISORY lines (#289) — recorded on BOTH statuses, because a run that
     * failed can still have reported an irreversible commit drop before it did, and that
     * report must not be lost to the failure beside it.
     *
     * The caller classifies AND orders. `isAdvisoryError` (connectors/git/sync.ts) is the
     * single classifier every consumer shares; this function persists what it is handed and
     * does not re-derive the split, so passing a genuine failure here would hide it from the
     * red/green surface. It is likewise handed the list MOST-IMPORTANT-FIRST — see
     * {@link MAX_STORED_ADVISORIES} for why that matters and `rankAdvisories` (beside the
     * sentinels, which is where their relative severity is knowable) for the ordering.
     *
     * Omitted (or empty) clears the column — this describes the LAST run, exactly like
     * `error` beside it, so a run that reported nothing must not leave the previous run's
     * advisories standing as if they were its own.
     *
     * @see isAdvisoryError in `src/connectors/git/sync.ts` — the classifier this trusts.
     * @see rankAdvisories in `src/connectors/git/sync.ts` — the ordering this assumes.
     */
    advisories?: readonly string[];
}

/**
 * How many advisory lines a provider row will store for one run.
 *
 * A bound, not a preference. Several sentinels emit ONE LINE PER REPO
 * (`COMMITS_DROPPED_PREFIX` is per repo, and a systemic response-shape problem hits every
 * repo at once), so an unbounded column would let a 500-repo org write hundreds of
 * kilobytes into a row that `GET /api/admin/git/providers` then serves for EVERY provider
 * on every 1s poll while a sync is in flight.
 *
 * The cap truncates the TAIL, which is only safe because the caller hands the list in
 * importance order (`rankAdvisories`). Arrival order is close to the INVERSE of importance —
 * the permanent-loss lines are appended after the write transaction, behind every healed-retry
 * line the run produced — so a cap applied to the raw order would evict exactly the report
 * this column exists to keep.
 */
export const MAX_STORED_ADVISORIES = 20;

/**
 * How many characters of ONE stored text value this row will keep — one advisory line, or
 * the whole `last_sync_error` summary.
 *
 * The second axis of the same bound, and not redundant with the line cap: a single line can
 * be arbitrarily long on its own. `UNMATCHED_AUTHORS_PREFIX` joins the WHOLE unmatched-author
 * set into one entry, and on the first sync of a not-yet-mapped org that is every author in
 * the history — ~70-100 KB for a 2,000-author org, which passes a 20-LINE cap untouched.
 *
 * It governs BOTH columns because the hazard is the row, not the column: `last_sync_error` is
 * written by the same statement, from the same per-repo fan-out (one entry per failed repo
 * fetch, joined), and served by the same `GET /api/admin/git/providers` on the same 1s poll —
 * so a 500-repo org with an expired token would ship a megabyte-scale row once a second. A
 * bound that stopped at the advisory column would be a bound on the smaller of two identical
 * hazards. The invariant to hold is "this row is bounded".
 *
 * SIZED FROM A MEASUREMENT, not from an estimate of the prose. The longest single-purpose
 * advisory is `COMMIT_CHURN_UNKNOWN_PREFIX`, which embeds the permanent-span repair
 * instruction AND a five-sha sample: at its worst realistic inputs (full 40-hex shas, a long
 * repo path, a `(+N more)` tail) the emitted LINE measures ~1.9 KB — the repair prose alone
 * is only ~0.5 KB, so sizing against the paragraph rather than the line is what put an
 * earlier 2 KB cap underneath it. (It measured ~2.15 KB until IG1.2/#318 collapsed the repair
 * from a delete-and-re-add procedure to a cursor purge; the cap is unchanged, the headroom grew.) That is also the line `rankAdvisories` moves to the FRONT
 * as permanent loss, so a cap below it would mangle precisely the report the ranking exists
 * to protect, cutting the `Affected: <shas>` tail an operator verifies the loss with. 4 KB
 * leaves ~1.8 KB of headroom for a longer container path or future prose.
 *
 * `tests/connectors/git/commit-loss.test.ts` pins the real line against this constant from
 * BOTH sides — it fails if the line outgrows the cap, and equally if the measurement this
 * number was chosen from stops being true — and round-trips it through the store to prove the
 * emitted line and the stored one are the same string. It is a bound, not an early warning:
 * prose can still grow ~1.8 KB before anything fails. Re-measure rather than re-estimate if
 * that headroom is spent.
 *
 * Together the two caps bound the advisory column at roughly `20 × 4 KB` ≈ 80 KB worst case,
 * with the realistic case far below it (most lines are a few hundred bytes).
 */
export const MAX_STORED_COLUMN_CHARS = 4_000;

/**
 * The line appended in place of the advisories the cap dropped.
 *
 * Exported so a test asserts against the string the code actually emits rather than a copy
 * of it, and so the truncation is never SILENT: a reader of the column is told the count it
 * is not seeing and where the full set lives, instead of reading 20 lines as "that was all
 * of them".
 *
 * The surface it names is a CONTRACT on the caller, not a guess: a caller that bounds this
 * column must also write the complete, unbounded set to the server log for the same run.
 * The one caller today — the admin scoped-sync route — does exactly that, and a route test
 * pins it. Naming `toprope sync git` or `sync_logs.errors` here would be worse than saying
 * nothing: neither holds THIS run's advisories (this column is only ever written by the
 * scoped admin path, which is neither the CLI nor the scheduled path), so it would send an
 * operator to look somewhere guaranteed to be empty.
 */
export function advisoriesTruncatedLine(omitted: number): string {
    return (
        `… and ${omitted} more advisory line(s) omitted — this row keeps at most ` +
        `${MAX_STORED_ADVISORIES}. The complete set for this run was written to the server ` +
        'log, keyed by this provider id.'
    );
}

/**
 * The marker appended to one stored value the character cap cut.
 *
 * Same reason as {@link advisoriesTruncatedLine}: a silently shortened value reads as a
 * complete one, and these lines can end in an operator instruction.
 */
export function columnTextTruncatedSuffix(): string {
    return `… [truncated at ${MAX_STORED_COLUMN_CHARS} characters — see the server log]`;
}

/**
 * The character cap, applied to one stored text value.
 *
 * Sliced with `Array.from` rather than `String.prototype.slice` so the cut lands on a code
 * POINT boundary: cutting by UTF-16 code unit can leave a lone surrogate, which round-trips
 * through JSON intact and then renders as U+FFFD in the provider row.
 */
function boundStoredText(value: string): string {
    const points = Array.from(value);
    return points.length <= MAX_STORED_COLUMN_CHARS
        ? value
        : points.slice(0, MAX_STORED_COLUMN_CHARS).join('') + columnTextTruncatedSuffix();
}

// Apply both caps, naming what each one dropped. Kept beside the constants they enforce so
// the "no silent caps" property is one function, not a rule spread across call sites.
// Assumes an importance-ordered input — see MAX_STORED_ADVISORIES.
function boundAdvisories(advisories: readonly string[]): string[] {
    const kept = advisories.slice(0, MAX_STORED_ADVISORIES).map(boundStoredText);
    const omitted = advisories.length - kept.length;
    return omitted > 0 ? [...kept, advisoriesTruncatedLine(omitted)] : kept;
}

// Runtime allowlist for the outcome status (review-rule: allowlist at the write
// boundary, not just the compile-time union) — a value the row CHECK would reject
// is refused here first, with a clear message rather than a raw SQLITE_CONSTRAINT.
const SYNC_OUTCOME_STATUSES: readonly SyncOutcomeStatus[] = ['ok', 'error'];

/**
 * Persist the terminal result of a sync-now run (GC1.7 / #199) onto the provider
 * row: `last_sync_at`, `last_sync_status`(ok|error), `last_sync_error`, and
 * `last_sync_advisories`. On `ok` the error column is cleared; on `error` a non-blank
 * summary is stored (a failed sync must surface its message to the UI, never a swallowed
 * error — so a missing/blank message is coerced to a generic non-null sentinel rather than
 * left NULL, which the UI would read as "clean"). Returns true when the row
 * existed and was updated. Fail-closed on an unknown status.
 *
 * The advisory column is written on BOTH statuses and is INDEPENDENT of the red/green one
 * (#289): recording an advisory must never be what turns a provider red, and a provider
 * turning red must never be what discards its advisories. One UPDATE writes all four, so a
 * row can never hold one run's status beside another run's report.
 */
export function recordSyncOutcome(db: Database.Database, id: string, outcome: SyncOutcome): boolean {
    if (!SYNC_OUTCOME_STATUSES.includes(outcome.status)) {
        throw new GitProviderStoreError(
            'not_found',
            `Refusing to record unknown sync status: "${String(outcome.status)}"`,
        );
    }
    // On error a non-null message is mandatory (see doc); on ok it is always NULL. Bounded by
    // the SAME cap as an advisory line: this column is fed by the same per-repo fan-out, in
    // the same UPDATE, and served on the same 1s poll — see MAX_STORED_COLUMN_CHARS.
    const errorText =
        outcome.status === 'error'
            ? boundStoredText(
                  outcome.error && outcome.error.trim() !== ''
                      ? outcome.error
                      : 'Sync failed (no error message)',
              )
            : null;
    const advisoriesText = encodeStringArrayColumn(boundAdvisories(outcome.advisories ?? []));
    const changes = db
        .prepare(
            `UPDATE git_providers
             SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?, last_sync_advisories = ?
             WHERE id = ?`,
        )
        .run(outcome.at, outcome.status, errorText, advisoriesText, id).changes;
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
        // Flattened to `[]` rather than passed through as null: the wire field answers
        // "what did the last run report", and one spelling of "nothing" is enough for a
        // client that only ever wants to iterate it.
        //
        // Guarded on the TYPE, not on `=== null`, because the record is a `SELECT *` row
        // cast to `GitProviderRecord` — a cast is not a runtime type. Two reachable values
        // the narrower check would pass straight into the decoder: `undefined`, on a
        // database where migration 045 has not been applied (the column does not exist, so
        // the property is absent), and `''` from a hand-edited row. Both would come back
        // out of the tolerant decoder as a one-entry list, and the UI would render a
        // phantom advisory with a blank bullet on every provider.
        last_sync_advisories:
            typeof record.last_sync_advisories === 'string' && record.last_sync_advisories !== ''
                ? decodeStringArrayColumn(record.last_sync_advisories)
                : [],
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
