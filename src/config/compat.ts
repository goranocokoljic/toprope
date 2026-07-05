import fs from 'fs';
import path from 'path';

/**
 * Backwards-compatibility shims for the GovProxy -> toprope rename.
 *
 * The product was renamed from "GovProxy" to "toprope". Existing deployments
 * (notably the WMG install) still have the old config filename, the old
 * `GOVPROXY_*` environment variables, and an on-disk SQLite file named
 * `govproxy.db`. Everything here lets those keep working unchanged: we prefer
 * the new form, fall back to the legacy form when only the old one is present,
 * and emit a one-line deprecation warning naming both the old and new form.
 *
 * These are the ONLY places the codebase intentionally still references the old
 * "govproxy" name. Once every deployment has migrated, this module (and its
 * call sites) can be deleted.
 */

const LEGACY_NAME = 'govproxy';
const NEW_NAME = 'toprope';

// Warn at most once per (old -> new) pair per process so a CLI command that
// loads config several times doesn't print the same deprecation line repeatedly.
const warnedKeys = new Set<string>();

function deprecate(oldForm: string, newForm: string, kind: string): void {
    const key = `${kind}:${oldForm}`;
    if (warnedKeys.has(key)) {
        return;
    }
    warnedKeys.add(key);
    console.warn(
        `[toprope] deprecation: using legacy ${kind} "${oldForm}". ` +
            `Rename it to "${newForm}" — the "${LEGACY_NAME}" form will be removed in a future release.`,
    );
}

/** Replace the "toprope" token in a path's basename with the legacy "govproxy". */
function legacyCandidate(targetPath: string): string {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath).replace(NEW_NAME, LEGACY_NAME);
    return path.join(dir, base);
}

/**
 * Resolve a config path, falling back to the legacy `govproxy.*` filename when
 * the requested `toprope.*` file is absent but the old one exists beside it.
 * Returns the path to actually load (new if present, else legacy if present,
 * else the original path unchanged so the caller's not-found error still fires).
 */
export function resolveConfigPathWithLegacyFallback(configPath: string): string {
    if (fs.existsSync(configPath)) {
        return configPath;
    }
    const legacyPath = legacyCandidate(configPath);
    if (legacyPath !== configPath && fs.existsSync(legacyPath)) {
        deprecate(path.basename(legacyPath), path.basename(configPath), 'config file');
        return legacyPath;
    }
    return configPath;
}

/**
 * Read an environment variable, falling back to its legacy `GOVPROXY_*` name
 * when the new `TOPROPE_*` one is unset. Returns undefined if neither is set.
 */
export function readEnvWithLegacyFallback(
    newName: string,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    const current = env[newName];
    if (current !== undefined && current !== '') {
        return current;
    }
    const legacyName = newName.replace('TOPROPE_', 'GOVPROXY_');
    if (legacyName === newName) {
        return current;
    }
    const legacyVal = env[legacyName];
    if (legacyVal !== undefined && legacyVal !== '') {
        deprecate(legacyName, newName, 'environment variable');
        return legacyVal;
    }
    return current;
}

/**
 * One-time on-disk migration: if the target SQLite file does not yet exist but
 * a legacy `govproxy.*` file sits beside it, rename the legacy file (plus its
 * WAL/SHM sidecars) into place. Never drops or regenerates data — it only
 * renames, and only when the new file is absent, so it is idempotent and safe
 * to call on every startup.
 */
export function migrateLegacyDbFile(dbPath: string): void {
    if (fs.existsSync(dbPath)) {
        return;
    }
    const legacyPath = legacyCandidate(dbPath);
    if (legacyPath === dbPath || !fs.existsSync(legacyPath)) {
        return;
    }
    deprecate(path.basename(legacyPath), path.basename(dbPath), 'database file');
    // Move the main DB file and any WAL/SHM sidecars left by a prior run.
    for (const suffix of ['', '-wal', '-shm']) {
        const from = `${legacyPath}${suffix}`;
        const to = `${dbPath}${suffix}`;
        if (fs.existsSync(from) && !fs.existsSync(to)) {
            fs.renameSync(from, to);
        }
    }
}
