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
 *
 * ── NEITHER METHOD MAY EVER THROW ─────────────────────────────────────────────
 * This is the module's load-bearing property, and it is enforced by a `try/catch` around the
 * SQLite call itself, not merely by validating arguments. Both methods run INSIDE the
 * provider's per-commit loop, and a throw there escapes `getCommits`, which #231 reads as an
 * incompletely-covered window: the provider's forward cursor is held and the WHOLE run's data
 * is discarded. Before #273 the fetch phase issued no database calls at all, so every fault
 * mode this module can raise — `SQLITE_BUSY` against a second connection, a full disk, a
 * CHECK violation from a future column — would be a NEW way to lose a multi-hour sync, and it
 * would be caused by the optimisation that exists to make losing one cheaper. A memo that can
 * kill the run it is accelerating is worse than no memo. Every failure here degrades to
 * exactly one re-fetch on the next run.
 */

import type Database from 'better-sqlite3';
import {normalizeContainer} from './providers/container.js';
import {chunk, READ_CHUNK_SIZE} from './raw-author-daily.js';
import type {
    CommitDiffstat,
    CommitDiffstatCache,
    GitFileDiff,
    GitProviderType,
} from './providers/types.js';

interface DiffstatRow {
    sha: string;
    additions: number;
    deletions: number;
    absent: number;
    entries: string;
}

/** A non-negative integer, as every stored count must be. Narrows `unknown`. */
function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Decode one stored `entries` blob, or null when it is not a usable file-diff list.
 *
 * `entries` is an unconstrained TEXT column, so its contents are validated at read time
 * rather than cast — every field is shape- AND domain-checked, and one bad element rejects
 * the whole row. Domain, not just shape: these per-file numbers are the only input to
 * `code_churn_rate` and `ai_signature_score`, so a negative or fractional value would flow
 * straight into the derived metrics (the row totals get the same treatment in
 * {@link decodeRow}).
 *
 * A rejected row degrades to a cache MISS, which re-fetches and overwrites it: self-healing
 * is the right failure mode for a memo of an idempotent remote read, where the alternative
 * (trusting the shape) would corrupt a commit's churn permanently, and failing closed would
 * strand the row forever.
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
        if (typeof path !== 'string' || path === '') return null;
        if (typeof status !== 'string') return null;
        if (!isCount(additions) || !isCount(deletions)) return null;
        entries.push({path, additions, deletions, status});
    }
    return entries;
}

/**
 * Decode a whole stored row, or null when it cannot be trusted.
 *
 * The numeric and `absent` invariants are re-checked in code as well as by the table's CHECK
 * constraints. That is not pure belt-and-braces: SQLite's INTEGER *affinity* stores a
 * non-lossless REAL as a REAL, so `additions = 1.5` satisfies `CHECK (additions >= 0)` and
 * still reaches a reader. And a row claiming both "no diffstat exists" and "here are its
 * changed lines" is incoherent whichever constraint let it in — the honest answer is to
 * re-fetch rather than to pick one half to believe.
 */
function decodeRow(row: DiffstatRow): CommitDiffstat | null {
    const entries = decodeEntries(row.entries);
    if (entries === null) return null;
    if (!isCount(row.additions) || !isCount(row.deletions)) return null;
    if (row.absent !== 0 && row.absent !== 1) return null;
    const absent = row.absent === 1;
    if (absent && (entries.length > 0 || row.additions !== 0 || row.deletions !== 0)) return null;
    return {additions: row.additions, deletions: row.deletions, entries, absent};
}

/**
 * A cache the sync pipeline OWNS, as opposed to the two-method view the providers get.
 *
 * The extra method exists because "never throws" and "never says anything" are separable, and
 * only the second is a bug. A read-only database, a schema drift, sustained `SQLITE_BUSY`
 * against the dashboard's connection or a full disk makes every call fail — the deployment
 * then reverts to pre-#273 behaviour and stays there, paying full price on every commit of
 * every run, while reporting a perfectly clean sync. That is the project's own graduated rule
 * ("never infer a positive health claim from narrower checks returning empty"): a run that
 * could not use the ratchet must say so.
 */
export interface OwnedCommitDiffstatCache extends CommitDiffstatCache {
    /** How many cache operations this instance has silently swallowed a fault from. */
    faults(): number;
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
 * TOTAL — nothing here throws, including construction. A blank container (or a bogus provider
 * type) is refused by the table's own `CHECK (length(container) > 0)`, which lands in `put`'s
 * guard and degrades to "no rows cached", exactly like every other fault. There is deliberately
 * no constructor-time rejection: it would be the one unguarded call in a module whose whole
 * contract is that it cannot break a sync, and the pipeline's canonical
 * `validateGitProviderConfig` already refuses a blank org/workspace/group one line later with
 * a far better message.
 */
export function createCommitDiffstatCache(
    db: Database.Database,
    providerType: GitProviderType,
    container: string,
): OwnedCommitDiffstatCache {
    const scope = normalizeContainer(container);
    let faults = 0;

    // Prepared ONCE and reused for the whole run: `put` fires per commit — thousands of times
    // on a full-history sync — and re-preparing the same SQL each time is pure waste. LAZILY,
    // and from inside `put`'s guard: `db.prepare` throws on an unknown table or a schema
    // mismatch, and doing it eagerly here would put that throw outside every catch — on the
    // sync's per-provider handler, which reports an infrastructure fault in a disposable memo
    // as "this provider could not be used" and skips the provider's entire sync.
    // The batched READ prepares inline instead (its SQL varies with the chunk length),
    // matching what `projection.ts` does at the equivalent site.
    let insert: Database.Statement | null = null;
    const insertStatement = (): Database.Statement =>
        (insert ??= db.prepare(
            `INSERT INTO commit_diffstats
                 (provider, container, repo, sha, additions, deletions, absent, entries, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, container, repo, sha) DO UPDATE SET
                 additions  = excluded.additions,
                 deletions  = excluded.deletions,
                 absent     = excluded.absent,
                 entries    = excluded.entries,
                 fetched_at = excluded.fetched_at`,
        ));

    return {
        faults: () => faults,

        load(repo: string, shas: readonly string[]): Map<string, CommitDiffstat> {
            const hits = new Map<string, CommitDiffstat>();
            if (repo === '') return hits;
            // De-duped so a repeated sha cannot inflate a chunk past the parameter limit, and
            // TYPE-filtered rather than merely `!== ''`: these values come straight off an
            // unchecked cast of a provider's JSON list payload, and better-sqlite3 refuses to
            // bind an `undefined`. Batched by the canonical splitter (`raw-author-daily.ts`)
            // so this module cannot drift from the chunk rule the projection uses.
            const distinct = [...new Set(shas)].filter(
                (sha): sha is string => typeof sha === 'string' && sha !== '',
            );
            if (distinct.length === 0) return hits;
            try {
                for (const part of chunk(distinct, READ_CHUNK_SIZE)) {
                    const rows = db
                        .prepare(
                            `SELECT sha, additions, deletions, absent, entries
                               FROM commit_diffstats
                              WHERE provider = ? AND container = ? AND repo = ?
                                AND sha IN (${part.map(() => '?').join(', ')})`,
                        )
                        .all(providerType, scope, repo, ...part) as DiffstatRow[];
                    for (const row of rows) {
                        const decoded = decodeRow(row);
                        // An undecodable row is simply omitted — the caller sees a miss,
                        // re-fetches, and `put` overwrites it.
                        if (decoded !== null) hits.set(row.sha, decoded);
                    }
                }
            } catch {
                // See the module header: a read fault must cost re-fetching, never the run.
                // Partial hits already collected stay — they are individually valid rows.
                faults++;
            }
            return hits;
        },

        put(repo: string, sha: string, value: CommitDiffstat): void {
            const absent = value.absent;
            // An absent diffstat carries nothing, so normalize rather than trust the caller:
            // the row must never claim both "no diffstat exists" and "here are its lines".
            const entries = absent ? [] : value.entries;
            const additions = absent ? 0 : value.additions;
            const deletions = absent ? 0 : value.deletions;
            const serialized = JSON.stringify(entries);
            // WRITE ONLY WHAT THE READER WILL ACCEPT. `decodeEntries` is stricter than the
            // table's CHECK constraints (which cannot inspect JSON), and a provider can
            // legitimately produce a value it rejects — Bitbucket maps an entry with neither
            // `new` nor `old` to `path: ''`, GitLab to `undefined`, which `JSON.stringify`
            // then drops entirely. Storing such a row makes the ratchet a silent no-op for
            // exactly those commits FOREVER: every run writes it, every next run rejects it
            // on read and re-fetches. Refusing the write costs the same re-fetch and one
            // decision instead of one UPSERT per run — and it makes the two boundaries agree,
            // which is the graduated "check and store the same normalized value" rule.
            if (decodeEntries(serialized) === null) {
                faults++;
                return;
            }
            try {
                insertStatement().run(
                    providerType,
                    scope,
                    repo,
                    sha,
                    additions,
                    deletions,
                    absent ? 1 : 0,
                    serialized,
                    new Date().toISOString(),
                );
            } catch {
                // See the module header. Every argument-level defect the table's CHECK
                // constraints reject (a blank container/repo/sha, a negative count) lands here
                // too, so there is one guard rather than a pre-check per column that would
                // still leave `SQLITE_BUSY` and a full disk uncovered.
                faults++;
            }
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
 * Returns the number of rows removed. Unlike the cache methods this one is allowed to throw:
 * its cascade caller runs inside a transaction that must roll back as a unit if any step
 * fails, and its other caller guards it (see `runSync`).
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
