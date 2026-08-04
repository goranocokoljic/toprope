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
    RAW_AUTHOR_DAILY_ERROR_CODES,
    ROW_LEVEL_REFUSALS,
    type DailyGitMetrics,
    type RawAuthorDailyInput,
} from '../../src/connectors/git/raw-author-daily';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

/**
 * The refusal code {@link upsertRawAuthorDaily} throws for `row`, or `null` if it accepts it —
 * the throwing form is the ONLY validator since #307 (the non-throwing `findRawAuthorDailyDefect`
 * twin was deleted). Runs against a fresh migrated DB so the write path is the real one.
 */
function refusalCodeOf(row: RawAuthorDailyInput, observedAt: string): string | null {
    const db = new Database(':memory:');
    try {
        runMigrations(db, MIGRATIONS_DIR);
        upsertRawAuthorDaily(db, row, observedAt);
        return null;
    } catch (e) {
        if (e instanceof RawAuthorDailyError) return e.code;
        throw e;
    } finally {
        db.close();
    }
}

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
        // The code is per FIELD, not per rule (#306): a metric whose operands come out of a
        // provider response body uncast is `invalid_metric` (row-level, skippable), and one this
        // codebase computes is `invalid_computed_metric` (throwing) — see
        // RESPONSE_DERIVED_METRIC_FIELDS. The pairs below straddle both rules in both directions,
        // so a classification that collapsed back to one code per rule would fail here.
        expect(codeOf(() => upsertRawAuthorDaily(db, input({commits: -1}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_computed_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({prs_merged: 1.5}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_computed_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({lines_added: -1}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        // NaN binds as NULL into a NOT NULL column — the raw error would name the wrong problem.
        expect(codeOf(() => upsertRawAuthorDaily(db, input({commits: NaN}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_computed_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({lines_removed: NaN}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({code_churn_rate: NaN}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({avg_commit_size: Infinity}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({ai_signature_score: Infinity}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_computed_metric');
        expect(codeOf(() => upsertRawAuthorDaily(db, input({avg_time_to_merge_hours: NaN}), '2026-07-01T10:00:00.000Z'))).toBe('invalid_computed_metric');
        expect(db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get()).toEqual({n: 0});
    });

    it('classifies EVERY metric field, so a new one cannot default into the skippable class', () => {
        // The gap this closes is directional and asymmetric: an unclassified field falls to
        // `invalid_computed_metric`, i.e. to the THROWING side, which is the safe default — but
        // a field wrongly left on the row-level side is skipped, its window recorded as covered,
        // and nothing re-asks it. So every field is named here individually rather than checked
        // by set-difference, and both classes are asserted non-empty.
        const responseDerived = ['lines_added', 'lines_removed', 'code_churn_rate', 'avg_commit_size'] as const;
        const computed = [
            'commits', 'files_changed', 'prs_opened', 'prs_merged', 'review_comments_given',
            'commit_burst_count', 'ai_signature_score', 'avg_time_to_merge_hours',
        ] as const;
        // Every field of the metrics shape is in exactly one of the two lists — a new metric
        // added to DailyGitMetrics and to neither list fails this.
        expect([...responseDerived, ...computed].sort()).toEqual(Object.keys(ZERO_METRICS).sort());

        const badValue = (field: string): Partial<DailyGitMetrics> =>
            ({[field]: Number.NaN}) as Partial<DailyGitMetrics>;
        for (const field of responseDerived) {
            expect(refusalCodeOf(input(badValue(field)), '2026-07-01T10:00:00.000Z')).toBe('invalid_metric');
        }
        for (const field of computed) {
            expect(refusalCodeOf(input(badValue(field)), '2026-07-01T10:00:00.000Z')).toBe('invalid_computed_metric');
        }
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
 * #302/#307 — the write boundary's refusal, now the ONE validator (the non-throwing
 * `findRawAuthorDailyDefect` twin was deleted in #307).
 *
 * `upsertRawAuthorDaily` throws INSIDE the git sync's single all-providers write transaction, so a
 * row it refuses does not cost a row: it rolls back every provider's window and recurs identically
 * on every run. The sync therefore CATCHES this throw and skips a row-level refusal. This table
 * pins the code the store raises for each refusal class, and that the offending value reaches the
 * message (which is why the advisory renders the typed CODE, never the message).
 */
describe('upsertRawAuthorDaily — the write-boundary refusal (#302/#307)', () => {
    const OBSERVED = '2026-07-01T10:00:00.000Z';

    /** Every refusal class the validator can reach, with the code it must raise. */
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
        // day may be perfectly well-formed. `invalid_computed_metric` since #306: the analyzer's
        // `prMergeDurationHours` is total and yields `null` rather than NaN, so a NaN reaching
        // here is a code regression — which a patch repairs, after which re-fetching works.
        {
            name: 'a NaN avg_time_to_merge_hours',
            row: input({avg_time_to_merge_hours: Number.NaN}),
            observedAt: OBSERVED,
            code: 'invalid_computed_metric',
        },
        {
            name: 'a negative computed counter',
            row: input({commits: -1}),
            observedAt: OBSERVED,
            code: 'invalid_computed_metric',
        },
        {
            name: 'a negative response-derived counter',
            row: input({lines_added: -1}),
            observedAt: OBSERVED,
            code: 'invalid_metric',
        },
        {
            name: 'a non-finite response-derived rate',
            row: input({code_churn_rate: Number.POSITIVE_INFINITY}),
            observedAt: OBSERVED,
            code: 'invalid_metric',
        },
        {
            name: 'a non-finite computed score',
            row: input({ai_signature_score: Number.POSITIVE_INFINITY}),
            observedAt: OBSERVED,
            code: 'invalid_computed_metric',
        },
    ];

    it('accepts a well-formed row', () => {
        expect(refusalCodeOf(input(), OBSERVED)).toBeNull();
    });

    for (const refusal of REFUSALS) {
        it(`raises ${refusal.name} as ${refusal.code}, and really does throw`, () => {
            const db = new Database(':memory:');
            try {
                runMigrations(db, MIGRATIONS_DIR);
                let thrownCode: string | undefined;
                try {
                    upsertRawAuthorDaily(db, refusal.row, refusal.observedAt);
                } catch (e) {
                    expect(e).toBeInstanceOf(RawAuthorDailyError);
                    thrownCode = (e as RawAuthorDailyError).code;
                }
                // The throw really happened — a form that silently accepted this row would leave
                // `thrownCode` undefined — and it carried the expected code.
                expect(thrownCode).toBe(refusal.code);
            } finally {
                db.close();
            }
        });
    }

    it('raises only codes on the runtime allowlist, which is what the advisory renders', () => {
        // `sync.ts` interpolates the code into an operator-facing line, and it is safe to do so
        // only because the code is a closed vocabulary. A code the validator can produce but the
        // array omits would break that guarantee.
        for (const refusal of REFUSALS) {
            expect(RAW_AUTHOR_DAILY_ERROR_CODES).toContain(refusalCodeOf(refusal.row, refusal.observedAt));
        }
    });

    it('embeds the offending VALUE in the message, which is why the advisory renders the code', () => {
        // Pinned so the advisory keeps rendering the typed CODE, never `.message`: the message
        // carries the raw response-derived value verbatim, so pasting it into a line bound for a
        // terminal / `sync_logs` / the admin UI would be a control-character hazard.
        let message: string | undefined;
        try {
            const db = new Database(':memory:');
            try {
                runMigrations(db, MIGRATIONS_DIR);
                upsertRawAuthorDaily(db, input({date: '+033658-0'}), OBSERVED);
            } finally {
                db.close();
            }
        } catch (e) {
            message = (e as RawAuthorDailyError).message;
        }
        expect(message).toContain('+033658-0');
    });
});

/**
 * #302 — which refusals the git sync may SKIP, and which must still roll the run back.
 *
 * The sync CATCHES the store's own throw at the write (#307) and skips a row-level refusal
 * rather than letting it roll the run's single all-providers write transaction back. That is
 * only safe for a refusal decided by a value THIS ROW carries: a defect in a run- or
 * provider-level operand refuses every row, so skipping it would discard the entire window
 * fail-open with the cursor advanced and the run reported clean — the exact inversion of the
 * fail-closed behaviour `providers/config.ts` relies on. So the catch filters on
 * `ROW_LEVEL_REFUSALS` and rethrows everything else.
 *
 * Asserted here rather than end to end because that is where the distinction is decidable. The
 * complement direction IS driven through a real two-provider run
 * (`tests/connectors/git/unwritable-author-days.test.ts`, the corrupted-clock case, which pins
 * that a run-level `invalid_instant` rolls back and holds BOTH cursors) and `invalid_date` is
 * driven end to end several times over.
 *
 * #306 NARROWED `invalid_metric` to the fields whose value comes out of a provider response body
 * uncast (`lines_added`, `lines_removed`, and the two rates computed from them — Bitbucket's
 * `getCommitDiff` maps `e.lines_added` straight through, and `resolveCommitDiffstat` reduces over
 * it). Only for those is "re-fetching returns the identical unusable value" true. Every other
 * metric field is computed here, so its only realistic trigger is a code regression that a patch
 * repairs — after which re-fetching DOES yield a writable row, which is exactly what the cursor
 * hold preserves. Those became `invalid_computed_metric` and moved to the throwing side.
 */
describe('ROW_LEVEL_REFUSALS — what the sync may skip (#302/#306)', () => {
    /**
     * The complement of ROW_LEVEL_REFUSALS, named individually and shared by the two assertions
     * below, so ADDING a code to RAW_AUTHOR_DAILY_ERROR_CODES cannot quietly satisfy either.
     *
     * Not all four are "run-level" any more (#306): `invalid_computed_metric` IS decided by one
     * row's own value. What every member shares is the property that actually licenses the throw
     * — the refusal describes something a fix can change, so holding the cursor preserves a
     * window that re-covers intact instead of skipping past it forever.
     */
    const throwing = [
        'invalid_instant',
        'invalid_provider',
        'invalid_container',
        'invalid_key',
        'invalid_computed_metric',
    ];

    it('holds exactly the refusals a single row can be solely responsible for', () => {
        expect([...ROW_LEVEL_REFUSALS].sort()).toEqual([
            'future_date',
            'invalid_date',
            'invalid_identity',
            'invalid_metric',
        ]);
    });

    it('excludes every refusal a later fix can make writable', () => {
        for (const code of throwing) {
            expect(ROW_LEVEL_REFUSALS).not.toContain(code);
        }
    });

    it('classifies every code the validator can produce, one way or the other', () => {
        // The gap this closes: a NEW refusal code lands in neither list, is therefore not
        // row-level, and silently becomes fail-closed — which may be right, but must be a
        // decision rather than an omission. This fails until someone makes it.
        for (const code of RAW_AUTHOR_DAILY_ERROR_CODES) {
            expect(ROW_LEVEL_REFUSALS.includes(code) || throwing.includes(code)).toBe(true);
        }
    });

    it('checks the run-level operand FIRST, so the split cannot depend on the row mix', () => {
        // The validator raises the FIRST defect. With `observedAt` checked after the date, a run
        // whose clock is corrupt AND whose every row also carries a bad date would raise
        // `invalid_date` for all of them — so every row would be skipped, nothing would reach the
        // run-level throw, and the fault the split exists to make loud would advance the cursor
        // and report `ok`.
        const bothWrong = refusalCodeOf(input({date: 'not-a-day'}), 'not-an-instant');
        expect(bothWrong).toBe('invalid_instant');
        expect(ROW_LEVEL_REFUSALS).not.toContain(bothWrong!);
    });
});

/**
 * #309 — a FUTURE developer-day is refused here, for every provider at once.
 *
 * `git commit --date="2099-01-01"` leaves the AUTHOR date years ahead while the committer date
 * stays at now, and GitHub/GitLab window on the COMMITTER date server-side — so the row comes back
 * from the very window the run asked for, and the day key this pipeline derives is the author's.
 * `isUtcDay` is a bare shape test with no upper bound, so before this check the row was written as
 * a `2099-01-01` developer-day and projected into `git_snapshots`, where append-only means it
 * could never be corrected (the #106 hazard: one future-dated cell made `buildTrajectory` emit
 * thousands of zero-weeks).
 *
 * The end-to-end half — that a real GitHub and a real GitLab run refuse it and report the skip —
 * is in `tests/connectors/git/future-author-dates.test.ts`.
 */
describe('the write boundary bounds the day against the run clock (#309)', () => {
    const OBSERVED = '2026-07-01T12:00:00.000Z';

    it('refuses a day years ahead of the run as future_date', () => {
        expect(refusalCodeOf(input({date: '2099-01-01'}), OBSERVED)).toBe('future_date');
    });

    it('accepts the run’s own UTC day', () => {
        expect(refusalCodeOf(input({date: '2026-07-01'}), OBSERVED)).toBeNull();
    });

    it('accepts the day AFTER the run’s, which UTC+14 legitimately produces', () => {
        // The input class only the horizon handles, and the reason it is one day rather than zero.
        // `isAttributableDate` admits an offset-bearing timestamp because the store does, and
        // GitLab's `authored_date` really is offset-bearing — so a commit made at this instant in
        // the easternmost zone slices to TOMORROW's UTC day. A zero-day bound would refuse honest
        // commits from half the planet every evening.
        expect(refusalCodeOf(input({date: '2026-07-02'}), OBSERVED)).toBeNull();
    });

    it('refuses TWO days ahead, which no timezone offset can explain', () => {
        // The other side of the same boundary: the horizon is derived from the maximum UTC offset
        // (+14:00, rounded up to a day), not a loose grace period. Without this case the horizon
        // could be widened to a week and the test above would stay green.
        expect(refusalCodeOf(input({date: '2026-07-03'}), OBSERVED)).toBe('future_date');
    });

    it('checks the day SHAPE first, so an off-shape value is still invalid_date', () => {
        // Ordering matters, and this is the input class only that ordering handles: `>` on two
        // strings is sound ONLY once both are shape-pinned, because a non-conforming value
        // byte-sorts arbitrarily. `'not-a-day'` sorts BELOW every real day, so with the two checks
        // swapped it would slip past the horizon comparison and be reported as a clock problem —
        // or, worse, be accepted by it and left to the schema CHECK.
        expect(refusalCodeOf(input({date: 'not-a-day'}), OBSERVED)).toBe('invalid_date');
    });

    it('reports a calendar-impossible day past the horizon as future_date, not invalid_date', () => {
        // Deliberate, and worth pinning so it is not read as a bug. `isUtcDay` is a SHAPE check by
        // design — the store accepts `2024-02-30` because rejecting it would drop commits the
        // provider gates deliberately let through (see `commit-date.ts`) — so `'9999-99-99'` is a
        // well-shaped day as far as this boundary is concerned, and it is genuinely after the
        // horizon under the same byte comparison every consumer of the column uses. Both codes are
        // row-level refusals, so the row is skipped identically either way; only the operator's
        // first guess changes. An in-window impossible day is unaffected and still writes.
        expect(refusalCodeOf(input({date: '9999-99-99'}), OBSERVED)).toBe('future_date');
        expect(refusalCodeOf(input({date: '2026-02-30'}), OBSERVED)).toBeNull();
    });

    it('checks the run-level observedAt BEFORE the row’s day', () => {
        // Same argument as the `invalid_date` ordering case above: a corrupt clock makes EVERY row
        // look future-dated, and if that were reported per row the sync would skip the whole
        // window (row-level) and advance the cursor, instead of rolling back on the run-level
        // `invalid_instant` the fault actually is.
        expect(refusalCodeOf(input({date: '2099-01-01'}), 'not-an-instant')).toBe('invalid_instant');
    });
});

/**
 * #302 review cycle 2 (SEC-1) — the identity columns are part of the row the validator covers.
 *
 * `upsertRawAuthorDaily` DEREFERENCES all three inside the shared write transaction (`bestKnown`
 * and `normalizeEmail` both do `(x ?? '').trim()`), so a non-string, non-null value is a
 * `TypeError` thrown from inside it — the same permanent stall as an unusable date, reached by a
 * different field of the same body. `analysis-types.ts` builds `authorName` with `||`, which
 * only filters falsy, so `{}` / `[]` / `42` survive from a cast response body.
 */
describe('the write boundary covers the identity columns (#302)', () => {
    const OBSERVED = '2026-07-01T10:00:00.000Z';
    const FIELDS = ['author_login', 'author_email', 'author_display_name'] as const;

    for (const field of FIELDS) {
        it(`refuses a non-string ${field} as invalid_identity, which the upsert would have .trim()ed`, () => {
            // The input class only this guard handles: without it the throw is a raw TypeError
            // from inside the transaction rather than a typed row-level refusal.
            expect(refusalCodeOf(input({[field]: {} as never}), OBSERVED)).toBe('invalid_identity');
        });

        it(`still accepts a null ${field}, which is the normal shape for a PR-only author`, () => {
            expect(refusalCodeOf(input({[field]: null}), OBSERVED)).toBeNull();
        });
    }

    it('is ROW-level, so one odd display name costs its author-day and not the run', () => {
        // Its own code rather than `invalid_key`, and that is the whole point: `invalid_key` is
        // decided partly by `provider` (the namespacing rule), so it refuses every row of a
        // provider at once and is fail-closed. Folding the identity check into it would have made
        // a single odd display name roll back every provider's window.
        expect(refusalCodeOf(input({author_display_name: 42 as never}), OBSERVED)).toBe('invalid_identity');
        expect(ROW_LEVEL_REFUSALS).toContain('invalid_identity');
        expect(ROW_LEVEL_REFUSALS).not.toContain('invalid_key');
    });
});
