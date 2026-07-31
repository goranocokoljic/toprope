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
 *
 * ── AND NEITHER MAY MONOPOLISE THE EVENT LOOP (#286) ──────────────────────────
 * `load` runs in the process that also serves Fastify, and its input is a WHOLE repo's
 * commit window: on a monorepo that is tens of thousands of shas, each costing a row decode
 * and a `JSON.parse` of an uncapped file list. Done in one synchronous burst that is a
 * multi-second stall of every in-flight dashboard request, at the start of every repo. So
 * the batched read is `async` and yields to the event loop BETWEEN chunks — the batching
 * win (one query per {@link READ_CHUNK_SIZE} shas rather than one per commit) is untouched,
 * because the yield sits between queries, not inside one. A single-chunk read — every probe,
 * every small repo, every test below the chunk size — yields not at all and is exactly as it
 * was.
 *
 * `put` is deliberately NOT batched, and that is a decision rather than an omission. Every
 * `put` is reached only on a cache MISS, i.e. immediately after the per-commit HTTP round
 * trip that the whole table exists to avoid repeating — so its implicit transaction is
 * already amortised over a network fetch that costs orders of magnitude more than the fsync.
 * Buffering it would trade this module's load-bearing "immediately and durably" property
 * (see {@link CommitDiffstatCache.put}: the row must survive a run that fails a moment later)
 * for a saving that is noise against the fetch it follows.
 */

import type Database from 'better-sqlite3';
import {setImmediate as setImmediateReal} from 'node:timers';
import {normalizeContainer} from './providers/container.js';
import {chunk, READ_CHUNK_SIZE} from './raw-author-daily.js';
import type {
    CommitDiffstat,
    CommitDiffstatCache,
    GitFileDiff,
    GitProviderType,
} from './providers/types.js';

/**
 * A row as it comes back from SQLite, typed to what the COLUMNS actually guarantee rather than
 * to what a well-behaved writer puts in them. `entries` is unconstrained TEXT; `additions` and
 * `deletions` have INTEGER *affinity*, which stores a non-lossless REAL as a REAL. Declaring
 * them `unknown` is what stops a future reader writing `row.entries.slice(...)` with the
 * compiler's blessing — the graduated rule to type a wire field with the same breadth its
 * source guarantees. {@link decodeRow} is the only narrowing.
 */
interface DiffstatRow {
    sha: string;
    additions: unknown;
    deletions: unknown;
    absent: unknown;
    entries: unknown;
}

/**
 * Hand the event loop one full turn (#286).
 *
 * `setImmediate` specifically: it schedules into the CHECK phase, so the poll phase in
 * between gets to run every pending socket callback — which is the entire point, since the
 * process this blocks is the one serving Fastify. `process.nextTick` and `queueMicrotask`
 * both drain before the loop advances and would yield nothing to a waiting request.
 *
 * Taken from `node:timers` rather than the global, which is NOT incidental. A fake-timer
 * harness replaces the global `setImmediate` with one that only fires when the test advances
 * its clock — and this is not a delay, it is a turn of a loop that turns on its own. Bound to
 * the global, any test that froze time and then read a repo wider than one chunk would
 * deadlock: the optimisation that exists to keep the process responsive would be the thing
 * that hangs it. There is no behaviour here a test could want to schedule; the only thing
 * faking it can produce is that hang. The `node:timers` binding is the real one either way,
 * so production and test take the identical path.
 */
function yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => {
        setImmediateReal(resolve);
    });
}

/** A non-negative integer, as every stored count must be. Narrows `unknown`. */
function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Is this one usable file-diff entry?
 *
 * THE single predicate both boundaries use — {@link decodeEntries} on the way in from the
 * column, and `put` on the way out to it. Keeping one definition is what makes "we only store
 * what we can read back" a property rather than a convention: a stricter reader than writer
 * means the row is written every run and rejected every next one, which is the ratchet
 * silently no-opping forever for exactly those commits.
 *
 * Domain-checked, not merely shape-checked: these per-file numbers are the only input to
 * `code_churn_rate` and `ai_signature_score`, so a negative or fractional value would flow
 * straight into the derived metrics.
 */
function isFileDiff(item: unknown): item is GitFileDiff {
    if (typeof item !== 'object' || item === null) return false;
    const {path, additions, deletions, status} = item as Record<string, unknown>;
    // A blank path is not a path. Both non-GitHub providers can produce one — Bitbucket maps
    // an entry with neither `new` nor `old` to `''`, GitLab to `undefined` — and the churn
    // window keys on it, so an entry that names no file cannot contribute honestly.
    if (typeof path !== 'string' || path === '') return false;
    if (typeof status !== 'string') return false;
    return isCount(additions) && isCount(deletions);
}

/**
 * Decode one stored `entries` blob, or null when it is not a usable file-diff list.
 *
 * One bad element rejects the whole row: a partially-decoded diff would understate a commit's
 * churn, which is indistinguishable downstream from a real answer. A rejected row degrades to
 * a cache MISS, which re-fetches and overwrites it — self-healing is the right failure mode
 * for a memo of an idempotent remote read, where trusting the shape would corrupt a commit's
 * churn permanently and failing closed would strand the row forever.
 */
function decodeEntries(raw: unknown): GitFileDiff[] | null {
    if (typeof raw !== 'string') return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    // Rebuilt onto fresh literals rather than passed through, so a stored object carrying
    // extra keys (or `__proto__`) cannot reach the analysis.
    const entries: GitFileDiff[] = [];
    for (const item of parsed) {
        if (!isFileDiff(item)) return null;
        entries.push({
            path: item.path,
            additions: item.additions,
            deletions: item.deletions,
            status: item.status,
        });
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
    /**
     * How many cache operations this instance has silently swallowed a FAULT from — a database
     * error it could not act on.
     *
     * Deliberately NOT incremented by the deterministic refusal in `put` (a value the reader
     * would reject). That refusal is a correct, permanent decision about one commit's data, not
     * a statement about the cache's health, and a single un-nameable file entry anywhere in a
     * repo's history would otherwise make the advisory fire on every run forever — training the
     * operator to skim past the one line that is supposed to mean "the ratchet is dead".
     */
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

        async load(repo: string, shas: readonly string[]): Promise<Map<string, CommitDiffstat>> {
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
                const parts = chunk(distinct, READ_CHUNK_SIZE);
                for (const [index, part] of parts.entries()) {
                    // BETWEEN chunks, never before the first and never after the last (#286):
                    // a single-chunk read must stay exactly as cheap as it was, and a trailing
                    // yield would only delay the caller. `setImmediate` rather than a microtask
                    // — `await Promise.resolve()` drains the microtask queue without ever
                    // reaching the poll phase, so it would keep the loop just as blocked while
                    // looking like it yielded.
                    if (index > 0) await yieldToEventLoop();
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
            // WRITE ONLY WHAT THE READER WILL ACCEPT — every field the reader checks, not just
            // the entries. The table's CHECK constraints cannot inspect JSON, and INTEGER
            // affinity lets a fractional total past `CHECK (additions >= 0)`, so SQLite alone
            // does not make the two boundaries agree. A value the reader would reject is
            // written on every run and rejected on every next one: the ratchet a silent no-op
            // for exactly those commits, forever. Refusing costs the same re-fetch and one
            // decision instead of an UPSERT per run.
            //
            // Both are reachable from real provider data, not just hand-edited rows: Bitbucket
            // maps a diffstat entry with neither `new` nor `old` to `path: ''` and GitLab to
            // `undefined`; GitHub's commit-level totals come from `detail.stats`, unvalidated
            // JSON. This is the graduated "check and store the same normalized value" rule.
            //
            // NOT counted as a fault (see `OwnedCommitDiffstatCache.faults`): it is a correct
            // permanent decision about this commit's data, not a sign the cache is unhealthy.
            if (!isCount(additions) || !isCount(deletions)) return;
            if (!entries.every(isFileDiff)) return;
            try {
                insertStatement().run(
                    providerType,
                    scope,
                    repo,
                    sha,
                    additions,
                    deletions,
                    absent ? 1 : 0,
                    // Inside the guard: `JSON.stringify` throws on a BigInt or a circular
                    // structure, and the never-throw contract covers the whole method, not
                    // only the SQLite call.
                    JSON.stringify(entries),
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
    return deleteDiffstats(db, {provider: providerType, container});
}

/**
 * Which rows a purge is aimed at. Every member is OPTIONAL and they compose: omitting one
 * widens the scope over that column, so `{}` is "the whole table" and `{provider, container}`
 * is exactly what the #264 cascade retracts.
 *
 * A scope is a set of EQUALITY predicates only — no patterns, no ranges. `commit_diffstats`
 * has no column an operator could sensibly express a range over (`fetched_at` is provenance,
 * explicitly never consulted for freshness — see migration 044), and a LIKE would let one
 * mistyped `%` empty a monorepo's whole cache while reading as a narrow command.
 */
export interface DiffstatScope {
    /** Provider family. Already narrowed to the closed set by the type. */
    provider?: GitProviderType;
    /**
     * The provider INSTANCE. Normalized here with the shared {@link normalizeContainer}, the
     * same function the write boundary uses, so the value compared IS the value persisted
     * (the graduated #255 rule) — `--container " ACME "` matches the rows `acme` stored.
     */
    container?: string;
    /**
     * The repo, spelled EXACTLY as the provider's fetch path spells it (GitHub name,
     * Bitbucket slug, GitLab path_with_namespace). Deliberately NOT casefolded, unlike
     * `container`: repo identifiers are case-sensitive on all three providers, so folding
     * would make one command match rows the write path can never produce, and — worse — make
     * `--repo Api` silently purge `api` as well.
     */
    repo?: string;
}

/**
 * The one WHERE builder every diffstat purge goes through, so the cascade, the CLI and any
 * future caller cannot drift on how a scope is spelled (the graduated "reuse the canonical
 * helper" rule). Returns a clause that is `''` for the empty scope — a whole-table purge,
 * which is a supported operation here precisely because the table is disposable (migration
 * 044: "any future migration or command that resets git data must add DELETE FROM
 * commit_diffstats").
 */
function scopeClause(scope: DiffstatScope): {where: string; params: string[]} {
    const conditions: string[] = [];
    const params: string[] = [];
    if (scope.provider !== undefined) {
        conditions.push('provider = ?');
        params.push(scope.provider);
    }
    if (scope.container !== undefined) {
        conditions.push('container = ?');
        params.push(normalizeContainer(scope.container));
    }
    if (scope.repo !== undefined) {
        conditions.push('repo = ?');
        params.push(scope.repo);
    }
    return {where: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '', params};
}

/**
 * Drop every cached diffstat matching `scope`, and return how many rows went.
 *
 * This is the operator surface migration 044 names as the remedy for the three residual
 * cases it accepts (a permission-revocation 404 frozen as "no diffstat exists", a 404 on
 * page >= 2 of a paged diff, a silently truncated 200) and for a repo excluded after the
 * fact — until #286 the ONLY caller of that DELETE was the #264 provider delete cascade, so
 * acting on a residual meant opening `sqlite3` against the production database.
 *
 * Deleting is always SAFE and never loses data: the rows are a memo of an idempotent remote
 * read of an immutable fact, sitting strictly upstream of the accumulator, so the cost of an
 * over-broad purge is re-fetching and nothing else. That asymmetry is why this takes a scope
 * rather than refusing the unscoped call.
 *
 * Allowed to throw, like {@link deleteContainerDiffstats} and unlike the cache methods: its
 * callers are a transaction that must roll back as a unit and a CLI command that must report
 * a failure rather than print a false row count.
 */
export function deleteDiffstats(db: Database.Database, scope: DiffstatScope): number {
    const {where, params} = scopeClause(scope);
    return db.prepare(`DELETE FROM commit_diffstats${where}`).run(...params).changes;
}

/** What one scope of the cache currently occupies. See {@link countDiffstats}. */
export interface DiffstatCacheSize {
    /** Rows cached — one per distinct `(provider, container, repo, sha)` ever fetched. */
    rows: number;
    /** How many of those are the explicit "the provider has no diffstat for this commit" marker. */
    absent: number;
    /**
     * Bytes of stored `entries` JSON — the file-path payload only, excluding keys, indexes
     * and page overhead. An approximation of the table's footprint, and the number that
     * actually grows: `entries` is uncapped by design and is the first column in this schema
     * to persist real source-tree paths from private repos (migration 044, DATA SCOPE).
     */
    entryBytes: number;
}

/**
 * How big the diffstat cache is, optionally within one {@link DiffstatScope}.
 *
 * Reported by `toprope doctor` (#286). Before it, nothing in the product said how many rows
 * this table held or what they occupied, while the table grows monotonically with distinct
 * commits ever synced and is uncapped per commit — plausibly the largest table in the
 * database, with no signal.
 *
 * `absent` is broken out because it answers a different question from the total: those rows
 * are the deterministic 404s, and a share of them far above a few percent means something
 * other than merge/initial commits is 404ing — which is exactly residual #1 (access revoked
 * mid-walk, frozen as an answer) and exactly what a purge is for.
 *
 * A full scan: no index covers `absent`, and none should — see migration 044's note on why
 * this table carries no secondary index. It runs once per `toprope doctor`, never in a sync.
 */
export function countDiffstats(db: Database.Database, scope: DiffstatScope = {}): DiffstatCacheSize {
    const {where, params} = scopeClause(scope);
    const row = db
        .prepare(
            `SELECT COUNT(*) AS rows,
                    COALESCE(SUM(absent), 0) AS absent,
                    COALESCE(SUM(length(entries)), 0) AS entry_bytes
               FROM commit_diffstats${where}`,
        )
        .get(...params) as {rows: unknown; absent: unknown; entry_bytes: unknown};
    // Narrowed rather than cast, for the same reason `decodeRow` narrows: `absent` and
    // `entries` have no constraint SQLite enforces against a REAL, so SUM() over them can
    // legitimately return a non-integer. A size report that cannot be trusted is reported as
    // zero rather than propagated as a fractional row count.
    return {
        rows: isCount(row.rows) ? row.rows : 0,
        absent: isCount(row.absent) ? row.absent : 0,
        entryBytes: isCount(row.entry_bytes) ? row.entry_bytes : 0,
    };
}
