import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    asObject,
    badRequest,
    conflict,
    forbidden,
    isAdmin,
    notFound,
    serviceUnavailable,
} from './helpers';
import {
    createProvider,
    deleteProvider,
    getDecryptedConfig,
    getProvider,
    listProviders,
    recordSyncOutcome,
    toPublicProvider,
    updateProvider,
    GitProviderStoreError,
    type PublicGitProvider,
} from '../../../connectors/git/providers/store';
import {loadServerKey} from '../../../connectors/git/providers/secret';
import {providerContainer, resolveGitProviderConfigs} from '../../../connectors/git/providers/config';
import {createGitProvider} from '../../../connectors/git/providers/factory';
import {
    GitSync,
    UNMATCHED_AUTHORS_PREFIX,
    FIRST_SYNC_WINDOW_MIN_MONTHS,
    FIRST_SYNC_WINDOW_MAX_MONTHS,
    FIRST_SYNC_WINDOW_DEFAULT_MONTHS,
    syncStateKey,
    loadProviderCursorKeys,
    type GitSyncProgress,
} from '../../../connectors/git/sync';
import {gitProviderFixHint} from '../../../cli/doctor';
import type {GitConnectorConfig} from '../../../config/types';
import type {GitProviderConfig, GitProviderType} from '../../../connectors/git/providers/types';

/**
 * Admin CRUD API for git providers (GC1.5 / #197).
 *
 * Mirrors `admin/developers.ts`: every route is `isAdmin`-gated server-side (the
 * server is the trust boundary even though the UI also hides non-admin surfaces).
 * Sits on top of the provider store (#195), which owns encryption, the masked
 * projection, and fail-closed key handling; this layer only parses/validates the
 * wire body, maps typed store errors to HTTP statuses, and merges read-only
 * config-file providers into the list.
 *
 * Token discipline (cross-cutting epic criterion): tokens are write-only. A
 * plaintext token is accepted on create/update and immediately encrypted by the
 * store; NO response ever carries ciphertext or plaintext — only `token_last4` +
 * a mask, via {@link toPublicProvider}. Config-file providers expose no token
 * material at all (see {@link configProviderToDto}).
 */

/** Where a provider row comes from: the DB (editable) or a config file (read-only). */
type ProviderSource = 'db' | 'config';

/**
 * Live state of an in-flight sync-now run, surfaced on the provider list so the
 * UI can poll it (#209). `progress` is the pipeline's latest snapshot, null
 * until the first emission lands. The same object doubles as the in-memory
 * registry entry the sync route maintains — one shape, nothing to map.
 */
export interface ActiveSyncDto {
    started_at: string;
    progress: GitSyncProgress | null;
}

/**
 * The masked provider DTO the admin API returns. A superset of the store's
 * {@link PublicGitProvider} with a `source` discriminator; `created_at`/
 * `updated_at` are nullable because config-file providers have no lifecycle
 * timestamps. Never carries token ciphertext/plaintext. `active_sync` is
 * non-null only while a sync-now run is in flight for this provider (#209) —
 * process-local state, so it is always null for config rows (they sync via the
 * scheduled pipeline only).
 */
export interface AdminGitProviderDto extends Omit<PublicGitProvider, 'created_at' | 'updated_at'> {
    source: ProviderSource;
    created_at: string | null;
    updated_at: string | null;
    active_sync: ActiveSyncDto | null;
    /**
     * True when this provider has NEVER completed a sync — i.e. it has no stored
     * pipeline cursor yet. This is the real "first sync pending" gate the "Sync now"
     * first-sync history-window input keys off (#228), NOT the row's `last_sync_at`:
     * the cursor is written by the pipeline on every path (sync-now, scheduler, CLI)
     * whereas `last_sync_at` is written only by the sync-now route, so they diverge
     * after a scheduled/CLI first sync. Always false for config-file rows (read-only;
     * they never show the window input).
     */
    first_sync_pending: boolean;
}

/**
 * The status handle a sync-now trigger returns (GC1.7 / #199). The POST is
 * fire-and-forget: it resolves + starts the run, then returns this immediately
 * with `status: 'running'`. The DURABLE outcome (ok|error + message + timestamp)
 * lands on the provider row's `last_sync_*` columns, which the list endpoint
 * already surfaces — so the UI polls the list to observe completion rather than a
 * separate status endpoint.
 */
interface SyncTriggerHandle {
    provider_id: string;
    status: 'running';
    started_at: string;
}

// A 400 the wire-body parser raises for a malformed/unknown request shape. Kept
// distinct from the store/factory errors so the route maps it straight to a 400
// typed error (fail-closed on unknown type/auth_method) rather than a 500.
class BadProviderRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BadProviderRequestError';
    }
}

// The synthetic id a config-file provider carries in the list. Config providers
// have no DB row, so we mint a deterministic id from (type, container) — stable
// across requests and disjoint from the store's randomUUID ids. Membership in the
// config-id set (not prefix-parsing) is what marks a PATCH/DELETE target as
// read-only, so a value can't masquerade as config by shape alone.
function configProviderId(config: GitProviderConfig): string {
    return `config:${config.type}:${providerContainer(config)}`;
}

// Enabled runtime allowlists for the closed unions. Validated here at the trust
// boundary (not only via the compile-time union) so a future/request-supplied
// value that isn't a real provider type/auth method is rejected fail-closed.
const PROVIDER_TYPES: readonly GitProviderType[] = ['github', 'bitbucket', 'gitlab'];
const AUTH_METHODS: Record<GitProviderType, readonly string[]> = {
    github: ['token'],
    bitbucket: ['app_password', 'access_token', 'oauth'],
    gitlab: ['personal_access_token', 'oauth', 'job_token'],
};

// Read a required non-empty string field, or fail closed with a clear message.
function requireString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new BadProviderRequestError(`${field} is required and must be a non-empty string`);
    }
    return value.trim();
}

// Read an optional string field: undefined when omitted, else a trimmed non-empty
// string (blank is rejected — an explicitly empty value is a client bug, not "clear").
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new BadProviderRequestError(`${field} must be a string`);
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

// Read an optional repos list: undefined when omitted ("monitor all"); otherwise
// it must be an array of strings (an empty array is allowed and preserved).
function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new BadProviderRequestError(`${field} must be an array of strings`);
    }
    return value as string[];
}

// Read an optional boolean, rejecting non-boolean values (no truthiness coercion).
function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
        throw new BadProviderRequestError(`${field} must be a boolean`);
    }
    return value;
}

// Parse the optional first-sync history window (in months) from the /sync body.
// An absent body or absent `months` field ⇒ the default window. A PRESENT value is
// validated fail-closed at this trust boundary: it must be an integer within the
// hard bounds — a non-number, non-integer, or out-of-range value is a 400, never
// silently coerced or clamped (an admin typo must not quietly disable the guard or
// re-drain the whole rate-limit budget). The pipeline only honors it on a
// provider's first sync; once a cursor exists it is ignored regardless.
function parseFirstSyncWindowMonths(rawBody: unknown): number {
    const body = asObject(rawBody);
    if (!body || body.months === undefined || body.months === null) {
        return FIRST_SYNC_WINDOW_DEFAULT_MONTHS;
    }
    const value = body.months;
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < FIRST_SYNC_WINDOW_MIN_MONTHS ||
        value > FIRST_SYNC_WINDOW_MAX_MONTHS
    ) {
        throw new BadProviderRequestError(
            `months must be an integer between ${FIRST_SYNC_WINDOW_MIN_MONTHS} and ${FIRST_SYNC_WINDOW_MAX_MONTHS}`,
        );
    }
    return value;
}

function parseProviderType(body: Record<string, unknown>): GitProviderType {
    const raw = body.type;
    if (typeof raw !== 'string' || !PROVIDER_TYPES.includes(raw as GitProviderType)) {
        throw new BadProviderRequestError(
            `type must be one of: ${PROVIDER_TYPES.join(', ')}`,
        );
    }
    return raw as GitProviderType;
}

function parseAuthMethod(type: GitProviderType, body: Record<string, unknown>): string {
    const allowed = AUTH_METHODS[type];
    // GitHub has a single auth method; default it so the UI form can omit it.
    const raw = body.auth_method ?? (type === 'github' ? 'token' : undefined);
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
        throw new BadProviderRequestError(
            `auth_method for ${type} must be one of: ${allowed.join(', ')}`,
        );
    }
    return raw;
}

/**
 * What the wire body parses into: a fully-shaped {@link GitProviderConfig} plus
 * the plaintext `token` threaded separately. On create `token` is always present;
 * on update it is `undefined` when the client omits it (keep the stored secret).
 *
 * The config's auth carries `token` inlined when present, or the empty string as
 * a placeholder on update-without-token — the store's `updateProvider` overwrites
 * that placeholder with the decrypted existing secret before it validates, so the
 * placeholder never reaches persistence.
 */
interface ParsedProviderBody {
    config: GitProviderConfig;
    token: string | undefined;
    enabled: boolean | undefined;
}

// Build the provider config union from the wire body, failing closed on any
// unknown/invalid field BEFORE the token is touched. `tokenRequired` is true on
// create (a create with no token is rejected) and false on update (omitted token
// means "keep the stored one").
function parseProviderBody(body: Record<string, unknown>, tokenRequired: boolean): ParsedProviderBody {
    const type = parseProviderType(body);
    const authMethod = parseAuthMethod(type, body);
    const container = requireString(body, 'container');
    const token = optionalString(body, 'token');
    if (tokenRequired && token === undefined) {
        throw new BadProviderRequestError('token is required');
    }
    const enabled = optionalBoolean(body, 'enabled');
    const repos = optionalStringArray(body, 'repos');
    // The auth secret placeholder: the real token when supplied, else '' on
    // update (updateProvider replaces it with the stored secret before validating).
    const secret = token ?? '';

    let config: GitProviderConfig;
    switch (type) {
        case 'github': {
            config = {type: 'github', org: container, auth: {type: 'token', api_token: secret}};
            if (repos !== undefined) config.repos = repos;
            const exclude = optionalStringArray(body, 'exclude_repos');
            if (exclude !== undefined) config.exclude_repos = exclude;
            break;
        }
        case 'bitbucket': {
            if (authMethod === 'app_password') {
                const username = requireString(body, 'username');
                config = {
                    type: 'bitbucket',
                    workspace: container,
                    auth: {type: 'app_password', username, app_password: secret},
                };
            } else if (authMethod === 'access_token') {
                config = {type: 'bitbucket', workspace: container, auth: {type: 'access_token', token: secret}};
            } else {
                config = {type: 'bitbucket', workspace: container, auth: {type: 'oauth', token: secret}};
            }
            if (repos !== undefined) config.repos = repos;
            const exclude = optionalStringArray(body, 'exclude_repos');
            if (exclude !== undefined) config.exclude_repos = exclude;
            break;
        }
        case 'gitlab': {
            const url = optionalString(body, 'url');
            const includeSubgroups = optionalBoolean(body, 'include_subgroups');
            if (authMethod === 'personal_access_token') {
                config = {type: 'gitlab', group: container, auth: {type: 'personal_access_token', token: secret}};
            } else if (authMethod === 'oauth') {
                config = {type: 'gitlab', group: container, auth: {type: 'oauth', token: secret}};
            } else {
                config = {type: 'gitlab', group: container, auth: {type: 'job_token', token: secret}};
            }
            if (url !== undefined) config.url = url;
            if (includeSubgroups !== undefined) config.include_subgroups = includeSubgroups;
            if (repos !== undefined) config.repos = repos;
            break;
        }
        default: {
            const exhaustive: never = type;
            throw new BadProviderRequestError(`Unsupported provider type: ${String(exhaustive)}`);
        }
    }

    return {config, token, enabled};
}

// The masked config-file provider DTO. Config providers are read-only and their
// secret lives in YAML, not the DB — so we surface NO token material at all (not
// even last4): just the fixed mask. Everything else mirrors the store DTO shape.
function configProviderToDto(config: GitProviderConfig): AdminGitProviderDto {
    const repos = config.repos !== undefined ? JSON.stringify(config.repos) : null;
    const excludeRepos =
        config.type !== 'gitlab' && config.exclude_repos !== undefined
            ? JSON.stringify(config.exclude_repos)
            : null;
    return {
        id: configProviderId(config),
        source: 'config',
        type: config.type,
        container: providerContainer(config),
        url: config.type === 'gitlab' ? config.url ?? null : null,
        include_subgroups:
            config.type === 'gitlab' && config.include_subgroups !== undefined
                ? config.include_subgroups
                : null,
        auth_method: config.auth.type,
        auth_username:
            config.type === 'bitbucket' && config.auth.type === 'app_password'
                ? config.auth.username
                : null,
        token_last4: null,
        token_masked: '••••',
        repos_include: repos,
        repos_exclude: excludeRepos,
        // Config providers are always active (the resolver only yields live ones);
        // there is no per-provider enable flag in config.
        enabled: true,
        created_at: null,
        updated_at: null,
        created_by: null,
        last_sync_at: null,
        last_sync_status: null,
        last_sync_error: null,
        active_sync: null,
        // Config rows are read-only and never show the window input.
        first_sync_pending: false,
    };
}

// `activeSync` is the route registration's in-flight entry for this row (null
// when no run is in flight — the common case for create/update responses).
// `firstSyncPending` is whether this provider still lacks a pipeline cursor; it
// defaults to true because the only caller that omits it is the create route
// (a brand-new provider has never synced). The list/patch routes derive it from
// the stored cursor set (see loadProviderCursorKeys).
function dbProviderToDto(
    record: Parameters<typeof toPublicProvider>[0],
    activeSync: ActiveSyncDto | null = null,
    firstSyncPending = true,
): AdminGitProviderDto {
    return {
        ...toPublicProvider(record),
        source: 'db',
        active_sync: activeSync,
        first_sync_pending: firstSyncPending,
    };
}

// Map a typed store error to an HTTP reply. secret_key_unconfigured is a
// fail-closed server-config condition (503, NOT 500); not_found is a typed 404.
function replyStoreError(reply: Parameters<typeof forbidden>[0], err: GitProviderStoreError): void {
    if (err.code === 'secret_key_unconfigured') {
        serviceUnavailable(reply, err.message);
        return;
    }
    notFound(reply, err.message);
}

/**
 * The clean probe-result envelope the test-connection endpoints return. A failed
 * probe is a *successful* execution of the "is this reachable?" job — it resolves
 * to `{ok:false}` with a typed error + a remediation hint, NEVER a thrown 500.
 */
interface ProbeResult {
    ok: boolean;
    error?: string;
    hint?: string;
}

// Run the cheap reachability/auth probe (checkAccess) against a fully-formed
// provider config via the canonical factory. Resolves to {ok:true} on success and
// a typed {ok:false, error, hint} on any failure (bad credentials, unreachable
// host, unknown org). The hint reuses doctor's `gitProviderFixHint` so UI errors
// read identically to `toprope doctor` (single source of remediation copy).
async function probeProvider(config: GitProviderConfig): Promise<ProbeResult> {
    try {
        await createGitProvider(config).checkAccess();
        return {ok: true};
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {ok: false, error: message, hint: gitProviderFixHint(config.type, message)};
    }
}

// A copy of the config with the include/exclude repo filter stripped (#217).
// The repo-scope PICKER must list the WHOLE workspace so an admin can add repos
// beyond the current selection — but every provider's `listRepos()` applies its
// own `shouldInclude()` against the config's `repos`/`exclude_repos`, so a saved
// provider would otherwise only ever list the repos it already syncs. Setting the
// optional filters to `undefined` (never mutating the stored config) makes
// `shouldInclude` accept everything; sync/doctor keep using the untouched config.
function repoListingConfig(config: GitProviderConfig): GitProviderConfig {
    const next: GitProviderConfig = {...config, repos: undefined};
    // exclude_repos exists only on github/bitbucket; gitlab has no such field.
    if (next.type !== 'gitlab') next.exclude_repos = undefined;
    return next;
}

/** Resolving a saved provider id to its full config: found, unknown, or key-blocked. */
type SavedConfigResult =
    | {kind: 'ok'; config: GitProviderConfig}
    | {kind: 'not_found'}
    | {kind: 'key_error'; message: string};

// Resolve a SAVED provider (DB row or read-only config-file) by id to its full
// GitProviderConfig incl. the plaintext token, for a test/repos probe. Config
// providers carry their token inline (no key needed); DB providers are decrypted
// with the server key (fail-closed → key_error). Existence is checked BEFORE the
// key so an unknown id is a 404 even when the key is unconfigured (matches PATCH).
// Membership in the config-id set — not prefix-parsing — decides the source, so a
// crafted id can't masquerade as config by shape alone.
function resolveSavedConfig(
    db: Database.Database,
    configs: GitProviderConfig[],
    id: string,
): SavedConfigResult {
    const configMatch = configs.find((c) => configProviderId(c) === id);
    if (configMatch) return {kind: 'ok', config: configMatch};
    if (getProvider(db, id) === undefined) return {kind: 'not_found'};
    try {
        const config = getDecryptedConfig(db, loadServerKey(), id);
        // getProvider just confirmed the row exists, so decrypt can't miss it.
        if (config === undefined) return {kind: 'not_found'};
        return {kind: 'ok', config};
    } catch (err) {
        if (err instanceof GitProviderStoreError && err.code === 'secret_key_unconfigured') {
            return {kind: 'key_error', message: err.message};
        }
        throw err;
    }
}

/**
 * Register the admin git-provider CRUD routes. `gitConfig` (optional) is the git
 * connector config; when present, its config-file providers are merged into the
 * GET list as read-only `source: "config"` rows. Omitting it (e.g. in a test that
 * only exercises DB providers) simply yields a DB-only list.
 */
export function registerAdminGitProviderRoutes(
    app: FastifyInstance,
    db: Database.Database,
    gitConfig?: GitConnectorConfig,
): void {
    // Resolve the config-file providers once per request from the (immutable at
    // runtime) git config. Deterministic order: config declaration order.
    const configProviders = (): GitProviderConfig[] =>
        gitConfig ? resolveGitProviderConfigs(gitConfig) : [];

    // Overlap guard AND live-progress registry for sync-now (#199/#209): one
    // entry per provider id with an in-flight run, carrying its start time and
    // the pipeline's latest progress snapshot (served on the list as
    // `active_sync`). Scoped to THIS route registration (one per app) so it is
    // process-local and test-isolated — a fresh app in a test starts empty. A
    // second trigger for an id already present is rejected (409), so no two
    // overlapping runs ever write the same provider's snapshots.
    const activeSyncs = new Map<string, ActiveSyncDto>();

    // A single GitSync bound to the same git config the list merge uses. Only its
    // churn-window setting is read on the syncProviders path (providers are passed
    // in explicitly), so a config-less registration still syncs correctly — the
    // fallback carries `enabled: false` only to satisfy the base-config shape.
    const gitSync = new GitSync(gitConfig ?? {enabled: false});

    app.get('/api/admin/git/providers', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        // DB providers first (store's deterministic created_at, id order), then
        // config-file providers in declaration order — a total, stable ordering.
        // Resolve the stored cursor set ONCE (not per row) to drive first_sync_pending.
        const cursorKeys = loadProviderCursorKeys(db);
        const dbRows = listProviders(db).map((record) =>
            dbProviderToDto(
                record,
                activeSyncs.get(record.id) ?? null,
                !cursorKeys.has(syncStateKey(record.type, record.container)),
            ),
        );
        const configRows = configProviders().map(configProviderToDto);
        return {data: [...dbRows, ...configRows]};
    });

    app.post<{Body: unknown}>('/api/admin/git/providers', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const body = asObject(request.body);
        if (!body) return badRequest(reply, 'Request body must be an object');

        let parsed: ParsedProviderBody;
        try {
            parsed = parseProviderBody(body, true);
        } catch (err) {
            if (err instanceof BadProviderRequestError) return badRequest(reply, err.message);
            throw err;
        }

        try {
            const record = createProvider(db, loadServerKey(), {
                config: parsed.config,
                enabled: parsed.enabled,
                createdBy: request.authUser?.userId ?? null,
            });
            reply.status(201);
            return {data: dbProviderToDto(record)};
        } catch (err) {
            if (err instanceof GitProviderStoreError) return replyStoreError(reply, err);
            // A factory/validation failure (e.g. missing org) is a client bad
            // request, not a server crash.
            return badRequest(reply, err instanceof Error ? err.message : String(err));
        }
    });

    app.patch<{Params: {id: string}; Body: unknown}>(
        '/api/admin/git/providers/:id',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const {id} = request.params;

            // Config-file providers are read-only in the UI (LOCKED decision).
            if (configProviders().some((c) => configProviderId(c) === id)) {
                return conflict(reply, 'Config-file providers are read-only and cannot be edited');
            }
            // Existence is checked up front so a not-found returns a typed 404 even
            // when the secret key is unconfigured (fail-closed key only gates writes).
            if (getProvider(db, id) === undefined) {
                return notFound(reply, `Git provider not found: ${id}`);
            }

            const body = asObject(request.body);
            if (!body) return badRequest(reply, 'Request body must be an object');

            let parsed: ParsedProviderBody;
            try {
                parsed = parseProviderBody(body, false);
            } catch (err) {
                if (err instanceof BadProviderRequestError) return badRequest(reply, err.message);
                throw err;
            }

            try {
                const record = updateProvider(db, loadServerKey(), id, {
                    config: parsed.config,
                    token: parsed.token,
                    enabled: parsed.enabled,
                });
                // An edit may rename the container (and thus the cursor key), so
                // recompute first_sync_pending against the stored cursor set.
                const cursorKeys = loadProviderCursorKeys(db);
                return {
                    data: dbProviderToDto(
                        record,
                        activeSyncs.get(id) ?? null,
                        !cursorKeys.has(syncStateKey(record.type, record.container)),
                    ),
                };
            } catch (err) {
                if (err instanceof GitProviderStoreError) return replyStoreError(reply, err);
                return badRequest(reply, err instanceof Error ? err.message : String(err));
            }
        },
    );

    app.delete<{Params: {id: string}}>('/api/admin/git/providers/:id', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const {id} = request.params;

        if (configProviders().some((c) => configProviderId(c) === id)) {
            return conflict(reply, 'Config-file providers are read-only and cannot be deleted');
        }
        if (!deleteProvider(db, id)) {
            return notFound(reply, `Git provider not found: ${id}`);
        }
        return {data: {id, deleted: true}};
    });

    // POST /:id/test — probe a SAVED provider (DB or read-only config-file) by
    // reusing provider.checkAccess(). A failed probe is a 200 with {ok:false}: the
    // request was processed; only the *result* is a reachability/auth failure.
    app.post<{Params: {id: string}}>(
        '/api/admin/git/providers/:id/test',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const {id} = request.params;
            const resolved = resolveSavedConfig(db, configProviders(), id);
            if (resolved.kind === 'not_found') return notFound(reply, `Git provider not found: ${id}`);
            if (resolved.kind === 'key_error') return serviceUnavailable(reply, resolved.message);
            return probeProvider(resolved.config);
        },
    );

    // POST /test — probe a DRAFT (unsaved) provider from the submitted body. The
    // token comes from the request and NOTHING is persisted. Validation reuses the
    // same fail-closed parser as create (parseProviderBody) — unknown type/auth or
    // a missing token is a 400 (can't probe without a credential).
    app.post<{Body: unknown}>('/api/admin/git/providers/test', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const body = asObject(request.body);
        if (!body) return badRequest(reply, 'Request body must be an object');

        let parsed: ParsedProviderBody;
        try {
            // tokenRequired = true: a draft with no credential can't be probed.
            parsed = parseProviderBody(body, true);
        } catch (err) {
            if (err instanceof BadProviderRequestError) return badRequest(reply, err.message);
            throw err;
        }
        // parsed.config carries the submitted token inline; no DB write occurs.
        return probeProvider(parsed.config);
    });

    // GET /:id/repos — enumerate a SAVED provider's repositories for the picker.
    // Returns {slug, name, archived, defaultBranch} (#213): `slug` is the CANONICAL
    // identifier (GitRepo.name — GitHub repo name, Bitbucket slug, GitLab path)
    // that stored repo-scope filters match against and that saves must send back;
    // `name` is the provider's human-readable display name, display-only.
    //
    // Accepted risk (#213 review): pre-#213 this projection's `name` WAS the
    // canonical id, so a stale cached bundle that PATCHes `name` values back as
    // `repos` would store display names that match nothing at sync time; the
    // reverse skew (new bundle, old server) just crashes the picker on the
    // missing `slug` field and corrupts nothing. Server and bundle deploy
    // together, the window is one un-refreshed tab, and both directions
    // self-heal on refresh/re-save — deliberately NOT validated server-side (a
    // probe on every save would fail saves whenever the provider is unreachable).
    //
    // A failed listing is a clean 502 {ok:false}, not a 500.
    app.get<{Params: {id: string}}>(
        '/api/admin/git/providers/:id/repos',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const {id} = request.params;
            const resolved = resolveSavedConfig(db, configProviders(), id);
            if (resolved.kind === 'not_found') return notFound(reply, `Git provider not found: ${id}`);
            if (resolved.kind === 'key_error') return serviceUnavailable(reply, resolved.message);

            try {
                // List the FULL workspace (filter stripped) so the picker can
                // offer repos beyond the saved selection (#217).
                const repos = await createGitProvider(repoListingConfig(resolved.config)).listRepos();
                return {
                    data: repos.map((r) => ({
                        slug: r.name,
                        // Fall back to the canonical name when the provider has
                        // no distinct display name (GitHub always; a Bitbucket/
                        // GitLab response missing the field). `||` deliberately:
                        // an empty-string display name must not blank the cell.
                        name: r.displayName || r.name,
                        archived: r.isArchived,
                        defaultBranch: r.defaultBranch,
                    })),
                };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                reply.status(502);
                return {ok: false, error: message, hint: gitProviderFixHint(resolved.config.type, message)};
            }
        },
    );

    // POST /:id/sync — trigger a sync for ONE saved DB provider (GC1.7 / #199).
    // Fire-and-forget: it validates the target, starts the run on the shared
    // GitSync pipeline scoped to just this provider, and returns a 202 status
    // handle immediately. The terminal outcome is written to the row's last_sync_*
    // columns when the run settles (surfaced via the list endpoint). Only DB rows
    // are sync-able here: config-file providers are read-only (they sync via the
    // scheduled pipeline), so their synthetic ids are rejected like PATCH/DELETE.
    app.post<{Params: {id: string}; Body: unknown}>(
        '/api/admin/git/providers/:id/sync',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const {id} = request.params;

            // First-sync history window (months): validated fail-closed before any
            // work starts. Only applied on a provider's first sync (empty cursor);
            // the pipeline ignores it once a cursor exists, so pressing "Sync now"
            // again can't re-widen the window and double-count.
            let firstSyncWindowMonths: number;
            try {
                firstSyncWindowMonths = parseFirstSyncWindowMonths(request.body);
            } catch (err) {
                if (err instanceof BadProviderRequestError) return badRequest(reply, err.message);
                throw err;
            }

            // Config-file providers have no row to update and are read-only in the UI.
            if (configProviders().some((c) => configProviderId(c) === id)) {
                return conflict(
                    reply,
                    'Config-file providers are read-only and sync via the scheduled pipeline, not individually',
                );
            }

            const record = getProvider(db, id);
            if (record === undefined) {
                return notFound(reply, `Git provider not found: ${id}`);
            }
            // A disabled provider is intentionally excluded from syncs — typed 409,
            // not a silent no-op, so the UI can tell the admin to enable it first.
            if (record.enabled !== 1) {
                return conflict(reply, 'Provider is disabled; enable it before syncing');
            }
            // Overlap guard: reject a duplicate trigger while a run is in flight so
            // two overlapping runs never write the same provider's snapshots.
            if (activeSyncs.has(id)) {
                return conflict(reply, 'A sync is already in progress for this provider');
            }

            // Resolve the plaintext config (fail-closed on the server key) BEFORE
            // marking the run in-flight, so a key-config error is a clean 503 and
            // never leaves a stuck in-flight entry.
            let config: GitProviderConfig;
            try {
                const decrypted = getDecryptedConfig(db, loadServerKey(), id);
                // getProvider just confirmed the row exists; a concurrent delete is
                // the only miss and is treated as not-found.
                if (decrypted === undefined) {
                    return notFound(reply, `Git provider not found: ${id}`);
                }
                config = decrypted;
            } catch (err) {
                if (err instanceof GitProviderStoreError && err.code === 'secret_key_unconfigured') {
                    return serviceUnavailable(reply, err.message);
                }
                throw err;
            }

            const startedAt = new Date().toISOString();
            // The registry entry is mutated in place by the progress listener
            // below; the GET list serves whatever snapshot it holds right now.
            const active: ActiveSyncDto = {started_at: startedAt, progress: null};
            activeSyncs.set(id, active);

            // Kick off the run without awaiting it. syncProviders reuses the exact
            // fetch→merge→upsert pipeline, scoped to just this provider. Whatever
            // the outcome, we persist it to the row and clear the in-flight flag.
            //
            // Scoping note: like the scheduled sync, this is incremental (per-provider
            // `since` sync-state) and the snapshot upsert is keyed on (developer_id,
            // date). A run with no new commits in its window writes no snapshot; a run
            // WITH new commits behaves exactly as a full scheduled sync does when only
            // this provider has new commits in the window. Cross-provider same-day
            // merge accuracy is a property of that shared pipeline model (owned by the
            // git-sync design), not of this per-provider trigger — see the epic review.
            void gitSync
                .syncProviders(
                    db,
                    [config],
                    (progress) => {
                        active.progress = progress;
                    },
                    {firstSyncWindowMonths},
                )
                .then((result) => {
                    // A sync that ran but collected per-repo/provider errors is an
                    // error outcome with a surfaced message — never swallowed. But
                    // the "unmatched authors" advisory is NOT a failure (CI bots and
                    // external contributors are unmapped in nearly every real repo),
                    // so it must not flip a provider that synced fine to red. Classify
                    // and surface only genuine errors.
                    const genuineErrors = result.errors.filter(
                        (e) => !e.startsWith(UNMATCHED_AUTHORS_PREFIX),
                    );
                    if (genuineErrors.length > 0) {
                        recordSyncOutcome(db, id, {
                            status: 'error',
                            at: new Date().toISOString(),
                            error: genuineErrors.join('; '),
                        });
                    } else {
                        recordSyncOutcome(db, id, {status: 'ok', at: new Date().toISOString()});
                    }
                })
                .catch((err: unknown) => {
                    // A thrown failure (e.g. an unexpected pipeline crash) is still
                    // recorded as a status=error outcome, not lost.
                    const message = err instanceof Error ? err.message : String(err);
                    try {
                        recordSyncOutcome(db, id, {
                            status: 'error',
                            at: new Date().toISOString(),
                            error: message,
                        });
                    } catch (recordErr) {
                        request.log.error(
                            {err: recordErr, providerId: id},
                            'failed to record git sync error outcome',
                        );
                    }
                })
                .finally(() => {
                    activeSyncs.delete(id);
                });

            reply.status(202);
            const handle: SyncTriggerHandle = {provider_id: id, status: 'running', started_at: startedAt};
            return {data: handle};
        },
    );
}
