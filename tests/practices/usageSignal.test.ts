import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {recordUsageEvent} from '../../src/practices/store';
import {
    analyzeUsageSignal,
    DIRECTIONAL_DISCLAIMER,
    type UsageSignalOptions,
    type UsageSignalResult,
} from '../../src/practices/usageSignal';
import type {PracticeMetric} from '../../src/practices/metrics';

const T1 = '2026-01-01T00:00:00.000Z';

// Engagement anchor and the before/after snapshot days that fall inside the default
// 14-day windows around it ([day-14, day-1] and [day+1, day+14]).
const ENGAGE_DAY = '2026-03-15';
const ENGAGE_AT = `${ENGAGE_DAY}T12:00:00.000Z`;
const BEFORE_DAY = '2026-03-10';
const AFTER_DAY = '2026-03-20';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        'eng',
        T1,
    );
}

function seedContribution(db: Database.Database, id: string): void {
    db.prepare(
        `INSERT INTO contributions
         (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
         VALUES (?, 'best_practice', 'Use prepared statements', 'alice', 'org', NULL, 'published', 1, ?, ?)`,
    ).run(id, T1, T1);
}

/** Insert a git_snapshot carrying a code_churn_rate on `date`. */
function seedChurn(db: Database.Database, dev: string, date: string, churn: number): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, code_churn_rate) VALUES (?, ?, ?, ?)`,
    ).run(`git-${dev}-${date}`, dev, date, churn);
}

/** Insert a git_snapshot carrying an ai_signature_score on `date`. */
function seedAiSignature(db: Database.Database, dev: string, date: string, score: number): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, ai_signature_score) VALUES (?, ?, ?, ?)`,
    ).run(`gs-${dev}-${date}`, dev, date, score);
}

/** Insert a git_snapshot carrying merged-PR counts on `date` (drives cost_per_pr). */
function seedPrs(db: Database.Database, dev: string, date: string, prsMerged: number): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, prs_merged) VALUES (?, ?, ?, ?)`,
    ).run(`gp-${dev}-${date}`, dev, date, prsMerged);
}

/** Give a developer a company-managed subscription assigned well before the windows. */
function seedSubscription(db: Database.Database, dev: string, monthlyCost: number): void {
    db.prepare(
        `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, data_source)
         VALUES (?, ?, 'copilot', 'business', 'company_managed', ?, '2026-01-01', 'csv')`,
    ).run(`sub-${dev}`, dev, monthlyCost);
}

/** Insert a tool_snapshot whose acceptance_rate is acceptances/interactions on `date`. */
function seedAcceptance(
    db: Database.Database,
    dev: string,
    date: string,
    interactions: number,
    acceptances: number,
): void {
    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count)
         VALUES (?, ?, ?, 'copilot', 'api', 'high', 1, ?, ?)`,
    ).run(`tool-${dev}-${date}`, dev, date, interactions, acceptances);
}

/**
 * Seed a developer who engaged with practice `c1` and whose churn moved from
 * `before` to `after`. A null on either side leaves that window empty (the
 * developer becomes non-measurable). Records the engagement event by default.
 */
function seedChurnDev(
    db: Database.Database,
    dev: string,
    before: number | null,
    after: number | null,
    opts: {event?: string; metric?: string; occurredAt?: string; record?: boolean} = {},
): void {
    seedDeveloper(db, dev);
    if (before !== null) seedChurn(db, dev, BEFORE_DAY, before);
    if (after !== null) seedChurn(db, dev, AFTER_DAY, after);
    if (opts.record !== false) {
        recordUsageEvent(db, {
            contributionId: 'c1',
            developerId: dev,
            event: opts.event ?? 'viewed',
            metricContext: opts.metric ?? 'churn',
            occurredAt: opts.occurredAt ?? ENGAGE_AT,
        });
    }
}

function analyze(db: Database.Database, metric: PracticeMetric, options: UsageSignalOptions = {}): UsageSignalResult {
    return analyzeUsageSignal(db, 'c1', metric, {minSample: 3, ...options});
}

describe('usage-signal correlation (Task 6.2.4 / #159)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice'); // the practice author (FK target for contributions.author_id)
        seedContribution(db, 'c1');
    });

    afterEach(() => {
        db.close();
    });

    // --- min-sample guard ----------------------------------------------------

    it('WITHHOLDS the signal below the minimum sample, with no figures', () => {
        // Only two measurable developers; minSample is 3.
        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.5, 0.2);
        const res = analyze(db, 'churn');
        expect(res.shown).toBe(false);
        expect(res.sampleSize).toBe(2);
        expect(res.minSample).toBe(3);
        expect(res.improved).toBeNull();
        expect(res.worsened).toBeNull();
        expect(res.flat).toBeNull();
        expect(res.improvedShare).toBeNull();
        expect(res.headline).toBeNull();
    });

    it('shows the signal once the sample reaches the threshold', () => {
        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.6, 0.3);
        seedChurnDev(db, 'd3', 0.4, 0.1);
        const res = analyze(db, 'churn');
        expect(res.shown).toBe(true);
        expect(res.sampleSize).toBe(3);
        expect(res.improved).toBe(3);
        expect(res.worsened).toBe(0);
        expect(res.flat).toBe(0);
        expect(res.improvedShare).toBe(1);
        expect(res.headline).toContain('3 developers');
        // git-only windows → the weakest contributing tier is 'medium'.
        expect(res.basis).toBe('medium');
    });

    // --- directional / non-causal labeling -----------------------------------

    it('always carries the non-causal disclaimer — shown OR withheld', () => {
        const withheld = analyze(db, 'churn'); // zero sample
        expect(withheld.shown).toBe(false);
        expect(withheld.disclaimer).toBe(DIRECTIONAL_DISCLAIMER);

        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.6, 0.3);
        seedChurnDev(db, 'd3', 0.4, 0.1);
        const shown = analyze(db, 'churn');
        expect(shown.shown).toBe(true);
        expect(shown.disclaimer).toBe(DIRECTIONAL_DISCLAIMER);
    });

    it('the disclaimer is explicitly correlation-not-causation (copy reviewed)', () => {
        expect(DIRECTIONAL_DISCLAIMER.toLowerCase()).toContain('correlation, not causation');
        expect(DIRECTIONAL_DISCLAIMER.toLowerCase()).toContain('does not claim the practice caused');
    });

    it('the headline is directional ("developers who engaged ... saw"), never causal', () => {
        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.6, 0.3);
        seedChurnDev(db, 'd3', 0.4, 0.1);
        const res = analyze(db, 'churn');
        expect(res.headline).toMatch(/developers who engaged with this practice/i);
        expect(res.headline).toMatch(/improve afterward/i);
        // It attributes the movement to the developers, not the practice.
        expect(res.headline?.toLowerCase()).not.toContain('this practice improved');
    });

    // --- aggregation & polarity ----------------------------------------------

    it('tallies a mix of improved / worsened / flat correctly', () => {
        seedChurnDev(db, 'd1', 0.5, 0.2); // improved (churn down)
        seedChurnDev(db, 'd2', 0.6, 0.3); // improved
        seedChurnDev(db, 'd3', 0.4, 0.1); // improved
        seedChurnDev(db, 'd4', 0.2, 0.5); // worsened (churn up)
        seedChurnDev(db, 'd5', 0.3, 0.3); // flat (no change)
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(5);
        expect(res.improved).toBe(3);
        expect(res.worsened).toBe(1);
        expect(res.flat).toBe(1);
        expect(res.improvedShare).toBeCloseTo(3 / 5, 10);
    });

    it('respects metric polarity: acceptance_rate improves when it goes UP', () => {
        // Three devs whose acceptance rate rises after engaging.
        for (const dev of ['d1', 'd2', 'd3']) {
            seedDeveloper(db, dev);
            seedAcceptance(db, dev, BEFORE_DAY, 10, 5); // 0.5
            seedAcceptance(db, dev, AFTER_DAY, 10, 8); // 0.8 → up → improved
            recordUsageEvent(db, {
                contributionId: 'c1',
                developerId: dev,
                event: 'applied',
                metricContext: 'acceptance_rate',
                occurredAt: ENGAGE_AT,
            });
        }
        const res = analyze(db, 'acceptance_rate');
        expect(res.shown).toBe(true);
        expect(res.improved).toBe(3);
        expect(res.worsened).toBe(0);
    });

    it('respects metric polarity: ai_signature_score improves when it goes UP', () => {
        for (const dev of ['d1', 'd2', 'd3']) {
            seedDeveloper(db, dev);
            seedAiSignature(db, dev, BEFORE_DAY, 0.3);
            seedAiSignature(db, dev, AFTER_DAY, 0.7); // up → improved
            recordUsageEvent(db, {
                contributionId: 'c1',
                developerId: dev,
                event: 'viewed',
                metricContext: 'ai_signature_score',
                occurredAt: ENGAGE_AT,
            });
        }
        const res = analyze(db, 'ai_signature_score');
        expect(res.shown).toBe(true);
        expect(res.improved).toBe(3);
        expect(res.worsened).toBe(0);
    });

    it('correlates cost_per_pr (subscription ÷ merged PRs), improving when it falls', () => {
        // Same subscription each window; more merged PRs after → lower cost per PR → improved.
        for (const dev of ['d1', 'd2', 'd3']) {
            seedDeveloper(db, dev);
            seedSubscription(db, dev, 30);
            seedPrs(db, dev, BEFORE_DAY, 1); // ~13.5 / 1 ≈ 13.5
            seedPrs(db, dev, AFTER_DAY, 5); // ~13.5 / 5 ≈ 2.7 → cost per PR fell
            recordUsageEvent(db, {
                contributionId: 'c1',
                developerId: dev,
                event: 'applied',
                metricContext: 'cost_per_pr',
                occurredAt: ENGAGE_AT,
            });
        }
        const res = analyze(db, 'cost_per_pr');
        expect(res.shown).toBe(true);
        expect(res.improved).toBe(3);
        expect(res.worsened).toBe(0);
    });

    // --- before/after window boundaries --------------------------------------

    it('excludes a snapshot ON the engagement day from BOTH windows, and includes the far edges', () => {
        // d1: churn data ONLY on the engagement day — neither window sees it, so d1 is
        // non-measurable and excluded. d2/d3: data on the inclusive far edges (day-14,
        // day+14) — both windows see them, so they ARE measurable and improve.
        seedDeveloper(db, 'd1');
        seedChurn(db, 'd1', ENGAGE_DAY, 0.5); // on the engagement day → in neither window
        recordUsageEvent(db, {contributionId: 'c1', developerId: 'd1', event: 'viewed', metricContext: 'churn', occurredAt: ENGAGE_AT});
        for (const dev of ['d2', 'd3', 'd4']) {
            seedDeveloper(db, dev);
            seedChurn(db, dev, '2026-03-01', 0.6); // day-14 (engagement 03-15) → far edge of before window
            seedChurn(db, dev, '2026-03-29', 0.2); // day+14 → far edge of after window
            recordUsageEvent(db, {contributionId: 'c1', developerId: dev, event: 'viewed', metricContext: 'churn', occurredAt: ENGAGE_AT});
        }
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(3); // d1 excluded (only an engagement-day point)
        expect(res.improved).toBe(3); // d2/d3/d4 measured across the far edges
    });

    // --- data-quality basis (SO-1) -------------------------------------------

    it('reports the WEAKEST data-quality tier across measurable windows as the basis', () => {
        // Two git-only developers (medium tier) and one with tool activity (high tier).
        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.6, 0.3);
        seedDeveloper(db, 'd3');
        seedChurn(db, 'd3', BEFORE_DAY, 0.4);
        seedChurn(db, 'd3', AFTER_DAY, 0.1);
        // d3 also has tool usage in both windows → its windows compute as 'high' tier.
        seedAcceptance(db, 'd3', BEFORE_DAY, 10, 8);
        seedAcceptance(db, 'd3', AFTER_DAY, 10, 9);
        recordUsageEvent(db, {contributionId: 'c1', developerId: 'd3', event: 'viewed', metricContext: 'churn', occurredAt: ENGAGE_AT});
        const res = analyze(db, 'churn');
        expect(res.shown).toBe(true);
        expect(res.sampleSize).toBe(3);
        // d1/d2 windows are 'medium'; the weakest tier wins even though d3 is 'high'.
        expect(res.basis).toBe('medium');
    });

    // --- the "measurable" rule -----------------------------------------------

    it('excludes a developer missing either window rather than counting them flat', () => {
        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.6, 0.3);
        seedChurnDev(db, 'd3', 0.4, 0.1);
        seedChurnDev(db, 'd4', 0.5, null); // engaged but NO after-window data → not measurable
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(3); // d4 excluded, not counted as a 4th flat
        expect(res.improved).toBe(3);
    });

    // --- engagement filtering ------------------------------------------------

    it('only counts events whose metric_context matches the metric under study', () => {
        // All three engaged, but tagged against a DIFFERENT metric than we analyze.
        seedChurnDev(db, 'd1', 0.5, 0.2, {metric: 'acceptance_rate'});
        seedChurnDev(db, 'd2', 0.6, 0.3, {metric: 'acceptance_rate'});
        seedChurnDev(db, 'd3', 0.4, 0.1, {metric: 'acceptance_rate'});
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(0);
        expect(res.shown).toBe(false);
    });

    it('ignores non-engagement event kinds (e.g. dismissed)', () => {
        seedChurnDev(db, 'd1', 0.5, 0.2, {event: 'dismissed'});
        seedChurnDev(db, 'd2', 0.6, 0.3, {event: 'dismissed'});
        seedChurnDev(db, 'd3', 0.4, 0.1, {event: 'dismissed'});
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(0);
    });

    it('counts a developer once even with several engagement events', () => {
        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.6, 0.3);
        seedChurnDev(db, 'd3', 0.4, 0.1, {record: false});
        // d3 engages twice (seeded with record:false above) — must still count once.
        recordUsageEvent(db, {contributionId: 'c1', developerId: 'd3', event: 'viewed', metricContext: 'churn', occurredAt: ENGAGE_AT});
        recordUsageEvent(db, {contributionId: 'c1', developerId: 'd3', event: 'applied', metricContext: 'churn', occurredAt: '2026-03-16T00:00:00.000Z'});
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(3);
    });

    it('skips a developer whose engagement has an unparseable timestamp', () => {
        seedChurnDev(db, 'd1', 0.5, 0.2);
        seedChurnDev(db, 'd2', 0.6, 0.3);
        seedChurnDev(db, 'd3', 0.4, 0.1);
        // d4 engaged but its event timestamp is corrupt — it must be skipped, not crash.
        seedChurnDev(db, 'd4', 0.5, 0.2, {record: false});
        recordUsageEvent(db, {
            contributionId: 'c1',
            developerId: 'd4',
            event: 'viewed',
            metricContext: 'churn',
            occurredAt: 'not-a-real-timestamp',
        });
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(3); // d4 dropped defensively
        expect(res.improved).toBe(3);
    });

    it('correlates a downward-polarity cost metric (estimated_cost)', () => {
        for (const dev of ['d1', 'd2', 'd3']) {
            seedDeveloper(db, dev);
            // estimated_cost is summed from tool_snapshots.estimated_cost over the window.
            db.prepare(
                `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active, estimated_cost)
                 VALUES (?, ?, ?, 'copilot', 'api', 'high', 1, ?)`,
            ).run(`tc-b-${dev}`, dev, BEFORE_DAY, 30);
            db.prepare(
                `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active, estimated_cost)
                 VALUES (?, ?, ?, 'copilot', 'api', 'high', 1, ?)`,
            ).run(`tc-a-${dev}`, dev, AFTER_DAY, 10); // cost fell → improved
            recordUsageEvent(db, {
                contributionId: 'c1',
                developerId: dev,
                event: 'applied',
                metricContext: 'estimated_cost',
                occurredAt: ENGAGE_AT,
            });
        }
        const res = analyze(db, 'estimated_cost');
        expect(res.shown).toBe(true);
        expect(res.improved).toBe(3);
    });

    // --- guards on inputs ----------------------------------------------------

    it('throws on an unknown metric', () => {
        expect(() => analyzeUsageSignal(db, 'c1', 'bogus' as PracticeMetric)).toThrow(/unknown metric/);
    });

    it('throws on a non-positive window', () => {
        expect(() => analyze(db, 'churn', {windowDays: 0})).toThrow(/windowDays/);
    });

    it('returns a zero-sample withheld result for a practice nobody engaged with', () => {
        const res = analyze(db, 'churn');
        expect(res.sampleSize).toBe(0);
        expect(res.shown).toBe(false);
        expect(res.disclaimer).toBe(DIRECTIONAL_DISCLAIMER);
    });
});
