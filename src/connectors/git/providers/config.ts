import type {GitProviderConfig, GitProviderType} from './types.js';
import type {GitConnectorConfig} from '../../../config/types.js';

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
        // pipeline guards itself instead — `GitSync.runSync` drops a container-less provider with
        // a surfaced error rather than letting it reach a write boundary (see `hasUsableContainer`
        // in sync.ts).
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

// The container identifier for a provider — org (GitHub), workspace (Bitbucket),
// group (GitLab). The canonical extraction reused wherever a raw container value
// is needed (sync state keys, the resolver's (type, container) de-dupe key) so
// the mapping lives in exactly one place.
export function providerContainer(config: GitProviderConfig): string {
    switch (config.type) {
        case 'github':
            return config.org;
        case 'bitbucket':
            return config.workspace;
        case 'gitlab':
            return config.group;
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
    return `${type}:${container}`;
}

/** {@link containerKeyOf} for a resolved provider config. */
export function containerKey(config: GitProviderConfig): string {
    return containerKeyOf(config.type, providerContainer(config));
}
