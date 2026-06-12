import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    getDeveloperPRReviewCoaching,
    getOrgPRReviewCoaching,
    getTeamPRReviewCoaching,
    periodKeysEndingAt,
} from '../../../src/coaching/pr-review/coaching';
import type {CombinedSignal, ScopeVariant} from '../../../src/coaching/pr-review/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const NOW = new Date('2026-06-15T00:00:00.000Z');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function dev(db: Database.Database, team: string, name: string): string {
    try {
        addTeam(db, team);
    } catch {
        /* exists */
    }
    return addDeveloper(db, name, team, `${name}@example.com`, name).id;
}

interface MetricSeed {
    developerId: string;
    period: string;
    variant: ScopeVariant;
    prsTotal: number;
    prsMerged?: number;
    rework?: number | null;
    rejection?: number | null;
    rounds?: number | null;
    density?: number | null;
    ttm?: number | null;
    churn?: number | null;
    signal?: CombinedSignal;
}

function seedMetric(db: Database.Database, s: MetricSeed): void {
    db.prepare(
        `INSERT INTO pr_review_metrics
         (id, developer_id, period, scope_variant, prs_total, prs_merged, rework_rate,
          avg_review_rounds, review_rejection_rate, avg_comment_density,
          comment_density_vs_baseline, avg_time_to_merge_hours, review_comments_given,
          avg_churn, combined_signal, basis, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        randomUUID(),
        s.developerId,
        s.period,
        s.variant,
        s.prsTotal,
        s.prsMerged ?? s.prsTotal,
        s.rework ?? null,
        s.rounds ?? null,
        s.rejection ?? s.rework ?? null,
        s.density ?? null,
        null,
        s.ttm ?? null,
        0,
        s.churn ?? null,
        s.signal ?? 'effective',
        s.variant === 'all_pr' ? 'factual' : 'inferred',
        NOW.toISOString(),
    );
}

describe('periodKeysEndingAt', () => {
    it('enumerates the monthly window oldest-first', () => {
        expect(periodKeysEndingAt('monthly', '2026-06-15', 6)).toEqual([
            '2026-01',
            '2026-02',
            '2026-03',
            '2026-04',
            '2026-05',
            '2026-06',
        ]);
    });
});

describe('getDeveloperPRReviewCoaching (Task 5.3)', () => {
    let db: Database.Database;
    let d1: string;
    let d2: string;

    beforeEach(() => {
        db = makeDb();
        d1 = dev(db, 'eng', 'alice');
        d2 = dev(db, 'eng', 'bob');
    });
    afterEach(() => db.close());

    it('returns both variants separated with the right basis', () => {
        seedMetric(db, {developerId: d1, period: '2026-06', variant: 'all_pr', prsTotal: 5, rework: 0.2});
        seedMetric(db, {developerId: d1, period: '2026-06', variant: 'ai_assisted_pr', prsTotal: 3, rework: 0.33});

        const result = getDeveloperPRReviewCoaching(db, d1, 'monthly', NOW);
        expect(result.all_pr.scope_variant).toBe('all_pr');
        expect(result.all_pr.basis).toBe('factual');
        expect(result.ai_assisted.scope_variant).toBe('ai_assisted_pr');
        expect(result.ai_assisted.basis).toBe('inferred');
    });

    it('builds a continuous trajectory with empty points for missing periods', () => {
        seedMetric(db, {developerId: d1, period: '2026-05', variant: 'all_pr', prsTotal: 5, rework: 0.15, signal: 'effective'});
        seedMetric(db, {developerId: d1, period: '2026-06', variant: 'all_pr', prsTotal: 6, rework: 0.3, signal: 'struggling'});

        const result = getDeveloperPRReviewCoaching(db, d1, 'monthly', NOW);
        const points = result.all_pr.points;
        expect(points).toHaveLength(6); // full window
        expect(points[0]).toMatchObject({period: '2026-01', prs_total: 0, rework_rate: null});
        expect(points[5]).toMatchObject({period: '2026-06', prs_total: 6, rework_rate: 0.3});
        // Trajectory framing, not a snapshot.
        expect(result.all_pr.rework_trend.direction).toBe('rising');
        expect(result.all_pr.latest_signal).toBe('struggling');
        expect(result.all_pr.sufficient_periods).toBe(2);
    });

    it('only ever returns the requested developer’s rows', () => {
        seedMetric(db, {developerId: d1, period: '2026-06', variant: 'all_pr', prsTotal: 5, rework: 0.1});
        seedMetric(db, {developerId: d2, period: '2026-06', variant: 'all_pr', prsTotal: 9, rework: 0.9});

        const result = getDeveloperPRReviewCoaching(db, d1, 'monthly', NOW);
        const june = result.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.prs_total).toBe(5); // d1's 5, never d2's 9
    });
});

describe('getTeamPRReviewCoaching — aggregate only, k-anonymity (Task 5.3)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });
    afterEach(() => db.close());

    it('suppresses a period with fewer than 3 contributing developers', () => {
        const d1 = dev(db, 'eng', 'a');
        dev(db, 'eng', 'b');
        dev(db, 'eng', 'c');
        // Only ONE developer has PRs this period → must be suppressed.
        seedMetric(db, {developerId: d1, period: '2026-06', variant: 'all_pr', prsTotal: 8, rework: 0.4, churn: 0.3});

        const result = getTeamPRReviewCoaching(db, 'eng', 'monthly', NOW);
        const june = result.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.suppressed).toBe(true);
        expect(june?.rework_rate).toBeNull();
        expect(june?.prs_total).toBeNull();
        expect(june?.developers).toBeNull();
    });

    it('pools across the team once 3+ developers contribute', () => {
        const a = dev(db, 'eng', 'a');
        const b = dev(db, 'eng', 'b');
        const c = dev(db, 'eng', 'c');
        // 10@0.1, 10@0.5, 20@0.25 → pooled 11/40 = 0.275.
        seedMetric(db, {developerId: a, period: '2026-06', variant: 'all_pr', prsTotal: 10, rework: 0.1, rejection: 0.1});
        seedMetric(db, {developerId: b, period: '2026-06', variant: 'all_pr', prsTotal: 10, rework: 0.5, rejection: 0.5});
        seedMetric(db, {developerId: c, period: '2026-06', variant: 'all_pr', prsTotal: 20, rework: 0.25, rejection: 0.25});

        const result = getTeamPRReviewCoaching(db, 'eng', 'monthly', NOW);
        const june = result.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.suppressed).toBe(false);
        expect(june?.developers).toBe(3);
        expect(june?.prs_total).toBe(40);
        expect(june?.rework_rate).toBeCloseTo(0.275, 4);
    });

    it('aggregates the whole org under getOrgPRReviewCoaching', () => {
        const a = dev(db, 'eng', 'a');
        const b = dev(db, 'design', 'b');
        const c = dev(db, 'ops', 'c');
        for (const id of [a, b, c]) {
            seedMetric(db, {developerId: id, period: '2026-06', variant: 'all_pr', prsTotal: 4, rework: 0.2, rejection: 0.2});
        }
        const result = getOrgPRReviewCoaching(db, 'monthly', NOW);
        expect(result.scope).toBe('org');
        const june = result.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.suppressed).toBe(false);
        expect(june?.developers).toBe(3);
        expect(june?.prs_total).toBe(12);
    });

    it('scopes a team literally named "org" to that team only, never the whole org', () => {
        // SEC-1 regression: the org sentinel must not collide with a real team name.
        const a = dev(db, 'org', 'a'); // team called "org" with one member
        const b = dev(db, 'eng', 'b');
        const c = dev(db, 'eng', 'c');
        const d = dev(db, 'eng', 'd');
        seedMetric(db, {developerId: a, period: '2026-06', variant: 'all_pr', prsTotal: 4, rework: 0.2});
        for (const id of [b, c, d]) {
            seedMetric(db, {developerId: id, period: '2026-06', variant: 'all_pr', prsTotal: 4, rework: 0.2});
        }
        const result = getTeamPRReviewCoaching(db, 'org', 'monthly', NOW);
        const june = result.all_pr.points.find((p) => p.period === '2026-06');
        // The "org" TEAM has a single contributor → suppressed; it did NOT fold in
        // the 3 eng developers (which would have made it look like the whole org).
        expect(june?.suppressed).toBe(true);
    });

    it('returns an all-suppressed window for a team with no metrics', () => {
        dev(db, 'eng', 'a');
        const result = getTeamPRReviewCoaching(db, 'eng', 'monthly', NOW);
        expect(result.all_pr.points.every((p) => p.suppressed)).toBe(true);
        expect(result.all_pr.sufficient_periods).toBe(0);
        expect(result.ai_assisted.points.every((p) => p.suppressed)).toBe(true);
    });
});
