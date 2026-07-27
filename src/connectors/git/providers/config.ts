import type {GitProviderConfig, GitProviderType} from './types.js';
import type {GitConnectorConfig} from '../../../config/types.js';
import {normalizeContainer} from './container.js';

// Resolve the list of git provider configs from a git connector config.
// Prefers the explicit `providers` array; falls back to the legacy
// single-provider GitHub shorthand (org + api_token). Shared by the sync
// orchestrator and `toprope doctor` so both see the same providers.
export function resolveGitProviderConfigs(config: GitConnectorConfig): GitProviderConfig[] {
    if (Array.isArray(config.providers) && config.providers.length > 0) {
        // config.providers is unknown[] to avoid circular imports; validate minimally.
        //
        // Deliberately does NOT require a container, even though #264 makes `(type, container)`
        // the attribution key: `toprope doctor` resolves through here precisely so it can REPORT
        // a malformed entry ("bitbucket provider with no workspace"), and filtering it out here
        // would replace that specific diagnostic with a generic "no valid providers". The
        // pipeline guards itself instead: `GitSync.runSync` wraps each provider's
        // `fetchProviderData` in a try/catch, and that function's FIRST statement is
        // `createGitProvider` → `validateGitProviderConfig`, which rejects a missing
        // org/workspace/group before any key is built or any row is written. So a malformed entry
        // is skipped with its own surfaced error and its siblings still sync.
        //
        // The container is left VERBATIM here, so `toprope doctor` reports the spelling the
        // operator actually wrote in their YAML. Normalization happens at the two places the value
        // is used: `providerContainer` (attribution, cursors, the stored row) and each provider
        // client's constructor (the API request path) — see `github.ts`/`bitbucket.ts`/`gitlab.ts`.
        // Both derive from the same `normalizeContainer`, so `org: '  Acme '` cannot attribute rows
        // to `acme` while fetching `/orgs/%20Acme%20`.
        return (config.providers as unknown[]).filter(
            (p): p is GitProviderConfig =>
                typeof p === 'object' &&
                p !== null &&
                typeof (p as Record<string, unknown>).type === 'string',
        );
    }

    const token = config.api_token ?? process.env.GITHUB_TOKEN ?? '';
    const org = config.org ?? '';
    if (!token || !org) return [];

    return [
        {
            type: 'github',
            org,
            auth: {type: 'token', api_token: token},
            repos: config.repos,
        },
    ];
}

/**
 * The container identifier for a provider — org (GitHub), workspace (Bitbucket),
 * group (GitLab). The canonical extraction reused wherever a raw container value is
 * needed (sync state keys, the imported rows' attribution column, the resolver's
 * (type, container) de-dupe key, the stored `git_providers.container`) so the
 * mapping lives in exactly one place.
 *
 * NORMALIZED since #266. This is the single point every container consumer already
 * goes through, so normalizing HERE is what makes "the value compared is the value
 * persisted" a property of the code rather than a convention each caller has to
 * remember: `providerConfigToRowFields` (the stored row), `syncStateKey` /
 * `earliestSyncStateKey` / `stallStateKey` (the cursors), the `raw_author_daily`
 * and `pr_records` container columns, `containerKey` (the resolver de-dupe and the
 * delete cascade's skip check) and `configProviderId` all derive from it. A
 * provider whose YAML or DB row spells the container `Wireless_Media ` therefore
 * resolves to exactly the same data as one spelling it `wireless_media` — which is
 * what lets a delete + re-add with different casing find its existing data instead
 * of a fresh empty set (#266 AC3).
 */
export function providerContainer(config: GitProviderConfig): string {
    switch (config.type) {
        case 'github':
            return normalizeContainer(config.org);
        case 'bitbucket':
            return normalizeContainer(config.workspace);
        case 'gitlab':
            return normalizeContainer(config.group);
        default: {
            // A type this build doesn't know: `resolveGitProviderConfigs` yields UNVALIDATED
            // config-file entries, so `type` here is really untrusted text. Unlike the siblings in
            // `factory.ts`/`codec.ts` this one does NOT throw — `containerKey` is built for every
            // resolved provider in `runSync` OUTSIDE the per-provider try/catch, so throwing would
            // take down the whole run for one bad YAML entry. It returns the blank container every
            // write guard refuses by name instead, and the `never` assignment keeps compile-time
            // exhaustiveness so a newly added provider type cannot silently land here and collapse
            // its every container and cursor into one blank bucket.
            const exhaustive: never = config;
            void exhaustive;
            return '';
        }
    }
}

/**
 * The de-dupe / ownership / attribution identity of a provider instance — `${type}:${container}`.
 *
 * THE one definition. Since #264 this pair keys the imported `raw_author_daily`/`pr_records`
 * rows, the three `sync_state` cursors, the `UNIQUE(type, container)` constraint, the resolver's
 * config-vs-DB de-dupe, and the delete cascade's skip check — so every one of those must agree
 * byte-for-byte on how it is spelled. It lives here, beside {@link providerContainer} (which
 * every caller already goes through), because this module is the one both `sync.ts` and
 * `providers/*` can import without a cycle: the cascade imports the sync-state key builders from
 * `sync.ts`, so a definition in either of those two would force one of them to clone it.
 */
export function containerKeyOf(type: GitProviderType, container: string): string {
    // Deliberately does NOT normalize (#266). Every caller passes a value already derived from
    // `providerContainer` or from the stored (canonical) column, so a normalization here would be
    // inert — and in the one state where it would fire it makes things WORSE, not safer: the delete
    // cascade compares this key against `configContainerKeys` and then retracts rows with raw
    // `WHERE container = ?` SQL two lines later. If a non-canonical row ever coexisted with a
    // config sibling, a normalizing key would match, skip the cascade, drop the provider row, and
    // orphan its imported rows permanently — where a raw key misses, the cascade runs, and the
    // rows are retracted correctly. Normalization stays at the one place the docstring names.
    return `${type}:${container}`;
}

/** {@link containerKeyOf} for a resolved provider config. */
export function containerKey(config: GitProviderConfig): string {
    return containerKeyOf(config.type, providerContainer(config));
}
