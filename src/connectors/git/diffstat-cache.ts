/**
 * The persistent per-commit diffstat cache (#273) — the "ratchet" that makes a failed git
 * sync run keep the expensive work it already did.
 *
 * See `migrations/044_commit_diffstats.sql` for the full rationale (why an immutable memo is
 * not a snapshot table, why it may be written outside the run transaction, why the key is
 * `(provider, container, repo, sha)`). This module is the SQLite implementation of
 * {@link CommitDiffstatCache}, plus the retraction the #264 delete cascade calls.
 *
 * The DB dependency lives here and NOT in `providers/*`: the three providers are plain HTTP
 * clients, and they consult the cache through the two-method interface declared beside them
 * in `providers/types.ts`.
 */

import type Database from 'better-sqlite3';
import {normalizeContainer} from './providers/container.js';
import type {
    CommitDiffstat,
    CommitDiffstatCache,
    GitFileDiff,
    GitProviderType,
} from './providers/types.js';

/**
 * How many shas one batch-read statement binds.
 *
 * SQLite's compiled parameter limit is 32,766 on modern builds and 999 on older ones; 400 is
 * comfortably under both and still collapses a 5,000-commit repo from 5,000 point reads to 13
 * queries. The number is not load-bearing — larger chunks would be marginally faster and
 * smaller ones marginally slower; only "one query per commit" is actually wrong.
 */
const SHA_CHUNK = 400;

interface DiffstatRow {
    sha: string;
    additions: number;
    deletions: number;
    absent: number;
    entries: string;
}

/**
 * Decode one stored `entries` blob, or null when it is not a usable file-diff list.
 *
 * `entries` is an unconstrained TEXT column, so its contents are validated at read time
 * rather than cast — every field is shape-checked, and one bad element rejects the whole row.
 * A rejected row degrades to a cache MISS, which re-fetches and overwrites it: self-healing
 * is the right failure mode for a memo of an idempotent remote read, where the alternative
 * (trusting the shape) would let a truncated or hand-edited value corrupt a commit's churn
 * permanently, and failing closed would strand the row forever.
 */
function decodeEntries(raw: string): GitFileDiff[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const entries: GitFileDiff[] = [];
    for (const item of parsed) {
        if (typeof item !== 'object' || item === null) return null;
        const {path, additions, deletions, status} = item as Record<string, unknown>;
        if (typeof path !== 'string') return null;
        if (typeof status !== 'string') return null;
        // Finite numbers only: a NaN/Infinity that survived a JSON round-trip as `null`
        // would flow straight into the churn and AI-signature maths.
        if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return null;
        entries.push({
            path,
            additions: additions as number,
            deletions: deletions as number,
            status,
        });
    }
    return entries;
}

/**
 * Decode a whole stored row, or null when it cannot be trusted.
 *
 * The `absent` invariant is re-checked in code as well as by the table's CHECK constraint: a
 * row claiming both "no diffstat exists" and "here are its changed lines" is incoherent, and
 * the honest answer is to re-fetch rather than to pick one half to believe.
 */
function decodeRow(row: DiffstatRow): CommitDiffstat | null {
    const entries = decodeEntries(row.entries);
    if (entries === null) return null;
    if (!Number.isInteger(row.additions) || row.additions < 0) return null;
    if (!Number.isInteger(row.deletions) || row.deletions < 0) return null;
    if (row.absent !== 0 && row.absent !== 1) return null;
    const absent = row.absent === 1;
    if (absent && (entries.length > 0 || row.additions !== 0 || row.deletions !== 0)) return null;
    return {additions: row.additions, deletions: row.deletions, entries, absent};
}

/**
 * The diffstat cache for ONE provider instance, i.e. one `(providerType, container)`.
 *
 * `container` is normalized here with the same {@link normalizeContainer} every other
 * container consumer goes through, so "the value compared is the value persisted" — the
 * graduated rule from #255. A caller passing `providerContainer(config)` (as the sync
 * pipeline does) is already canonical and this is inert; a caller passing raw config text is
 * still keyed identically to the rows the cascade will retract.
 *
 * @throws when `container` normalizes to blank. Not a degradation: a blank container is not
 * an attribution key, so a cache scoped to one could never be retracted by a per-provider
 * delete. Unreachable through the pipeline — `validateGitProviderConfig` rejects a blank
 * org/workspace/group first — so this is the invariant stated where it is relied on.
 */
export function createCommitDiffstatCache(
    db: Database.Database,
    providerType: GitProviderType,
    container: string,
): CommitDiffstatCache {
    const scope = normalizeContainer(container);
    if (scope === '') {
        throw new Error(
            `Cannot cache commit diffstats for ${providerType}: container is blank`,
        );
    }

    // Prepared ONCE and reused for the whole run: `put` fires per commit — thousands of times
    // on a full-history sync — and re-preparing the same SQL each time is pure waste.
    const insert = db.prepare(
        `INSERT INTO commit_diffstats
             (provider, container, repo, sha, additions, deletions, absent, entries, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, container, repo, sha) DO UPDATE SET
             additions  = excluded.additions,
             deletions  = excluded.deletions,
             absent     = excluded.absent,
             entries    = excluded.entries,
             fetched_at = excluded.fetched_at`,
    );
    // One statement per distinct chunk SIZE, so a run that pages repos of similar size
    // prepares a handful of statements in total rather than one per batch.
    const selects = new Map<number, Database.Statement>();
    const selectFor = (size: number): Database.Statement => {
        let stmt = selects.get(size);
        if (stmt === undefined) {
            stmt = db.prepare(
                `SELECT sha, additions, deletions, absent, entries
                   FROM commit_diffstats
                  WHERE provider = ? AND container = ? AND repo = ?
                    AND sha IN (${new Array(size).fill('?').join(', ')})`,
            );
            selects.set(size, stmt);
        }
        return stmt;
    };

    return {
        load(repo: string, shas: readonly string[]): Map<string, CommitDiffstat> {
            const hits = new Map<string, CommitDiffstat>();
            if (repo === '' || shas.length === 0) return hits;
            // De-duped so a repeated sha cannot inflate a chunk past the parameter limit, and
            // so the binding list matches what the caller will look up.
            const distinct = [...new Set(shas)].filter((sha) => sha !== '');
            for (let i = 0; i < distinct.length; i += SHA_CHUNK) {
                const chunk = distinct.slice(i, i + SHA_CHUNK);
                const rows = selectFor(chunk.length).all(
                    providerType,
                    scope,
                    repo,
                    ...chunk,
                ) as DiffstatRow[];
                for (const row of rows) {
                    const decoded = decodeRow(row);
                    // An undecodable row is simply omitted — the caller sees a miss, re-fetches,
                    // and `put` overwrites it.
                    if (decoded !== null) hits.set(row.sha, decoded);
                }
            }
            return hits;
        },

        put(repo: string, sha: string, value: CommitDiffstat): void {
            // A cache write must never be able to fail a sync. Everything below is either
            // already true by construction at the call sites or a defect in them; skipping the
            // write costs one re-fetch next run, while throwing would abort a repo's commit
            // fetch and — via #231 — discard the whole run's data.
            if (repo === '' || sha === '') return;
            const absent = value.absent;
            const entries = absent ? [] : value.entries;
            const additions = absent ? 0 : value.additions;
            const deletions = absent ? 0 : value.deletions;
            if (!Number.isInteger(additions) || additions < 0) return;
            if (!Number.isInteger(deletions) || deletions < 0) return;
            insert.run(
                providerType,
                scope,
                repo,
                sha,
                additions,
                deletions,
                absent ? 1 : 0,
                JSON.stringify(entries),
                new Date().toISOString(),
            );
        },
    };
}

/**
 * Drop every cached diffstat belonging to one `(providerType, container)` — the retraction the
 * #264 provider delete cascade performs alongside `raw_author_daily` and `pr_records`.
 *
 * Correctness does not depend on it: the rows are an immutable memo of a remote read, so
 * leaving them would only mean a re-added provider re-uses fetches it would otherwise repeat.
 * Honesty does. The cascade's claim is "this container's contribution is gone", and a provider
 * re-added with narrower credentials must not silently inherit file-level detail those
 * credentials no longer justify.
 *
 * Returns the number of rows removed.
 */
export function deleteContainerDiffstats(
    db: Database.Database,
    providerType: GitProviderType,
    container: string,
): number {
    return db
        .prepare('DELETE FROM commit_diffstats WHERE provider = ? AND container = ?')
        .run(providerType, normalizeContainer(container)).changes;
}

/**
 * How many diffstats are cached for one `(providerType, container)`. Read-only; exists for
 * the delete-cascade and ratchet tests, which must be able to assert on the cache's contents
 * without hand-writing the table name in three places.
 */
export function countContainerDiffstats(
    db: Database.Database,
    providerType: GitProviderType,
    container: string,
): number {
    return (
        db
            .prepare(
                'SELECT COUNT(*) AS n FROM commit_diffstats WHERE provider = ? AND container = ?',
            )
            .get(providerType, normalizeContainer(container)) as {n: number}
    ).n;
}
