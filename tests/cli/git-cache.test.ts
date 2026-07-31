/**
 * #286 — the operator surface for the per-commit diffstat ratchet cache (#273).
 *
 * The cache landed with no way to clear it and no way to see how big it had grown. Migration
 * 044 documents three cases where a cached answer stops being a fact about the commit (a
 * permission-revocation 404, a 404 on page >= 2 of a paged diff, a silently truncated 200) and
 * names a raw `DELETE` as the remedy — which, before this, meant opening `sqlite3` against the
 * production database. These tests drive the real `clearDiffstatCache` / `diffstatCacheSummary`
 * against a real migrated SQLite store, through the real `createCommitDiffstatCache` writer, so
 * every scope assertion is against rows the production write path actually produced.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {clearDiffstatCache, diffstatCacheSummary} from '../../src/cli/git-cache';
import {
    countDiffstats,
    createCommitDiffstatCache,
} from '../../src/connectors/git/diffstat-cache';
import type {GitFileDiff, GitProviderType} from '../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

/**
 * Deliberately carries a NON-ASCII path. `entryBytes` is rendered with byte units and its
 * whole job is saying how much private source-tree path data this database retains, so an
 * all-ASCII fixture would let `length()` (characters) pass for `octet_length()` (bytes) —
 * the two agree on exactly the input a lazy fixture picks, and disagree by up to 3× on the
 * repos that matter.
 */
const ENTRIES: GitFileDiff[] = [
    {path: 'src/サービス/handler.ts', additions: 12, deletions: 3, status: 'modified'},
];

/**
 * Seed one row per tuple through the PRODUCTION writer, so container normalization and the
 * `entries` encoding are the ones the sync pipeline produces rather than a hand-built row a
 * scope could match for the wrong reason.
 */
function seed(
    db: Database.Database,
    rows: ReadonlyArray<readonly [GitProviderType, string, string, string]>,
): void {
    for (const [provider, container, repo, sha] of rows) {
        createCommitDiffstatCache(db, provider, container).put(repo, sha, {
            additions: 12,
            deletions: 3,
            entries: ENTRIES,
            absent: false,
        });
    }
}

describe('toprope git cache clear (#286)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seed(db, [
            ['bitbucket', 'ws-a', 'api', 's1'],
            ['bitbucket', 'ws-a', 'web', 's2'],
            ['bitbucket', 'ws-b', 'api', 's3'],
            ['github', 'ws-a', 'api', 's4'],
        ]);
    });

    afterEach(() => db.close());

    describe('scope', () => {
        it('clears exactly one (provider, container, repo) and leaves the rest', () => {
            const result = clearDiffstatCache(db, {
                provider: 'bitbucket',
                container: 'ws-a',
                repo: 'web',
            });
            expect(result.ok).toBe(true);
            expect(result.removed).toBe(1);
            expect(countDiffstats(db).rows).toBe(3);
            // The other repo of the SAME container, the same repo in another container, and
            // the same repo under another provider all survive — three distinct ways a
            // dropped WHERE term would show.
            expect(countDiffstats(db, {provider: 'bitbucket', container: 'ws-a', repo: 'api'}).rows).toBe(1);
            expect(countDiffstats(db, {provider: 'bitbucket', container: 'ws-b'}).rows).toBe(1);
            expect(countDiffstats(db, {provider: 'github'}).rows).toBe(1);
        });

        it('widens over every flag omitted, up to the whole table with --all', () => {
            expect(clearDiffstatCache(db, {container: 'ws-a'}).removed).toBe(3);
            expect(countDiffstats(db).rows).toBe(1);
            // The unscoped form must exist: migration 044 requires that any git-data reset be
            // able to empty this table outright, or the resync replays the cached answers the
            // reset was run to discard.
            const all = clearDiffstatCache(db, {all: true});
            expect(all.removed).toBe(1);
            expect(all.message).toContain('the ENTIRE cache');
            expect(countDiffstats(db).rows).toBe(0);
        });

        it('refuses the unscoped purge without --all, and ignores --all when a scope is given', () => {
            // The unscoped form has to be REACHABLE, not the zero-argument default: it is
            // also what an operator gets by typing the command to see what it says, and it
            // irreversibly drops a memo worth thousands of API calls on a large org. The
            // sibling `git set-history-floor` gates a far cheaper overwrite behind --force on
            // the same reasoning.
            const bare = clearDiffstatCache(db, {});
            expect(bare.ok).toBe(false);
            expect(bare.removed).toBe(0);
            expect(bare.message).toContain('--all');
            expect(countDiffstats(db).rows).toBe(4);

            // --all alongside a scope must not WIDEN it back to the whole table — it is a
            // confirmation of the empty scope, not an override of a narrow one.
            const scoped = clearDiffstatCache(db, {container: 'ws-b', all: true});
            expect(scoped.removed).toBe(1);
            expect(countDiffstats(db).rows).toBe(3);
        });

        it('clears a repo across every provider and container — the exclude_repos case', () => {
            // Adding a repo to `exclude_repos` stops collection but leaves its cached file
            // inventory behind, and the operator does not want to name each container that
            // held it.
            expect(clearDiffstatCache(db, {repo: 'api'}).removed).toBe(3);
            expect(countDiffstats(db).rows).toBe(1);
            expect(countDiffstats(db, {repo: 'web'}).rows).toBe(1);
        });

        it('normalizes the container the way the write path does', () => {
            // The graduated #255 rule: the value compared must be the value persisted, or
            // `--container " WS-A "` reports "nothing to clear" about rows that are right
            // there.
            const result = clearDiffstatCache(db, {container: '  WS-A '});
            expect(result.removed).toBe(3);
            expect(result.message).toContain('container=ws-a');
        });

        it('matches --repo case-SENSITIVELY, unlike --container', () => {
            // Repo identifiers are case-sensitive on all three providers and are stored
            // exactly as the fetch path spells them. Folding here would make `--repo API`
            // silently purge `api` — a purge the operator did not ask for, costing a
            // multi-hour re-fetch.
            const result = clearDiffstatCache(db, {repo: 'API'});
            expect(result.ok).toBe(true);
            expect(result.removed).toBe(0);
            expect(countDiffstats(db).rows).toBe(4);
        });
    });

    describe('refusals', () => {
        it('rejects an unknown provider type instead of reporting an empty purge', () => {
            // A typo matches no row, and "0 removed" would read as a fact about the cache
            // rather than as the typo it is. Runtime allowlist, not the compile-time union:
            // the value arrives as an arbitrary CLI string.
            const result = clearDiffstatCache(db, {provider: 'githib'});
            expect(result.ok).toBe(false);
            expect(result.removed).toBe(0);
            expect(result.message).toContain('unknown provider type: githib');
            expect(result.message).toContain('github, bitbucket, gitlab');
            // Nothing was touched — a refusal must not be a partial purge.
            expect(countDiffstats(db).rows).toBe(4);
        });

        it('rejects a blank --container rather than widening to every container', () => {
            // The dangerous shape: a blank container normalizes to '', which as an equality
            // term matches nothing — but dropping the term instead would silently promote a
            // one-container command into a provider-wide purge.
            for (const container of ['', '   ']) {
                const result = clearDiffstatCache(db, {provider: 'bitbucket', container});
                expect(result.ok).toBe(false);
                expect(result.message).toBe('--container must not be empty');
            }
            expect(countDiffstats(db).rows).toBe(4);
        });

        it('rejects a blank --repo rather than widening to every repo', () => {
            const result = clearDiffstatCache(db, {repo: '   '});
            expect(result.ok).toBe(false);
            expect(result.message).toBe('--repo must not be empty');
            expect(countDiffstats(db).rows).toBe(4);
        });

        it('refuses a null/blank scope term PAIRED with another flag, instead of widening to it', () => {
            // The shape that actually bites, and the one an earlier revision got wrong. A bare
            // `{repo: null}` is caught by the --all gate no matter how the repo term behaves,
            // so asserting only that shape cannot fail on the defect it names. Paired with
            // another flag the scope is non-empty, --all never fires, and a dropped term
            // silently promotes a one-repo command into a provider-wide purge — the one
            // failure mode a refusal path must not have. Not reachable from Commander (a
            // `--repo <name>` option is `string | undefined`), which is exactly why nothing
            // else would catch it; `clearDiffstatCache` is exported as the boundary, and a
            // JSON body `{"repo": null}` is the natural shape of the next consumer.
            // `undefined` is excluded deliberately: it is the only value that legitimately
            // means "flag not given", so it widens by design rather than being refused.
            for (const blank of [null, '', '   ']) {
                const repoResult = clearDiffstatCache(db, {
                    provider: 'bitbucket',
                    repo: blank as unknown as string,
                });
                expect(repoResult.ok).toBe(false);
                expect(repoResult.removed).toBe(0);
                expect(repoResult.message).toBe('--repo must not be empty');

                const containerResult = clearDiffstatCache(db, {
                    provider: 'bitbucket',
                    container: blank as unknown as string,
                });
                expect(containerResult.ok).toBe(false);
                expect(containerResult.removed).toBe(0);
                expect(containerResult.message).toBe('--container must not be empty');
            }
            // Nothing was touched by any of them — the assertion the widening bug fails.
            expect(countDiffstats(db).rows).toBe(4);
        });

        it('reports a refusal rather than throwing AFTER the delete has committed', () => {
            // The second half of the same defect: the outcome message used to re-derive
            // `input.repo.trim()`, which throws on a null — and it runs after the transaction
            // commits, so the CLI's catch printed "Nothing was removed" over a purge that had
            // removed the provider's entire cache. The message must describe the scope the
            // DELETE actually ran with, so there is nothing left to re-derive.
            expect(() =>
                clearDiffstatCache(db, {provider: 'bitbucket', repo: null as unknown as string}),
            ).not.toThrow();
            expect(countDiffstats(db).rows).toBe(4);
            expect(countDiffstats(db, {provider: 'bitbucket'}).rows).toBe(3);
        });

        it('trims a non-blank --repo to match what the write path stored', () => {
            const result = clearDiffstatCache(db, {repo: '  api  '});
            expect(result.removed).toBe(3);
            // …and the echoed scope shows the trimmed value, so the operator sees what was
            // actually matched rather than what they typed.
            expect(result.message).toContain('repo=api');
        });
    });

    describe('messages', () => {
        it('reports the absent count OF THE SCOPE, not of the whole table', () => {
            // Two absent markers exist; only one is inside the purge scope. Without the row
            // OUTSIDE it, a regression that dropped the scope from the count would report the
            // same "1" and this assertion could not fail — and that number is the operator's
            // only evidence that a purge aimed at residual #1 (a frozen permission-revocation
            // 404) actually reached those rows.
            for (const [provider, container] of [
                ['gitlab', 'grp'],
                ['github', 'other-org'],
            ] as const) {
                createCommitDiffstatCache(db, provider, container).put('svc', 'gone', {
                    additions: 0,
                    deletions: 0,
                    entries: [],
                    absent: true,
                });
            }
            expect(countDiffstats(db).absent).toBe(2);

            const {message} = clearDiffstatCache(db, {provider: 'gitlab', container: 'grp'});
            expect(message).toContain('cleared 1 cached diffstat(s)');
            expect(message).toContain('provider=gitlab container=grp');
            expect(message).toContain('1 of them the "no diffstat exists" marker');
            expect(message).not.toContain('2 of them');
        });

        it('states the BOUND on the remedy, not just that rows are gone', () => {
            // The failure this pins: a purge aimed at a frozen 404 whose run COMPLETED cannot
            // fix the metric, because the forward cursor advanced past that window and the
            // next run starts from the cursor. "No metric changed" alone reads as an
            // all-clear on exactly the run the operator opened this command to repair — the
            // graduated #235 rule (a completion signal is not a currency claim).
            const {message} = clearDiffstatCache(db, {provider: 'github'});
            expect(message).toContain('DOES NOT RE-ASK COMMITS ALREADY COVERED');
            expect(message).toContain('forward cursor');
            // …and names the repair that DOES correct it, which is the one sync.ts already
            // prescribes for the same permanent understatement — plus the provenance that
            // has none, rather than sending a config-file operator after a route that would
            // refuse them.
            expect(message).toContain('delete it and re-add it');
            expect(message).toContain('sync older history');
            expect(message).toContain('config-file provider cannot be deleted');
        });

        it('explains an empty match by the two columns’ different case rules', () => {
            const {ok, removed, message} = clearDiffstatCache(db, {repo: 'nonexistent'});
            expect(ok).toBe(true);
            expect(removed).toBe(0);
            expect(message).toContain('no cached diffstats matched');
            expect(message).toContain('repo=nonexistent');
            // The likeliest cause is a spelling that disagrees with what the write path
            // stored, and the two columns fold differently — so both rules are named rather
            // than leaving the operator to re-run in a different case.
            expect(message).toContain('case-sensitive');
            expect(message).toContain('--container is case-insensitive');
        });
    });
});

describe('diffstatCacheSummary (the toprope doctor line, #286)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => db.close());

    it('says the cache is empty rather than printing a zero-filled report', () => {
        expect(diffstatCacheSummary(db)).toBe('commit_diffstats: 0 rows (nothing cached yet)');
    });

    it('reports rows, absent markers and the bytes the stored paths occupy', () => {
        seed(db, [
            ['github', 'org', 'api', 's1'],
            ['github', 'org', 'api', 's2'],
        ]);
        createCommitDiffstatCache(db, 'github', 'org').put('api', 's3', {
            additions: 0,
            deletions: 0,
            entries: [],
            absent: true,
        });

        const summary = diffstatCacheSummary(db);
        expect(summary).toContain('commit_diffstats: 3 rows (1 absent)');
        // The size half of the line is the point of it: `entries` is uncapped by design and
        // is the first column in this schema to persist real source-tree paths from private
        // repos, so "how much of this database is file paths" is the signal that says whether
        // a purge is worth issuing. Asserted as the exact BYTE total the two real entry lists
        // plus the absent row's '[]' occupy — a report summing the wrong column, or skipping
        // the absent row, lands on a different number.
        const bytes = Buffer.byteLength(JSON.stringify(ENTRIES)) * 2 + '[]'.length;
        expect(summary).toContain(`${bytes} B of stored file paths`);
        // …and BYTES, not characters. The fixture path is non-ASCII, so `length()` and
        // `octet_length()` disagree — this is the assertion that can fail if the query
        // reverts, and the reason the fixture is not plain ASCII.
        const characters = JSON.stringify(ENTRIES).length * 2 + '[]'.length;
        expect(bytes).toBeGreaterThan(characters);
        expect(summary).not.toContain(`${characters} B`);
    });

    it('scales the size unit rather than printing raw bytes for a large cache', () => {
        // A monorepo's cache is the case this line exists for, and "182,331,904 B" is not a
        // number an operator reads at a glance.
        seed(
            db,
            Array.from({length: 200}, (_, i) => ['github', 'org', 'api', `s${i}`] as const),
        );
        expect(diffstatCacheSummary(db)).toMatch(/\d+\.\d KiB of stored file paths$/);
    });

    it('groups thousands so a large cache is readable at a glance', () => {
        const rows = Array.from(
            {length: 1500},
            (_, i) => ['github', 'org', 'api', `s${i}`] as const,
        );
        seed(db, rows);
        expect(diffstatCacheSummary(db)).toContain('commit_diffstats: 1,500 rows');
    });

    it('reports a read fault as unmeasured rather than as an empty cache', () => {
        // A store whose migrations have not run has no table at all. Doctor's own migration
        // check owns that failure; this line must not ALSO claim the cache is empty, which is
        // a positive claim inferred from a check that could not run.
        db.exec('DROP TABLE commit_diffstats');
        const summary = diffstatCacheSummary(db);
        expect(summary).toContain('size could not be read');
        expect(summary).not.toContain('0 rows');
    });
});
