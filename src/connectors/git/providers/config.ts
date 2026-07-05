import type {GitProviderConfig} from './types.js';
import type {GitConnectorConfig} from '../../../config/types.js';

// Resolve the list of git provider configs from a git connector config.
// Prefers the explicit `providers` array; falls back to the legacy
// single-provider GitHub shorthand (org + api_token). Shared by the sync
// orchestrator and `toprope doctor` so both see the same providers.
export function resolveGitProviderConfigs(config: GitConnectorConfig): GitProviderConfig[] {
    if (Array.isArray(config.providers) && config.providers.length > 0) {
        // config.providers is unknown[] to avoid circular imports; validate minimally.
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
