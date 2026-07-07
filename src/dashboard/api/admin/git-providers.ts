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
    getProvider,
    listProviders,
    toPublicProvider,
    updateProvider,
    GitProviderStoreError,
    type PublicGitProvider,
} from '../../../connectors/git/providers/store';
import {loadServerKey} from '../../../connectors/git/providers/secret';
import {providerContainer, resolveGitProviderConfigs} from '../../../connectors/git/providers/config';
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
 * The masked provider DTO the admin API returns. A superset of the store's
 * {@link PublicGitProvider} with a `source` discriminator; `created_at`/
 * `updated_at` are nullable because config-file providers have no lifecycle
 * timestamps. Never carries token ciphertext/plaintext.
 */
export interface AdminGitProviderDto extends Omit<PublicGitProvider, 'created_at' | 'updated_at'> {
    source: ProviderSource;
    created_at: string | null;
    updated_at: string | null;
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
    };
}

function dbProviderToDto(record: Parameters<typeof toPublicProvider>[0]): AdminGitProviderDto {
    return {...toPublicProvider(record), source: 'db'};
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

    app.get('/api/admin/git/providers', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        // DB providers first (store's deterministic created_at, id order), then
        // config-file providers in declaration order — a total, stable ordering.
        const dbRows = listProviders(db).map(dbProviderToDto);
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
                return {data: dbProviderToDto(record)};
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
}
