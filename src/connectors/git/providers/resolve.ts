/**
 * The single seam that makes DB-connected git providers visible to the whole
 * analysis pipeline (GC1.4 / #196).
 *
 * Today providers live only in YAML and flow through {@link
 * resolveGitProviderConfigs}. This merges the DB-backed source (UI-connected
 * providers, GC1.3 / #195) with that config source at the same seam, so `GitSync`
 * (CLI sync + scheduler) and `doctor` pick up UI providers with no changes on the
 * analysis side.
 *
 * Merge contract:
 *   - **DB wins** on a `(type, container)` collision — the UI is the newer source
 *     of truth. The shadowed config entry is logged (never silently dropped).
 *   - **Enabled only.** Disabled DB rows are excluded before the merge.
 *   - **Fail-closed on the secret key.** Decrypting a stored token needs the
 *     server key; if it is unconfigured we skip the DB providers with a warning
 *     rather than fall back to any plaintext path. Config-only setups are
 *     unaffected — a missing key never breaks a run that has no DB providers.
 *   - **One bad row can't sink the run.** A DB row that fails to decrypt/decode
 *     is logged and skipped; the remaining providers still resolve.
 *
 * Ordering is total and deterministic: enabled DB providers first (in the store's
 * `created_at, id` order), then the surviving config providers in config order.
 */

import type Database from 'better-sqlite3';
import type {GitProviderConfig} from './types.js';
import type {GitConnectorConfig} from '../../../config/types.js';
import type {ServerKeyResult} from './secret.js';
import {containerKey, resolveGitProviderConfigs} from './config.js';
import {getDecryptedConfig, listProviders} from './store.js';

/**
 * Merge DB-backed providers (enabled only) with config-file providers into the
 * single list the sync/doctor pipeline consumes. DB wins on `(type, container)`;
 * shadowed config entries are logged. See the module doc for the full contract.
 *
 * @param db        the open database (source of DB providers)
 * @param keyResult the loaded server key (from `loadServerKey()`) — fail-closed
 * @param gitConfig the git connector config (source of config providers)
 */
export function resolveAllGitProviders(
    db: Database.Database,
    keyResult: ServerKeyResult,
    gitConfig: GitConnectorConfig,
): GitProviderConfig[] {
    const configProviders = resolveGitProviderConfigs(gitConfig);

    // Enabled DB providers, in the store's deterministic order.
    const enabledRecords = listProviders(db).filter((r) => r.enabled === 1);

    const dbProviders: GitProviderConfig[] = [];
    const dbKeys = new Set<string>();

    if (enabledRecords.length > 0) {
        if (!keyResult.ok) {
            // Fail-closed: without the server key we cannot decrypt stored tokens.
            // Skip DB providers (never fall back to plaintext) and warn so the
            // misconfiguration is visible; config providers still resolve below.
            console.warn(
                `[git] ${enabledRecords.length} enabled DB git provider(s) present but ${keyResult.message} ` +
                    'Skipping them until the server key is configured.',
            );
        } else {
            for (const record of enabledRecords) {
                let config: GitProviderConfig | undefined;
                try {
                    config = getDecryptedConfig(db, keyResult, record.id);
                } catch (err) {
                    // A tampered/corrupt row (wrong key, bad meta, unknown type) must
                    // not sink the whole run — log and skip just this provider.
                    console.warn(
                        `[git] Skipping DB provider ${record.type}/${record.container} (id=${record.id}): ` +
                            `${err instanceof Error ? err.message : String(err)}`,
                    );
                    continue;
                }
                // Row vanished between list and fetch (concurrent delete) — skip.
                if (config === undefined) continue;
                dbProviders.push(config);
                dbKeys.add(containerKey(config));
            }
        }
    }

    const merged: GitProviderConfig[] = [...dbProviders];
    // Seeded from the DB keys and then EXTENDED as config entries are accepted, so the loop
    // de-dupes config-against-config as well as config-against-DB (#264 review OR-5/SO-5).
    // The second half matters more than it looks: two YAML entries naming one org are the SAME
    // commits fetched twice, and the run's per-(container, author, day) accumulator sums them —
    // a permanent double-count of that org's commits, lines and churn, with both entries also
    // fighting over one cursor and one stall key. `UNIQUE(type, container)` cannot see it (it
    // constrains `git_providers` rows, not config). One `seen` set closes it here, at the single
    // seam every consumer resolves through, rather than leaving the accumulator to absorb it.
    const seen = new Set(dbKeys);
    for (const cfg of configProviders) {
        const key = containerKey(cfg);
        if (dbKeys.has(key)) {
            // DB wins — the config entry is shadowed. Log it (never silent).
            console.warn(
                `[git] Config provider ${key} is shadowed by a DB-connected provider (DB wins) — ` +
                    'the config entry is ignored. Manage it in the UI, or remove one to stop the collision.',
            );
            continue;
        }
        if (seen.has(key)) {
            console.warn(
                `[git] Config provider ${key} is declared more than once — keeping the first entry and ` +
                    'ignoring the duplicate. Syncing one container twice in a run double-counts its ' +
                    'commits and makes two entries fight over one sync cursor.',
            );
            continue;
        }
        seen.add(key);
        merged.push(cfg);
    }

    return merged;
}
