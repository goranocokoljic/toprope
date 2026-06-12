import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {computePRReviewMetricsForPeriod} from '../../../src/coaching/pr-review/compute';
import {setPRReviewThresholds} from '../../../src/coaching/pr-review/config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedDev(db: Database.Database, name: string): string {
    try {
        addTeam(db, 'eng');
    } catch {
        // team may already exist
    }
    return addDeveloper(db, name, 'eng', `${name}@example.com`, name).id;
}

interface PRSeed {
    developerId: string;
    provider?: string;
    repo?: string;
    prId: string;
    state?: string;
    createdAt: string;
    mergedAt?: string | null;
    closedAt?: string | null;
    comments?: number;
    rounds?: number;
    changesRequested?: number;
    ttmHours?: number | null;
}

function seedPR(db: Database.Database, seed: PRSeed): void {
    db.prepare(
        `INSERT INTO pr_records
         (id, developer_id, provider, repo, pr_id, state, created_at, merged_at, closed_at,
          review_comment_count, review_rounds, changes_requested_count, time_to_merge_hours, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        randomUUID(),
        seed.developerId,
        seed.provider ?? 'github',
        seed.repo ?? 'repo-a',
        seed.prId,
        seed.state ?? 'merged',
        seed.createdAt,
        seed.mergedAt ?? null,
        seed.closedAt ?? seed.mergedAt ?? null,
        seed.comments ?? 0,
        seed.rounds ?? 1,
        seed.changesRequested ?? 0,
        seed.ttmHours ?? null,
        '2026-06-01T00:00:00.000Z',
    );
}

interface SnapshotSeed {
    developerId: string;
    date: string;
    commits?: number;
    churn?: number | null;
    aiScore?: number | null;
    commentsGiven?: number;
}

function seedSnapshot(db: Database.Database, seed: SnapshotSeed): void {
    db.prepare(
        `INSERT INTO git_snapshots
         (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
          prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
          code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count)
         VALUES (?, ?, ?, ?, 100, 20, 3, 1, 1, ?, NULL, ?, ?, 40, 0)`,
    ).run(
        randomUUID(),
        seed.developerId,
        seed.date,
        seed.commits ?? 3,
        seed.commentsGiven ?? 0,
        seed.churn ?? null,
        seed.aiScore ?? null,
    );
}

interface MetricsRow {
    developer_id: string;
    period: string;
    scope_variant: string;
    prs_total: number;
    prs_merged: number;
    rework_rate: number | null;
    avg_review_rounds: number | null;
    review_rejection_rate: number | null;
    avg_comment_density: number | null;
    comment_density_vs_baseline: number | null;
    avg_time_to_merge_hours: number | null;
    review_comments_given: number | null;
    avg_churn: number | null;
    combined_signal: string;
    basis: string;
    computed_at: string;
}

function getRow(db: Database.Database, devId: string, period: string, variant: string): MetricsRow {
    const row = db
        .prepare(
            'SELECT * FROM pr_review_metrics WHERE developer_id = ? AND period = ? AND scope_variant = ?',
        )
        .get(devId, period, variant) as MetricsRow | undefined;
    expect(row, `metrics row for ${devId}/${period}/${variant}`).toBeDefined();
    return row!;
}

function countRows(db: Database.Database): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM pr_review_metrics').get() as {n: number}).n;
}

describe('computePRReviewMetricsForPeriod', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('computes all_pr metrics from per-PR records (factual basis)', () => {
        const dev = seedDev(db, 'alice');
        seedPR(db, {developerId: dev, prId: '1', createdAt: '2026-05-04T08:00:00Z', mergedAt: '2026-05-05T08:00:00Z', state: 'merged', comments: 4, rounds: 2, changesRequested: 1, ttmHours: 24});
        seedPR(db, {developerId: dev, prId: '2', createdAt: '2026-05-11T08:00:00Z', mergedAt: '2026-05-11T20:00:00Z', state: 'merged', comments: 0, rounds: 1, changesRequested: 0, ttmHours: 12});
        seedPR(db, {developerId: dev, prId: '3', createdAt: '2026-05-18T08:00:00Z', state: 'open', comments: 2, rounds: 1, changesRequested: 0});
        seedPR(db, {developerId: dev, prId: '4', createdAt: '2026-05-20T08:00:00Z', state: 'closed', closedAt: '2026-05-21T08:00:00Z', comments: 6, rounds: 3, changesRequested: 2});

        const result = computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        expect(result.developers).toBe(1);
        expect(result.rowsWritten).toBe(2);

        const row = getRow(db, dev, '2026-05', 'all_pr');
        expect(row.basis).toBe('factual');
        expect(row.prs_total).toBe(4);
        expect(row.prs_merged).toBe(2);
        expect(row.rework_rate).toBe(0.5); // PRs 1 and 4 sent back
        expect(row.review_rejection_rate).toBe(0.5);
        expect(row.avg_review_rounds).toBe(1.75); // (2+1+1+3)/4
        expect(row.avg_comment_density).toBe(3); // (4+0+2+6)/4
        expect(row.avg_time_to_merge_hours).toBe(18); // (24+12)/2
        expect(row.combined_signal).toBe('effective'); // no churn data, no high churn
    });

    it('computes ai_assisted_pr from high-AI-signature PRs only (inferred basis), stored separately', () => {
        const dev = seedDev(db, 'alice');
        // PR window 05-04..05-05 — high AI signature days
        seedPR(db, {developerId: dev, prId: 'ai-1', createdAt: '2026-05-04T08:00:00Z', mergedAt: '2026-05-05T08:00:00Z', state: 'merged', comments: 6, rounds: 2, changesRequested: 1, ttmHours: 24});
        seedSnapshot(db, {developerId: dev, date: '2026-05-04', aiScore: 0.9});
        seedSnapshot(db, {developerId: dev, date: '2026-05-05', aiScore: 0.9});
        // PR window 05-11 — low AI signature day
        seedPR(db, {developerId: dev, prId: 'manual-1', createdAt: '2026-05-11T08:00:00Z', mergedAt: '2026-05-11T20:00:00Z', state: 'merged', comments: 0, rounds: 1, changesRequested: 0, ttmHours: 12});
        seedSnapshot(db, {developerId: dev, date: '2026-05-11', aiScore: 0.1});
        // PR with no git activity in its window — no AI estimate, excluded from the AI variant
        seedPR(db, {developerId: dev, prId: 'unknown-1', createdAt: '2026-05-25T08:00:00Z', state: 'open', comments: 1, rounds: 1});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        const all = getRow(db, dev, '2026-05', 'all_pr');
        const ai = getRow(db, dev, '2026-05', 'ai_assisted_pr');

        expect(all.prs_total).toBe(3);
        expect(ai.prs_total).toBe(1); // only ai-1
        expect(ai.basis).toBe('inferred');
        expect(ai.rework_rate).toBe(1); // the one AI PR was sent back
        expect(ai.avg_comment_density).toBe(6);
        expect(ai.avg_time_to_merge_hours).toBe(24);
        // The two variants are separate rows and not merged
        expect(countRows(db)).toBe(2);
        expect(all.basis).toBe('factual');
    });

    it("comment_density_vs_baseline uses the developer's OWN trailing baseline", () => {
        const noisy = seedDev(db, 'noisy');
        const quiet = seedDev(db, 'quiet');

        // Prior period (2026-04): noisy averages 4 comments/PR, quiet averages 1.
        seedPR(db, {developerId: noisy, prId: 'n-prior', createdAt: '2026-04-10T08:00:00Z', mergedAt: '2026-04-11T08:00:00Z', comments: 4, ttmHours: 24});
        seedPR(db, {developerId: quiet, prId: 'q-prior', createdAt: '2026-04-10T08:00:00Z', mergedAt: '2026-04-11T08:00:00Z', comments: 1, ttmHours: 24});

        // Current period (2026-05): both get 4 comments/PR.
        seedPR(db, {developerId: noisy, prId: 'n-now', createdAt: '2026-05-10T08:00:00Z', mergedAt: '2026-05-11T08:00:00Z', comments: 4, ttmHours: 24});
        seedPR(db, {developerId: quiet, prId: 'q-now', createdAt: '2026-05-10T08:00:00Z', mergedAt: '2026-05-11T08:00:00Z', comments: 4, ttmHours: 24});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        // Same observed density, different ratios — the baseline is within-developer.
        expect(getRow(db, noisy, '2026-05', 'all_pr').comment_density_vs_baseline).toBe(1);
        expect(getRow(db, quiet, '2026-05', 'all_pr').comment_density_vs_baseline).toBe(4);
    });

    it('has no baseline ratio in the first-ever period (null, not a guess)', () => {
        const dev = seedDev(db, 'alice');
        seedPR(db, {developerId: dev, prId: '1', createdAt: '2026-05-10T08:00:00Z', mergedAt: '2026-05-11T08:00:00Z', comments: 4, ttmHours: 24});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        expect(getRow(db, dev, '2026-05', 'all_pr').comment_density_vs_baseline).toBeNull();
    });

    it('returns insufficient_data below the minimum PR count (no false coaching on thin data)', () => {
        const dev = seedDev(db, 'alice');
        seedPR(db, {developerId: dev, prId: '1', createdAt: '2026-05-04T08:00:00Z', mergedAt: '2026-05-05T08:00:00Z', changesRequested: 1, ttmHours: 24});
        seedPR(db, {developerId: dev, prId: '2', createdAt: '2026-05-11T08:00:00Z', mergedAt: '2026-05-12T08:00:00Z', changesRequested: 1, ttmHours: 24});
        // High churn + high rejection — but only 2 PRs (< default minPrs 3)
        seedSnapshot(db, {developerId: dev, date: '2026-05-04', churn: 0.5});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        expect(getRow(db, dev, '2026-05', 'all_pr').combined_signal).toBe('insufficient_data');
    });

    it('disambiguates via churn + review: struggling / healthy_iteration / effective', () => {
        const struggling = seedDev(db, 'struggling');
        const iterating = seedDev(db, 'iterating');
        const effective = seedDev(db, 'effective');

        for (let i = 1; i <= 3; i++) {
            const created = `2026-05-0${i + 3}T08:00:00Z`;
            const merged = `2026-05-0${i + 4}T08:00:00Z`;
            // struggling: every PR sent back; high churn
            seedPR(db, {developerId: struggling, prId: `s-${i}`, createdAt: created, mergedAt: merged, changesRequested: 1, rounds: 2, ttmHours: 24});
            // iterating: clean reviews; high churn
            seedPR(db, {developerId: iterating, prId: `i-${i}`, createdAt: created, mergedAt: merged, changesRequested: 0, rounds: 1, ttmHours: 24});
            // effective: clean reviews; low churn
            seedPR(db, {developerId: effective, prId: `e-${i}`, createdAt: created, mergedAt: merged, changesRequested: 0, rounds: 1, ttmHours: 24});
        }
        seedSnapshot(db, {developerId: struggling, date: '2026-05-05', churn: 0.4});
        seedSnapshot(db, {developerId: iterating, date: '2026-05-05', churn: 0.4});
        seedSnapshot(db, {developerId: effective, date: '2026-05-05', churn: 0.05});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        expect(getRow(db, struggling, '2026-05', 'all_pr').combined_signal).toBe('struggling');
        expect(getRow(db, iterating, '2026-05', 'all_pr').combined_signal).toBe('healthy_iteration');
        expect(getRow(db, effective, '2026-05', 'all_pr').combined_signal).toBe('effective');
    });

    it('stores avg_churn and review_comments_given from git_snapshots', () => {
        const dev = seedDev(db, 'alice');
        for (let i = 1; i <= 3; i++) {
            seedPR(db, {developerId: dev, prId: `${i}`, createdAt: `2026-05-0${i}T08:00:00Z`, mergedAt: `2026-05-0${i}T20:00:00Z`, ttmHours: 12});
        }
        seedSnapshot(db, {developerId: dev, date: '2026-05-01', churn: 0.1, commentsGiven: 3});
        seedSnapshot(db, {developerId: dev, date: '2026-05-02', churn: 0.3, commentsGiven: 2});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        const row = getRow(db, dev, '2026-05', 'all_pr');
        expect(row.avg_churn).toBeCloseTo(0.2, 6);
        expect(row.review_comments_given).toBe(5);
    });

    it('writes no rows for developers with no PRs in the period', () => {
        const active = seedDev(db, 'active');
        seedDev(db, 'idle');
        for (let i = 1; i <= 3; i++) {
            seedPR(db, {developerId: active, prId: `${i}`, createdAt: `2026-05-0${i}T08:00:00Z`, mergedAt: `2026-05-0${i}T20:00:00Z`, ttmHours: 12});
        }

        const result = computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        expect(result.developers).toBe(1);
        expect(countRows(db)).toBe(2); // both variants, one developer
    });

    it('is idempotent — recompute overwrites in place and reflects updated records', () => {
        const dev = seedDev(db, 'alice');
        for (let i = 1; i <= 3; i++) {
            seedPR(db, {developerId: dev, prId: `${i}`, createdAt: `2026-05-0${i}T08:00:00Z`, state: 'open'});
        }

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');
        expect(countRows(db)).toBe(2);
        expect(getRow(db, dev, '2026-05', 'all_pr').prs_merged).toBe(0);

        // PR 1 merges on a later sync; the recompute picks up the new verdict.
        db.prepare(
            "UPDATE pr_records SET state = 'merged', merged_at = '2026-05-02T08:00:00Z', time_to_merge_hours = 24 WHERE pr_id = '1'",
        ).run();

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');
        expect(countRows(db)).toBe(2); // no duplicates
        const row = getRow(db, dev, '2026-05', 'all_pr');
        expect(row.prs_merged).toBe(1);
        expect(row.avg_time_to_merge_hours).toBe(24);
    });

    it('retracts rows for a developer whose PRs were re-attributed out of the period', () => {
        const wrongDev = seedDev(db, 'wrong');
        const rightDev = seedDev(db, 'right');
        for (let i = 1; i <= 3; i++) {
            seedPR(db, {developerId: wrongDev, prId: `${i}`, createdAt: `2026-05-0${i}T08:00:00Z`, mergedAt: `2026-05-0${i}T20:00:00Z`, ttmHours: 12});
        }

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');
        expect(getRow(db, wrongDev, '2026-05', 'all_pr').prs_total).toBe(3);

        // Registry correction: the PRs were really rightDev's. The sync
        // re-attributes pr_records; the recompute must not leave wrongDev's
        // rows behind with numbers derived from PRs no longer theirs.
        db.prepare('UPDATE pr_records SET developer_id = ?').run(rightDev);
        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        expect(getRow(db, rightDev, '2026-05', 'all_pr').prs_total).toBe(3);
        const stale = db
            .prepare('SELECT COUNT(*) AS n FROM pr_review_metrics WHERE developer_id = ?')
            .get(wrongDev) as {n: number};
        expect(stale.n).toBe(0);
    });

    it("extends an open PR's AI window to today, not just its creation day", () => {
        const dev = seedDev(db, 'alice');
        // Open PR created 05-04; the developer's scored activity lands later
        // in the window. With a creation-day-only window the estimate would be
        // null; created→today covers it.
        seedPR(db, {developerId: dev, prId: 'open-1', createdAt: '2026-05-04T08:00:00Z', state: 'open'});
        seedSnapshot(db, {developerId: dev, date: '2026-05-08', aiScore: 0.9});
        setPRReviewThresholds(db, {minPrs: 1});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05', new Date('2026-05-20T04:00:00Z'));

        expect(getRow(db, dev, '2026-05', 'ai_assisted_pr').prs_total).toBe(1);
    });

    it('supports weekly periods keyed by ISO week label (YYYY-Www)', () => {
        const dev = seedDev(db, 'alice');
        // 2026-W19 spans 2026-05-04 (Mon) .. 2026-05-10 (Sun)
        seedPR(db, {developerId: dev, prId: 'in', createdAt: '2026-05-04T08:00:00Z', mergedAt: '2026-05-05T08:00:00Z', ttmHours: 24});
        seedPR(db, {developerId: dev, prId: 'out', createdAt: '2026-05-11T08:00:00Z', mergedAt: '2026-05-12T08:00:00Z', ttmHours: 24});

        computePRReviewMetricsForPeriod(db, 'weekly', '2026-W19');

        const row = getRow(db, dev, '2026-W19', 'all_pr');
        expect(row.prs_total).toBe(1);
    });

    it('rejects a malformed period key loudly', () => {
        expect(() => computePRReviewMetricsForPeriod(db, 'monthly', '2026-13')).toThrow();
        expect(() => computePRReviewMetricsForPeriod(db, 'weekly', '2026-W99')).toThrow();
    });

    it('honors configured thresholds (min_prs, churn_high, ai_signature)', () => {
        setPRReviewThresholds(db, {minPrs: 1, churnHighThreshold: 0.5, aiSignatureThreshold: 0.95});
        const dev = seedDev(db, 'alice');
        seedPR(db, {developerId: dev, prId: '1', createdAt: '2026-05-04T08:00:00Z', mergedAt: '2026-05-05T08:00:00Z', changesRequested: 0, ttmHours: 24});
        seedSnapshot(db, {developerId: dev, date: '2026-05-04', churn: 0.4, aiScore: 0.9});

        computePRReviewMetricsForPeriod(db, 'monthly', '2026-05');

        const all = getRow(db, dev, '2026-05', 'all_pr');
        // minPrs lowered to 1 → a signal is computed; churn 0.4 < raised 0.5 → not high
        expect(all.combined_signal).toBe('effective');
        // AI threshold raised to 0.95 → the 0.9-scored PR is NOT ai-assisted
        const ai = getRow(db, dev, '2026-05', 'ai_assisted_pr');
        expect(ai.prs_total).toBe(0);
        expect(ai.combined_signal).toBe('insufficient_data');
    });
});
