import type Database from 'better-sqlite3';
import {
    countDiffstatRows,
    countDiffstats,
    deleteDiffstats,
    type DiffstatScope,
} from '../connectors/git/diffstat-cache';
import {parseContainer, parseProviderType} from './git-args';

/**
 * `toprope git cache clear` — the operator surface for the per-commit diffstat cache (#286).
 *
 * `migrations/044_commit_diffstats.sql` documents three answers the cache records as facts
 * that in rare circumstances are not facts about the commit (a 404 that meant "you may not
 * see this" rather than "this has no diffstat"; a 404 on page >= 2 of a paged diff; a 200
 * silently truncated by a proxy), and names the remedy for all three:
 *
 *     DELETE FROM commit_diffstats WHERE provider = ? AND container = ?;  -- and/or AND repo = ?
 *
 * It landed with no way to issue that through the product. The only caller was the #264
 * provider delete cascade, so an operator acting on a residual — or on a repo added to
 * `exclude_repos` after the fact, which stops collection but leaves that repo's cached file
 * inventory behind — had to open `sqlite3` against the production database. This is that
 * DELETE, scoped and reported.
 *
 * Lives here rather than inline in cli.ts so the trust-boundary parsing and the outcome
 * messaging are unit-testable, matching {@link ../cli/doctor} and {@link ./git-history-floor}.
 */

export interface ClearDiffstatCacheInput {
    provider?: string;
    container?: string;
    repo?: string;
    /**
     * Required to clear the WHOLE table, and meaningless otherwise.
     *
     * The unscoped purge has to exist — migration 044 states that any git-data reset must be
     * able to empty this table outright, or the resync replays the cached answers the reset
     * was run to discard. It does not have to be what a bare `toprope git cache clear` does.
     * Every scoped form is a considered act; the unscoped one is also what you get by typing
     * the command to see what it says, and it irreversibly drops a memo worth thousands of
     * per-commit API calls on a large org. The sibling `git set-history-floor` gates a far
     * cheaper overwrite behind `--force` on the same reasoning: the destructive intent should
     * be stated, not inferred from an omission.
     */
    all?: boolean;
}

export interface ClearDiffstatCacheResult {
    ok: boolean;
    message: string;
    /** Rows actually deleted. Zero on any refusal, and zero is also a legitimate success. */
    removed: number;
}

/**
 * Human-readable rendering of what a scope covers, for the outcome message.
 *
 * Takes the BUILT scope, not the raw input: the operator must be shown the terms the DELETE
 * actually ran with, and re-deriving them here would be a third copy of the canonicalization
 * rules (the CLI trims `--repo`, `normalizeContainer` casefolds `--container`) that drifts the
 * moment either changes. It also removes a whole class of hazard structurally — this function
 * runs AFTER the transaction commits, so anything it can throw on turns a completed purge into
 * a caught error the CLI reports as "Nothing was removed".
 */
function describeScope(scope: DiffstatScope): string {
    const parts = Object.entries(scope).map(([column, value]) => `${column}=${value}`);
    return parts.length > 0 ? parts.join(' ') : 'the ENTIRE cache (no scope given)';
}

/**
 * Validate the CLI input and apply it. Returns the outcome rather than printing or exiting,
 * so the caller owns the process contract and tests can assert the messages.
 *
 * Every flag is optional and they compose, widening over any column left out — `{}` clears
 * the whole table. That is deliberate rather than an oversight: this table is a memo of an
 * idempotent remote read of an immutable fact, so the worst an over-broad purge can do is
 * make the next sync re-fetch. It cannot lose data, cannot change a metric, and cannot move
 * a cursor. Migration 044 in fact REQUIRES the unscoped form to exist — a git-data reset that
 * left this table populated would replay the cached answers and converge on the very numbers
 * the reset was run to discard.
 */
export function clearDiffstatCache(
    db: Database.Database,
    input: ClearDiffstatCacheInput,
): ClearDiffstatCacheResult {
    const scope: DiffstatScope = {};

    // Both terms go through the shared `./git-args` parsers — the same allowlist and the same
    // canonicalization `git set-history-floor` applies, so the two commands cannot drift on
    // what a valid provider is called or on which container a spelling resolves to.
    if (input.provider !== undefined) {
        const provider = parseProviderType(input.provider);
        if (!provider.ok) return {ok: false, removed: 0, message: provider.message};
        scope.provider = provider.value;
    }

    if (input.container !== undefined) {
        const container = parseContainer(input.container);
        if (!container.ok) return {ok: false, removed: 0, message: container.message};
        scope.container = container.value;
    }

    // Repo is trimmed but NOT casefolded — repo identifiers are case-sensitive on all three
    // providers and are stored exactly as the provider's fetch path spells them, so folding
    // here would both miss the rows meant and reach rows that were not.
    //
    // Entered on `!== undefined` so that EVERY non-undefined value reaches the refusal, and a
    // non-string normalizes to '' rather than to `undefined`. An earlier revision gated the
    // branch on `!== null` as well, which skipped it entirely for a `null` — leaving
    // `scope.repo` unset, and an unset member WIDENS. A one-repo command silently becoming a
    // provider-wide purge is the one failure mode a refusal path must not have, and it is only
    // the bare `{repo: null}` case that the --all gate below happened to catch: paired with any
    // other flag the scope was non-empty and the widened DELETE ran. The container branch above
    // is total over the same input only by accident (`normalizeContainer(null)` is `''`); this
    // makes both total by construction rather than one lucky.
    if (input.repo !== undefined) {
        const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
        if (repo === '') {
            return {ok: false, removed: 0, message: '--repo must not be empty'};
        }
        scope.repo = repo;
    }

    // The empty scope is the whole table. See ClearDiffstatCacheInput.all — it must be
    // reachable, and it must be asked for.
    if (Object.keys(scope).length === 0 && input.all !== true) {
        return {
            ok: false,
            removed: 0,
            message:
                'refusing to clear the ENTIRE cache without --all. Narrow it with ' +
                '--provider / --container / --repo, or pass --all to mean it. Clearing ' +
                'everything loses no data, but re-fetching it is the most expensive phase of ' +
                'a sync — thousands of API calls on a large org. Run "toprope doctor" to see ' +
                'how much is cached.',
        };
    }

    // One transaction, so the count the message reports and the rows the DELETE removed
    // describe the same table state. `put` writes deliberately run OUTSIDE any run-level
    // transaction (that placement IS the ratchet), so a sync in flight really can insert
    // between two statements here — and "cleared 4 (7 of them absent)" is a nonsense line
    // to hand an operator. The graduated "wrap read-modify-write and multi-statement writes
    // in a transaction" rule.
    //
    // IMMEDIATE, not better-sqlite3's default deferred BEGIN, and this is load-bearing rather
    // than a precaution. A deferred transaction takes its WAL read snapshot at the SELECT and
    // only then tries to upgrade to a write; under WAL, if ANY other connection has committed
    // since that snapshot, SQLite fails the upgrade with SQLITE_BUSY_SNAPSHOT — and it does
    // NOT invoke the busy handler, because the conflict is unresolvable by waiting (the
    // transaction has to be rolled back and retried). The `busy_timeout = 5000` set in
    // `storage/db.ts` is therefore structurally unable to help, and the command fails in ~1ms.
    // Measured on this repo's better-sqlite3: deferred -> SQLITE_BUSY_SNAPSHOT after 1ms.
    //
    // That is precisely the wrong failure mode here. The concurrent writer is not exotic, it
    // is the design: `put` autocommits once per cache miss throughout a sync's fetch phase, so
    // "an operator clears the cache while a sync is running" — the case this command exists
    // for — would hard-fail instantly and keep failing for as long as the run lasted (hours on
    // the org sizes this cache is for), reported as "database is locked, wait and retry".
    // IMMEDIATE takes the write lock up front, so the wait is a real one that busy_timeout
    // bounds, and the command succeeds instead of bouncing.
    const {before, removed} = db.transaction(() => ({
        // Rows + absent only. The byte total is NOT wanted here: it is unused by every message
        // below, and reading it means scanning every matched `entries` blob WHILE holding the
        // write lock this transaction just took — stalling the very `put`s it is racing.
        before: countDiffstatRows(db, scope),
        removed: deleteDiffstats(db, scope),
    })).immediate();
    const description = describeScope(scope);

    if (removed === 0) {
        // Say what was searched and why nothing matched, rather than reporting an empty scope
        // as a completed purge. The likeliest cause by far is a spelling that does not match
        // what the write path stored, and the two columns have DIFFERENT rules — so name them
        // instead of leaving the operator to re-run the same command in a different case.
        return {
            ok: true,
            removed: 0,
            message:
                `no cached diffstats matched ${description} — nothing to clear. ` +
                'If you expected rows: --repo is matched EXACTLY as the provider spells it ' +
                '(GitHub name, Bitbucket slug, GitLab path_with_namespace), and is ' +
                'case-sensitive; --container is case-insensitive. Run "toprope doctor" to see ' +
                'the cache\'s total size.',
        };
    }

    // State the CONSEQUENCE, and state its BOUND. The first half is easy and was always here:
    // the rows are gone, and re-fetching them is the expensive phase of a sync, so an operator
    // who mis-scoped this should learn it now rather than from an unexplained multi-hour run.
    //
    // The second half is the one that matters, and saying it costs nothing while omitting it
    // costs an operator their data. A purge only causes a re-fetch of commits some future
    // sync will WALK AGAIN — and a completed run advances the forward cursor past its window,
    // with the next run's `since` starting exactly at that cursor (`fetchProviderData`), which
    // is precisely what licenses the additive commit merge. "Sync older history" walks
    // strictly BELOW the earliest watermark, so it cannot reach a forward window either.
    //
    // So for the residuals migration 044 names — a permission-revocation 404, a 404 on page
    // >= 2, a truncated 200 — clearing is NECESSARY but not SUFFICIENT once the run that
    // recorded them completed: their zeros have already merged into `raw_author_daily` and
    // been projected into `git_snapshots`, and dropping the memo does not un-merge them.
    // Reporting "no metric changed" there is true and utterly misleading — it reads as an
    // all-clear on exactly the run an operator opened this command to repair. That is the
    // graduated #235 rule (a completion signal is not a currency claim) and the graduated
    // "a remedy printed to an operator is executable advice" rule.
    //
    // The named repair is the one `sync.ts` already prescribes for the same class of
    // permanent understatement (see DIFFS_NOT_SUPPLIED_PREFIX): delete and re-add the
    // provider, because the #264 cascade retracts this container's raw rows and re-projects
    // the affected days BEFORE purging its cursors, so the re-import lands on an empty span.
    // That cascade clears these very rows too — which is why this command is the right tool
    // for the case where the window WILL be re-walked (a held or failed run) or where the
    // point is simply to stop retaining a repo's file inventory, and the wrong one on its own
    // for a window already recorded as covered.
    return {
        ok: true,
        removed,
        message:
            `cleared ${removed} cached diffstat(s) for ${description} ` +
            `(${before.absent} of them the "no diffstat exists" marker). Nothing was lost: ` +
            'these rows are a memo of an immutable remote fact, and any commit a later sync ' +
            'walks again is simply re-fetched, one API call each. ' +
            'IT DOES NOT RE-ASK COMMITS ALREADY COVERED. A completed run advanced this ' +
            "provider's forward cursor past its window and the next run starts from that " +
            'cursor, so if the answers you just deleted had already merged into ' +
            'raw_author_daily, their files_changed / code_churn_rate / ai_signature_score ' +
            'contribution is unchanged by this purge. Correcting THAT needs the span ' +
            're-imported: for a provider registered in the admin UI, delete it and re-add it ' +
            "(the delete cascade retracts this container's raw rows and re-projects the " +
            'affected days before purging its cursors, so the re-import lands on an empty ' +
            'span), then run "sync older history" for anything older than the first-sync ' +
            'window a re-added provider starts from. A config-file provider cannot be deleted ' +
            'and has no supported repair today.',
    };
}

/**
 * A one-line size report for `toprope doctor` (#286).
 *
 * `entries` is the first column in this schema to persist real source-tree paths from private
 * repos, it is uncapped per commit by design (`code_churn_rate` and `ai_signature_score` are
 * computed from the per-file shape), and it grows monotonically with distinct commits ever
 * synced — plausibly the largest table in the database. Nothing reported its size.
 *
 * Total by construction: a store whose migrations have not been applied has no
 * `commit_diffstats` table at all, and doctor's own migration check already owns that
 * failure. Reporting the read fault here as a second failed check would send the operator
 * chasing two problems that are one.
 */
export function diffstatCacheSummary(db: Database.Database): string {
    try {
        const {rows, absent, entryBytes} = countDiffstats(db);
        if (rows === 0) return 'commit_diffstats: 0 rows (nothing cached yet)';
        return (
            `commit_diffstats: ${rows.toLocaleString('en-US')} rows ` +
            `(${absent.toLocaleString('en-US')} absent), ` +
            `${formatBytes(entryBytes)} of stored file paths`
        );
    } catch (err) {
        // States what was MEASURED — nothing — rather than implying an empty cache.
        return `commit_diffstats: size could not be read (${err instanceof Error ? err.message : String(err)})`;
    }
}

/** Binary units, matching how a database file's size is usually read. */
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/**
 * Bytes as the largest unit that leaves a number below 1024, so a monorepo's cache reads as
 * "1.4 GiB" rather than as ten digits. One scaling loop rather than a ladder of thresholds:
 * a ladder needs a fixture per rung to be tested at all, and the rungs an operator will
 * actually hit are the ones hardest to seed.
 */
function formatBytes(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    // Whole bytes below the first rung — a fractional count of bytes is meaningless.
    return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
