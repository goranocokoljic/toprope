import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
    rawAuthorKeyFor,
    commitWeightedAvg,
    mergeDailyAcrossRuns,
    upsertRawAuthorDaily,
    readRawDailyForKeys,
    readRawDailyForDates,
    distinctRawAuthorIdentities,
    summarizeContainerRawDaily,
    containerRawAuthorIdentities,
    containerRawDailyDates,
    deleteContainerRawDaily,
    RawAuthorDailyError,
    findRawAuthorDailyDefect,
    RAW_AUTHOR_DAILY_ERROR_CODES,
    type DailyGitMetrics,
    type RawAuthorDailyInput,
} from '../../src/connectors/git/raw-author-daily';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const ZERO_METRICS: DailyGitMetrics = {
    commits: 0,
    lines_added: 0,
    lines_removed: 0,
    files_changed: 0,
    prs_opened: 0,
    prs_merged: 0,
    review_comments_given: 0,
    avg_time_to_merge_hours: null,
    code_churn_rate: 0,
    ai_signature_score: 0,
    avg_commit_size: 0,
    commit_burst_count: 0,
};

function metrics(over: Partial<DailyGitMetrics> = {}): DailyGitMetrics {
    return {...ZERO_METRICS, ...over};
}

function input(over: Partial<RawAuthorDailyInput> = {}): RawAuthorDailyInput {
    return {
        provider: 'github',
        container: 'acme',
        raw_author_key: 'github:login:alice',
        author_login: 'alice',
        author_email: 'alice@example.com',
        author_display_name: 'Alice A',
        date: '2026-07-01',
        ...ZERO_METRICS,
        ...over,
    };
}

describe('rawAuthorKeyFor — total key derivation (#252)', () => {
    it('prefers the login, preserving its case verbatim (resolveDeveloperId matches case-sensitively)', () => {
        expect(rawAuthorKeyFor('github', 'AliceB', 'alice@example.com')).toBe('github:login:AliceB');
    });

    it('falls back to the LOWERCASED email when the login is absent', () => {
        expect(rawAuthorKeyFor('bitbucket', null, 'Alice@Example.COM')).toBe('bitbucket:email:alice@example.com');
    });

    it('treats a blank/whitespace login as absent and falls through to the email', () => {
        expect(rawAuthorKeyFor('gitlab', '   ', 'bob@example.com')).toBe('gitlab:email:bob@example.com');
        expect(rawAuthorKeyFor('gitlab', '', 'bob@example.com')).toBe('gitlab:email:bob@example.com');
    });

    it('trims surrounding whitespace off a real login rather than keying on it', () => {
        expect(rawAuthorKeyFor('github', '  alice  ', null)).toBe('github:login:alice');
    });

    it('returns null when BOTH are blank — never keys a truly-anonymous commit as ""', () => {
        expect(rawAuthorKeyFor('github', null, null)).toBeNull();
        expect(rawAuthorKeyFor('github', '', '')).toBeNull();
        expect(rawAuthorKeyFor('github', '  ', '  ')).toBeNull();
        expect(rawAuthorKeyFor('github', undefined, undefined)).toBeNull();
    });

    it('namespaces by provider — the same login under two providers is two distinct keys', () => {
        expect(rawAuthorKeyFor('github', 'alice', null)).not.toBe(rawAuthorKeyFor('gitlab', 'alice', null));
    });
});

describe('commitWeightedAvg (#252)', () => {
    it('weights each side by its commit count', () => {
        // 100 commits at 0.9 vs 1 commit at 0.0 stays near 0.9, not at the 0.45 mean.
        expect(commitWeightedAvg(0.9, 100, 0.0, 1)).toBeCloseTo(0.8911, 4);
    });

    it('returns 0 when neither side has commits (the neutral per-commit value)', () => {
        expect(commitWeightedAvg(5, 0, 9, 0)).toBe(0);
    });

    it('returns the populated side verbatim when the other has no commits', () => {
        expect(commitWeightedAvg(0.7, 4, 0.1, 0)).toBeCloseTo(0.7);
    });
});

describe('mergeDailyAcrossRuns — the one cross-run rule (#252, ported from the git_snapshots merge tests)', () => {
    it('ADDS commit-derived deltas across two disjoint commit windows', () => {
        const merged = mergeDailyAcrossRuns(
            metrics({commits: 3, lines_added: 100, lines_removed: 10, files_changed: 5, commit_burst_count: 1}),
            metrics({commits: 2, lines_added: 40, lines_removed: 4, files_changed: 3, commit_burst_count: 2}),
        );
        expect(merged.commits).toBe(5);
        expect(merged.lines_added).toBe(140);
        expect(merged.lines_removed).toBe(14);
        expect(merged.files_changed).toBe(8);
        expect(merged.commit_burst_count).toBe(3);
    });

    it('does NOT inflate PR/review fields when the same PRs are re-delivered (max, not sum)', () => {
        const stored = metrics({prs_opened: 2, prs_merged: 1, review_comments_given: 5});
        const redelivered = metrics({prs_opened: 2, prs_merged: 1, review_comments_given: 5});
        const merged = mergeDailyAcrossRuns(stored, redelivered);
        expect(merged.prs_opened).toBe(2);
        expect(merged.prs_merged).toBe(1);
        expect(merged.review_comments_given).toBe(5);
    });

    it('never drops below the stored PR counts when a scoped run reports fewer', () => {
        const merged = mergeDailyAcrossRuns(
            metrics({prs_opened: 4, prs_merged: 3, review_comments_given: 9}),
            metrics({commits: 1}),
        );
        expect(merged.prs_opened).toBe(4);
        expect(merged.prs_merged).toBe(3);
        expect(merged.review_comments_given).toBe(9);
    });

    it('raises PR counts when the incoming run genuinely observed more', () => {
        const merged = mergeDailyAcrossRuns(metrics({prs_merged: 1}), metrics({prs_merged: 4}));
        expect(merged.prs_merged).toBe(4);
    });

    it('commit-weights rate fields — a 1-commit delta cannot drag a 100-commit row to a plain mean', () => {
        const merged = mergeDailyAcrossRuns(
            metrics({commits: 100, code_churn_rate: 0.9, ai_signature_score: 0.8, avg_commit_size: 50}),
            metrics({commits: 1, code_churn_rate: 0.0, ai_signature_score: 0.0, avg_commit_size: 1}),
        );
        expect(merged.code_churn_rate).toBeCloseTo(0.8911, 4);
        expect(merged.ai_signature_score).toBeCloseTo(0.7921, 4);
        expect(merged.avg_commit_size).toBeCloseTo(49.5149, 3);
        // Sanity: a plain mean would have been 0.45 / 0.40 / 25.5.
        expect(merged.code_churn_rate).toBeGreaterThan(0.45);
    });

    it('takes avg_time_to_merge from the side owning the LARGER prs_merged', () => {
        const merged = mergeDailyAcrossRuns(
            metrics({prs_merged: 1, avg_time_to_merge_hours: 10}),
            metrics({prs_merged: 3, avg_time_to_merge_hours: 2}),
        );
        expect(merged.avg_time_to_merge_hours).toBe(2);
    });

    it('keeps the first-observed avg_time_to_merge on a prs_merged tie (same-PR re-delivery)', () => {
        const merged = mergeDailyAcrossRuns(
            metrics({prs_merged: 2, avg_time_to_merge_hours: 10}),
            metrics({prs_merged: 2, avg_time_to_merge_hours: 99}),
        );
        expect(merged.avg_time_to_merge_hours).toBe(10);
    });

    it('falls back across a null avg_time_to_merge on either side', () => {
        expect(
            mergeDailyAcrossRuns(
                metrics({prs_merged: 1, avg_time_to_merge_hours: null}),
                metrics({prs_merged: 3, avg_time_to_merge_hours: null}),
            ).avg_time_to_merge_hours,
        ).toBeNull();
        expect(
            mergeDailyAcrossRuns(
                metrics({prs_merged: 0, avg_time_to_merge_hours: null}),
                metrics({prs_merged: 1, avg_time_to_merge_hours: 7}),
            ).avg_time_to_merge_hours,
        ).toBe(7);
        expect(
            mergeDailyAcrossRuns(
                metrics({prs_merged: 5, avg_time_to_merge_hours: 6}),
                metrics({prs_merged: 9, avg_time_to_merge_hours: null}),
            ).avg_time_to_merge_hours,
        ).toBe(6);
    });

    it('is associative enough for THREE runs: three disjoint deltas still add, PRs still do not', () => {
        const a = metrics({commits: 1, lines_added: 10, prs_merged: 2, review_comments_given: 3});
        const b = metrics({commits: 2, lines_added: 20, prs_merged: 2, review_comments_given: 3});
        const c = metrics({commits: 4, lines_added: 40, prs_merged: 2, review_comments_given: 3});
        const merged = mergeDailyAcrossRuns(mergeDailyAcrossRuns(a, b), c);
        expect(merged.commits).toBe(7);
        expect(merged.lines_added).toBe(70);
        expect(merged.prs_merged).toBe(2);
        expect(merged.review_comments_given).toBe(3);
    });

    it('merging a zero delta is a no-op on every field (idempotent re-run of an empty window)', () => {
        const stored = metrics({
            commits: 9, lines_added: 90, lines_removed: 9, files_changed: 4,
            prs_opened: 2, prs_merged: 1, review_comments_given: 6,
            avg_time_to_merge_hours: 3, code_churn_rate: 0.4, ai_signature_score: 0.5,
            avg_commit_size: 10, commit_burst_count: 2,
        });
        expect(mergeDailyAcrossRuns(stored, metrics())).toEqual(stored);
    });
});

describe('upsertRawAuthorDaily + readers (#252)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => {
        db.close();
    });

    function stored(key = 'github:login:alice', date = '2026-07-01'): Record<string, number | string | null> {
        return db
            .prepare('SELECT * FROM raw_author_daily WHERE raw_author_key = ? AND date = ?')
            .get(key, date) as Record<string, number | string | null>;
    }

    it('inserts a first observation with first_seen = last_seen = the run instant', () => {
        upsertRawAuthorDaily(db, input({commits: 3, lines_added: 60}), '2026-07-01T10:00:00.000Z');
        const row = stored();
        expect(row.commits).toBe(3);
        expect(row.lines_added).toBe(60);
        expect(row.first_seen).toBe('2026-07-01T10:00:00.000Z');
        expect(row.last_seen).toBe('2026-07-01T10:00:00.000Z');
    });

    it('accumulates a second run additively and keeps exactly ONE row for the key/day', () => {
        upsertRawAuthorDaily(db, input({commits: 3, lines_added: 60}), '2026-07-01T10:00:00.000Z');
        upsertRawAuthorDaily(db, input({commits: 2, lines_added: 40}), '2026-07-02T10:00:00.000Z');
        const count = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number};
        expect(count.n).toBe(1);
        const row = stored();
        expect(row.commits).toBe(5);
        expect(row.lines_added).toBe(100);
    });

    it('does NOT inflate prs/review across runs that re-deliver the same PRs', () => {
        const pr = {prs_opened: 2, prs_merged: 1, review_comments_given: 5};
        upsertRawAuthorDaily(db, input(pr), '2026-07-01T10:00:00.000Z');
        upsertRawAuthorDaily(db, input({...pr, commits: 1}), '2026-07-02T10:00:00.000Z');
        upsertRawAuthorDaily(db, input({...pr, commits: 1}), '2026-07-03T10:00:00.000Z');
        const row = stored();
        expect(row.prs_opened).toBe(2);
        expect(row.prs_merged).toBe(1);
        expect(row.review_comments_given).toBe(5);
        expect(row.commits).toBe(2);
    });

    it('PRESERVES first_seen and ADVANCES last_seen across runs', () => {
        upsertRawAuthorDaily(db, input(), '2026-07-01T10:00:00.000Z');
        upsertRawAuthorDaily(db, input(), '2026-07-05T10:00:00.000Z');
        const row = stored();
        expect(row.first_seen).toBe('2026-07-01T10:00:00.000Z');
        expect(row.last_seen).toBe('2026-07-05T10:00:00.000Z');
    });

    it('never moves last_seen BACKWARD when a run reports a skewed earlier clock', () => {
        upsertRawAuthorDaily(db, input(), '2026-07-05T10:00:00.000Z');
        upsertRawAuthorDaily(db, input(), '2026-07-01T10:00:00.000Z');
        const row = stored();
        expect(row.first_seen).toBe('2026-07-05T10:00:00.000Z');
        expect(row.last_seen).toBe('2026-07-05T10:00:00.000Z');
    });

    it('gains identity information without ever erasing it', () => {
        upsertRawAuthorDaily(
            db,
            input({author_login: 'alice', author_email: null, author_display_name: null}),
            '2026-07-01T10:00:00.000Z',
        );
        upsertRawAuthorDaily(
            db,
            input({author_login: 'alice', author_email: 'alice@example.com', author_display_name: 'Alice A'}),
            '2026-07-02T10:00:00.000Z',
        );
        expect(stored().author_email).toBe('alice@example.com');
        expect(stored().author_display_name).toBe('Alice A');

        // A later run that knows less must not blank the stored values.
        upsertRawAuthorDaily(
            db,
            input({author_login: 'alice', author_email: null, author_display_name: '   '}),
            '2026-07-03T10:00:00.000Z',
        );
        expect(stored().author_email).toBe('alice@example.com');
        expect(stored().author_display_name).toBe('Alice A');
    });

    it('keeps different days, different keys and different providers as separate rows', () => {
        upsertRawAuthorDaily(db, input({commits: 1}), '2026-07-01T10:00:00.000Z');
        upsertRawAuthorDaily(db, input({date: '2026-07-02', commits: 2}), '2026-07-02T10:00:00.000Z');
        upsertRawAuthorDaily(
            db,
            input({provider: 'gitlab', raw_author_key: 'gitlab:login:alice', commits: 4}),
            '2026-07-02T10:00:00.000Z',
        );
        const count = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number};
        expect(count.n).toBe(3);
    });

    it('returns the merged record it wrote', () => {
        upsertRawAuthorDaily(db, input({commits: 3}), '2026-07-01T10:00:00.000Z');
        const result = upsertRawAuthorDaily(db, input({commits: 4}), '2026-07-02T10:00:00.000Z');
        expect(result.commits).toBe(7);
        expect(result.first_seen).toBe('2026-07-01T10:00:00.000Z');
        expect(result.last_seen).toBe('2026-07-02T10:00:00.000Z');
    });

    it('rejects an unknown provider fail-closed, with a typed error and NO row written', () => {
        expect(() =>
            upsertRawAuthorDaily(
                db,
                input({provider: 'perforce' as never, raw_author_key: 'perforce:login:x'}),
                '2026-07-01T10:00:00.000Z',
            ),
        ).toThrow(RawAuthorDailyError);
        const count = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number};
        expect(count.n).toBe(0);
    });

    it('rejects a blank key, a malformed date, and a non-ISO instant with distinct codes', () => {
        const codeOf = (fn: () => void): string => {
            try {
                fn();
            } catch (e) {
                return (e as RawAuthorDailyError).code;
            }
            throw new Error('expected a throw');
        };
        expect(codeOf(() => upsertRawAuthorDaily(db, input({raw_author_key: '  '}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_key');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({date: '2026-7-1'}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_date');
        // A conforming 10-char PREFIX with trailing junk — the one input class that distinguishes
        // the shared `isUtcDay`'s anchored regex from an unanchored one (#290). Every other
        // negative fixture here and in the projection's suite is malformed from character 1, so
        // relaxing `DATE_RE` would keep them all green while this instant slipped past the typed
        // guard into the schema's fully-anchored GLOB — a raw SQLITE_CONSTRAINT thrown from inside
        // the run's all-providers write transaction, which is the stall #290 exists to prevent.
        expect(codeOf(() => upsertRawAuthorDaily(db, input({date: '2026-07-01T10:00:00.000Z'}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_date');
        expect(codeOf(() => upsertRawAuthorDaily(db, input(), 'not-a-date'))).toBe('invalid_instant');
    });

    it('rejects an expanded-year ISO instant, which would sort BEFORE ordinary years', () => {
        expect(() => upsertRawAuthorDaily(db, input(), '+010000-01-01T00:00:00.000Z')).toThrow(RawAuthorDailyError);
    });

    it('LOWERCASES author_email at the write boundary, matching the identity-map lookup', () => {
        upsertRawAuthorDaily(
            db,
            input({author_email: '  Alice@Example.COM  '}),
            '2026-07-01T10:00:00.000Z',
        );
        expect(stored().author_email).toBe('alice@example.com');
    });

    it('canonicalizes casing across runs so one author never rolls up under two spellings', () => {
        upsertRawAuthorDaily(
            db,
            input({
                raw_author_key: 'github:email:bob@example.com',
                author_login: null,
                author_email: 'BOB@example.com',
                date: '2026-07-01',
                commits: 1,
            }),
            '2026-07-01T10:00:00.000Z',
        );
        upsertRawAuthorDaily(
            db,
            input({
                raw_author_key: 'github:email:bob@example.com',
                author_login: null,
                author_email: 'bob@Example.com',
                date: '2026-07-02',
                commits: 1,
            }),
            '2026-07-02T10:00:00.000Z',
        );
        const bob = distinctRawAuthorIdentities(db).find((a) => a.raw_author_key === 'github:email:bob@example.com');
        expect(bob?.email).toBe('bob@example.com');
        expect(bob?.commit_count).toBe(2);
    });

    it('rejects a key whose provider prefix disagrees with the provider column', () => {
        expect(() =>
            upsertRawAuthorDaily(
                db,
                input({provider: 'gitlab', raw_author_key: 'github:login:alice'}),
                '2026-07-01T10:00:00.000Z',
            ),
        ).toThrow(RawAuthorDailyError);
        // The read whose safety argument is that invariant stays uncontaminated.
        expect(readRawDailyForKeys(db, ['github:login:alice'])).toEqual([]);
    });

    it('rejects out-of-range metrics with a typed error, not a raw SQLITE_CONSTRAINT', () => {
        const codeOf = (fn: () => void): string => {
            try {
                fn();
            } catch (e) {
                expect(e).toBeInstanceOf(RawAuthorDailyError);
                return (e as RawAuthorDailyError).code;
            }
            throw new Error('expected a throw');
        };
        expect(codeOf(() => upsertRawAuthorDaily(db, input({commits: -1}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({prs_merged: 1.5}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        // NaN binds as NULL into a NOT NULL column — the raw error would name the wrong problem.
        expect(codeOf(() => upsertRawAuthorDaily(db, input({commits: NaN}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({code_churn_rate: NaN}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({ai_signature_score: Infinity}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({avg_time_to_merge_hours: NaN}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get()).toEqual({n: 0});
    });

    it('accepts a null avg_time_to_merge_hours (the "nothing merged" case is not a bad metric)', () => {
        expect(() =>
            upsertRawAuthorDaily(db, input({avg_time_to_merge_hours: null}), '2026-07-01T10:00:00.000Z'),
        ).not.toThrow();
    });

    describe('readRawDailyForKeys', () => {
        beforeEach(() => {
            upsertRawAuthorDaily(db, input({date: '2026-07-02', commits: 2}), '2026-07-02T10:00:00.000Z');
            upsertRawAuthorDaily(db, input({date: '2026-07-01', commits: 1}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(
                db,
                input({raw_author_key: 'github:login:bob', author_login: 'bob', date: '2026-07-01', commits: 9}),
                '2026-07-01T10:00:00.000Z',
            );
        });

        it('returns every retained day for the requested keys', () => {
            const rows = readRawDailyForKeys(db, ['github:login:alice']);
            expect(rows.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02']);
            expect(rows.map((r) => r.commits)).toEqual([1, 2]);
        });

        it('reads MULTIPLE keys in one call, deterministically ordered by (date, provider, key)', () => {
            const rows = readRawDailyForKeys(db, ['github:login:bob', 'github:login:alice']);
            expect(rows.map((r) => `${r.date}/${r.raw_author_key}`)).toEqual([
                '2026-07-01/github:login:alice',
                '2026-07-01/github:login:bob',
                '2026-07-02/github:login:alice',
            ]);
        });

        it('returns [] for an empty list, an all-blank list, and an unknown key (no full scan)', () => {
            expect(readRawDailyForKeys(db, [])).toEqual([]);
            expect(readRawDailyForKeys(db, ['', '   '])).toEqual([]);
            expect(readRawDailyForKeys(db, ['github:login:ghost'])).toEqual([]);
        });

        it('handles a key set larger than one bind chunk without dropping rows', () => {
            const filler = Array.from({length: 1200}, (_, i) => `github:login:filler${i}`);
            const rows = readRawDailyForKeys(db, [...filler, 'github:login:bob']);
            expect(rows).toHaveLength(1);
            expect(rows[0].commits).toBe(9);
        });
    });

    describe('readRawDailyForDates', () => {
        beforeEach(() => {
            upsertRawAuthorDaily(db, input({date: '2026-07-01', commits: 1}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(
                db,
                input({raw_author_key: 'github:login:bob', author_login: 'bob', date: '2026-07-01', commits: 9}),
                '2026-07-01T10:00:00.000Z',
            );
            upsertRawAuthorDaily(db, input({date: '2026-07-03', commits: 5}), '2026-07-03T10:00:00.000Z');
        });

        it('returns every author active on the requested days', () => {
            const rows = readRawDailyForDates(db, ['2026-07-01']);
            expect(rows.map((r) => r.raw_author_key)).toEqual(['github:login:alice', 'github:login:bob']);
        });

        it('reads several days at once and skips days with no activity', () => {
            const rows = readRawDailyForDates(db, ['2026-07-03', '2026-07-02', '2026-07-01']);
            expect(rows.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-01', '2026-07-03']);
        });

        it('returns [] for an empty list and drops malformed dates rather than scanning', () => {
            expect(readRawDailyForDates(db, [])).toEqual([]);
            expect(readRawDailyForDates(db, ['2026-7-1', 'yesterday'])).toEqual([]);
        });

        // A chunked read orders each chunk in SQL; without a final sort the concatenated
        // result is a sequence of independently-sorted runs — correct below the chunk
        // size and silently wrong above it. Exercise BOTH readers past the boundary.
        it('stays globally sorted across chunk boundaries, for both readers', () => {
            const fresh = new Database(':memory:');
            try {
                runMigrations(fresh, MIGRATIONS_DIR);

                const DAYS = 700; // > READ_CHUNK_SIZE (500)
                const dates: string[] = [];
                const keys: string[] = [];
                for (let i = 0; i < DAYS; i++) {
                    const day = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
                    const key = `github:login:dev${String(i).padStart(4, '0')}`;
                    dates.push(day);
                    keys.push(key);
                    upsertRawAuthorDaily(
                        fresh,
                        input({raw_author_key: key, author_login: `dev${i}`, date: day, commits: 1}),
                        '2026-07-01T10:00:00.000Z',
                    );
                }

                // Feed both readers in DESCENDING order so an unsorted concatenation
                // would come back visibly out of order rather than accidentally right.
                const byDate = readRawDailyForDates(fresh, [...dates].reverse());
                const byKey = readRawDailyForKeys(fresh, [...keys].reverse());

                expect(byDate).toHaveLength(DAYS);
                expect(byKey).toHaveLength(DAYS);
                expect(byDate.map((r) => r.date)).toEqual([...dates]);
                expect(byKey.map((r) => r.date)).toEqual([...dates]);
            } finally {
                fresh.close();
            }
        });
    });

    describe('distinctRawAuthorIdentities (rollup semantics)', () => {
        it('rolls each key up across its days, summing commits and spanning first/last seen', () => {
            upsertRawAuthorDaily(db, input({date: '2026-07-01', commits: 3}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(db, input({date: '2026-07-02', commits: 4}), '2026-07-04T10:00:00.000Z');

            const authors = distinctRawAuthorIdentities(db);
            expect(authors).toHaveLength(1);
            expect(authors[0]).toMatchObject({
                provider: 'github',
                raw_author_key: 'github:login:alice',
                login: 'alice',
                email: 'alice@example.com',
                display_name: 'Alice A',
                commit_count: 7,
                first_seen: '2026-07-01T10:00:00.000Z',
                last_seen: '2026-07-04T10:00:00.000Z',
            });
        });

        it('orders busiest-first with a total, deterministic tiebreak on the identity', () => {
            upsertRawAuthorDaily(db, input({commits: 2}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(
                db,
                input({raw_author_key: 'github:login:bob', author_login: 'bob', commits: 50}),
                '2026-07-01T10:00:00.000Z',
            );
            // Two keys tied on commits AND last_seen — the identity must break the tie.
            upsertRawAuthorDaily(
                db,
                input({raw_author_key: 'github:login:carol', author_login: 'carol', commits: 2}),
                '2026-07-01T10:00:00.000Z',
            );

            const order = distinctRawAuthorIdentities(db).map((a) => a.raw_author_key);
            expect(order).toEqual(['github:login:bob', 'github:login:alice', 'github:login:carol']);
            // Stable across repeated calls — no rowid/UUID dependence.
            expect(distinctRawAuthorIdentities(db).map((a) => a.raw_author_key)).toEqual(order);
        });

        it('surfaces an email-keyed author with a null login', () => {
            upsertRawAuthorDaily(
                db,
                input({
                    raw_author_key: 'github:email:ghost@example.com',
                    author_login: null,
                    author_email: 'ghost@example.com',
                    author_display_name: 'Ghost',
                    commits: 1,
                }),
                '2026-07-01T10:00:00.000Z',
            );
            const author = distinctRawAuthorIdentities(db).find(
                (a) => a.raw_author_key === 'github:email:ghost@example.com',
            );
            expect(author?.login).toBeNull();
            expect(author?.email).toBe('ghost@example.com');
        });

        it('returns [] on an empty store', () => {
            expect(distinctRawAuthorIdentities(db)).toEqual([]);
        });

        // #264: the container is NOT part of this grain. Attribution resolves (login, email),
        // so splitting by container would list one person twice for committing in two
        // workspaces — a finer grain than any consumer's question.
        it('folds one author’s two containers into ONE identity variant', () => {
            upsertRawAuthorDaily(db, input({container: 'ws-a', commits: 3}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(db, input({container: 'ws-b', commits: 4}), '2026-07-01T10:00:00.000Z');
            const authors = distinctRawAuthorIdentities(db);
            expect(authors).toHaveLength(1);
            expect(authors[0].commit_count).toBe(7);
        });
    });

    // ─── Per-container attribution (#264) ─────────────────────────────────────────
    describe('container attribution', () => {
        it('refuses a missing/blank/whitespace container with a typed invalid_container', () => {
            for (const container of [undefined, '', '   '] as unknown[]) {
                try {
                    upsertRawAuthorDaily(
                        db,
                        {...input(), container} as RawAuthorDailyInput,
                        '2026-07-01T10:00:00.000Z',
                    );
                    throw new Error(`should have thrown for ${JSON.stringify(container)}`);
                } catch (e) {
                    expect(e).toBeInstanceOf(RawAuthorDailyError);
                    expect((e as RawAuthorDailyError).code).toBe('invalid_container');
                }
            }
            expect(readRawDailyForDates(db, ['2026-07-01'])).toEqual([]);
        });

        it('keeps two containers’ same-key/same-day contributions as INDEPENDENT rows', () => {
            upsertRawAuthorDaily(db, input({container: 'ws-a', commits: 3, prs_merged: 1}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(db, input({container: 'ws-b', commits: 5, prs_merged: 2}), '2026-07-01T10:00:00.000Z');

            const rows = readRawDailyForDates(db, ['2026-07-01']);
            expect(rows.map((r) => [r.container, r.commits, r.prs_merged])).toEqual([
                ['ws-a', 3, 1],
                ['ws-b', 5, 2],
            ]);
        });

        it('still merges ACROSS RUNS within one container', () => {
            upsertRawAuthorDaily(db, input({container: 'ws-a', commits: 3}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(db, input({container: 'ws-a', commits: 4}), '2026-07-02T10:00:00.000Z');
            const rows = readRawDailyForDates(db, ['2026-07-01']);
            expect(rows).toHaveLength(1);
            expect(rows[0].commits).toBe(7);
        });

        it('summarizes, lists dates for, and deletes ONE container without touching a sibling', () => {
            upsertRawAuthorDaily(db, input({container: 'ws-a', commits: 3}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(
                db,
                input({container: 'ws-a', date: '2026-07-03', commits: 4}),
                '2026-07-03T10:00:00.000Z',
            );
            upsertRawAuthorDaily(db, input({container: 'ws-b', commits: 9}), '2026-07-01T10:00:00.000Z');

            expect(summarizeContainerRawDaily(db, 'github', 'ws-a')).toEqual({
                rows: 2,
                days: 2,
                earliestDate: '2026-07-01',
                latestDate: '2026-07-03',
                commits: 7,
                authors: 1,
            });
            expect(containerRawDailyDates(db, 'github', 'ws-a')).toEqual(['2026-07-01', '2026-07-03']);
            expect(containerRawAuthorIdentities(db, 'github', 'ws-a')).toEqual([
                {raw_author_key: 'github:login:alice', login: 'alice', email: 'alice@example.com'},
            ]);

            expect(deleteContainerRawDaily(db, 'github', 'ws-a')).toBe(2);
            const survivors = readRawDailyForDates(db, ['2026-07-01', '2026-07-03']);
            expect(survivors.map((r) => [r.container, r.commits])).toEqual([['ws-b', 9]]);
        });

        it('summarizes an empty container as zeros with null date bounds (never null-as-unknown)', () => {
            expect(summarizeContainerRawDaily(db, 'github', 'nothing-here')).toEqual({
                rows: 0,
                days: 0,
                earliestDate: null,
                latestDate: null,
                commits: 0,
                authors: 0,
            });
            expect(containerRawDailyDates(db, 'github', 'nothing-here')).toEqual([]);
            expect(deleteContainerRawDaily(db, 'github', 'nothing-here')).toBe(0);
        });

        // The replay path (#253) reads by KEY, deliberately unscoped by container: who a raw
        // identity is does not depend on which workspace they committed in, so a scope that
        // missed one container would rebuild only part of that developer's days.
        it('readRawDailyForKeys spans EVERY container a key was seen in', () => {
            upsertRawAuthorDaily(db, input({container: 'ws-a', commits: 3}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(
                db,
                input({container: 'ws-b', date: '2026-07-05', commits: 4}),
                '2026-07-05T10:00:00.000Z',
            );
            const rows = readRawDailyForKeys(db, ['github:login:alice']);
            expect(rows.map((r) => [r.container, r.date])).toEqual([
                ['ws-a', '2026-07-01'],
                ['ws-b', '2026-07-05'],
            ]);
        });

        it('scopes the delete by the FULL key — the same container name under another family survives', () => {
            upsertRawAuthorDaily(db, input({container: 'shared', commits: 3}), '2026-07-01T10:00:00.000Z');
            upsertRawAuthorDaily(
                db,
                input({
                    provider: 'gitlab',
                    container: 'shared',
                    raw_author_key: 'gitlab:login:alice',
                    commits: 8,
                }),
                '2026-07-01T10:00:00.000Z',
            );
            expect(deleteContainerRawDaily(db, 'github', 'shared')).toBe(1);
            const rows = readRawDailyForDates(db, ['2026-07-01']);
            expect(rows.map((r) => [r.provider, r.commits])).toEqual([['gitlab', 8]]);
        });
    });
});

/**
 * #302 — the same refusal, asked instead of suffered.
 *
 * `upsertRawAuthorDaily` throws INSIDE the git sync's single all-providers write transaction,
 * so a row it refuses does not cost a row: it rolls back every provider's window and recurs
 * identically on every run. The sync therefore asks this function first and skips the row. The
 * property that makes that safe is AGREEMENT — a row this returns `null` for must be one the
 * throwing form accepts, and vice versa — which is why the two share a body rather than a rule
 * list, and why the table below drives both forms over the same inputs.
 */
describe('findRawAuthorDailyDefect — the non-throwing form of the write boundary (#302)', () => {
    const OBSERVED = '2026-07-01T10:00:00.000Z';

    /** Every refusal class the validator can reach, with the code it must report. */
    const REFUSALS: Array<{name: string; row: RawAuthorDailyInput; observedAt: string; code: string}> = [
        {
            name: 'an unknown provider',
            row: input({provider: 'perforce' as never, raw_author_key: 'perforce:login:x'}),
            observedAt: OBSERVED,
            code: 'invalid_provider',
        },
        {name: 'a blank container', row: input({container: '   '}), observedAt: OBSERVED, code: 'invalid_container'},
        {name: 'a blank key', row: input({raw_author_key: '  '}), observedAt: OBSERVED, code: 'invalid_key'},
        {
            name: 'a key not namespaced by its provider',
            row: input({raw_author_key: 'gitlab:login:alice'}),
            observedAt: OBSERVED,
            code: 'invalid_key',
        },
        // The three PR/comment doors #302 exists for: `analyzer.ts` derives the day with a bare
        // 10-char slice of `pr.createdAt` / `pr.mergedAt` / `comment.createdAt`, so an expanded
        // ISO year arrives here looking exactly like this.
        {name: 'an expanded-year day slice', row: input({date: '+033658-0'}), observedAt: OBSERVED, code: 'invalid_date'},
        {name: 'an unparseable day slice', row: input({date: 'not-a-dat'}), observedAt: OBSERVED, code: 'invalid_date'},
        // What a NON-STRING `pr.createdAt` becomes: `toDateString` refuses to coerce it, so the
        // day is empty rather than a value an odd JSON body manufactured.
        {name: 'an empty day', row: input({date: ''}), observedAt: OBSERVED, code: 'invalid_date'},
        {name: 'a non-ISO observedAt', row: input(), observedAt: 'not-a-date', code: 'invalid_instant'},
        // The FOURTH door, and the one no date check catches: `new Date(mergedAt) -
        // new Date(createdAt)` is NaN whenever either operand is unparseable, on a row whose own
        // day may be perfectly well-formed.
        {
            name: 'a NaN avg_time_to_merge_hours',
            row: input({avg_time_to_merge_hours: Number.NaN}),
            observedAt: OBSERVED,
            code: 'invalid_metric',
        },
        {
            name: 'a negative counter',
            row: input({commits: -1}),
            observedAt: OBSERVED,
            code: 'invalid_metric',
        },
        {
            name: 'a non-finite rate',
            row: input({code_churn_rate: Number.POSITIVE_INFINITY}),
            observedAt: OBSERVED,
            code: 'invalid_metric',
        },
    ];

    it('returns null for a row the throwing form accepts', () => {
        const db = new Database(':memory:');
        try {
            runMigrations(db, MIGRATIONS_DIR);
            expect(findRawAuthorDailyDefect(input(), OBSERVED)).toBeNull();
            expect(() => upsertRawAuthorDaily(db, input(), OBSERVED)).not.toThrow();
        } finally {
            db.close();
        }
    });

    for (const refusal of REFUSALS) {
        it(`reports ${refusal.name} with the SAME code the throwing form raises`, () => {
            const db = new Database(':memory:');
            try {
                runMigrations(db, MIGRATIONS_DIR);
                const defect = findRawAuthorDailyDefect(refusal.row, refusal.observedAt);
                expect(defect?.code).toBe(refusal.code);

                let thrownCode: string | undefined;
                try {
                    upsertRawAuthorDaily(db, refusal.row, refusal.observedAt);
                } catch (e) {
                    expect(e).toBeInstanceOf(RawAuthorDailyError);
                    thrownCode = (e as RawAuthorDailyError).code;
                }
                // Agreement in BOTH directions: the same code, and the throw really happened —
                // a form that silently accepted this row would leave `thrownCode` undefined.
                expect(thrownCode).toBe(defect?.code);
            } finally {
                db.close();
            }
        });
    }

    it('reports only codes on the runtime allowlist, which is what the advisory renders', () => {
        // `sync.ts` interpolates the code into an operator-facing line and allowlists it against
        // this array first. A code the validator can produce but the array omits would render as
        // `<unrecognized refusal code>` and tell the operator nothing.
        for (const refusal of REFUSALS) {
            const defect = findRawAuthorDailyDefect(refusal.row, refusal.observedAt);
            expect(RAW_AUTHOR_DAILY_ERROR_CODES).toContain(defect!.code);
        }
    });

    it('embeds the offending VALUE in the message, which is why the advisory renders the code', () => {
        // Pinned so the caller warning on `findRawAuthorDailyDefect` stays true: if the message
        // ever stopped carrying the raw value, `sanitizeRefusalCode` would be protecting nothing
        // and the line could safely say more. It does carry it, so it must not be pasted through.
        const defect = findRawAuthorDailyDefect(input({date: '+033658-0'}), OBSERVED);
        expect(defect!.message).toContain('+033658-0');
    });
});
