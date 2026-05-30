import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {setGlobalSetting, setTeamSetting} from '../../src/settings/store';
import {
    captureBaselines,
    evaluatePlanRoi,
    DEFAULT_BASELINE_WINDOW_DAYS,
} from '../../src/expenses/plan-roi';
import {listActiveAlerts} from '../../src/expenses/waste-detector';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/** A YYYY-MM-DD date `n` days before `from` (default today, UTC). */
function dateDaysBefore(n: number, from: Date = new Date()): string {
    return new Date(from.getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

interface PlanChangeInput {
    developer_id: string;
    tool: string;
    old_tool?: string | null;
    old_plan?: string | null;
    new_plan?: string | null;
    old_monthly_cost: number | null;
    new_monthly_cost: number | null;
    changed_at: string;
}

function insertPlanChange(db: Database.Database, input: PlanChangeInput): string {
    const id = randomUUID();
    db.prepare(
        `INSERT INTO plan_change_events
           (id, developer_id, tool, old_tool, old_plan, new_plan, old_monthly_cost, new_monthly_cost, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        input.developer_id,
        input.tool,
        input.old_tool ?? null,
        input.old_plan ?? null,
        input.new_plan ?? null,
        input.old_monthly_cost,
        input.new_monthly_cost,
        input.changed_at,
    );
    return id;
}

/**
 * Insert a single tool_snapshot whose interaction_count is the whole window's
 * total. avgDailyUsage divides the summed interactions by the window length, so one
 * row carrying `total` interactions yields an average of total/windowDays — a
 * convenient way to dial a precise per-day baseline/post figure in one row.
 */
function insertUsage(
    db: Database.Database,
    developerId: string,
    date: string,
    tool: string,
    total: number,
): void {
    db.prepare(
        `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count)
         VALUES (?, ?, ?, ?, 'test', 'high', 1, ?)
         ON CONFLICT(developer_id, date, tool) DO NOTHING`,
    ).run(`${developerId}-${date}-${tool}`, developerId, date, tool, total);
}

function getEvent(db: Database.Database, id: string): {
    baseline_usage: number | null;
    baseline_window_days: number | null;
    post_change_usage: number | null;
    evaluated_at: string | null;
    roi_flagged: number;
} {
    return db
        .prepare(
            'SELECT baseline_usage, baseline_window_days, post_change_usage, evaluated_at, roi_flagged FROM plan_change_events WHERE id = ?',
        )
        .get(id) as never;
}

describe('plan-roi detection', () => {
    let db: Database.Database;
    let alice: string;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'engineering');
        alice = addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com').id;
    });

    afterEach(() => {
        db.close();
    });

    // ── Baseline capture ──────────────────────────────────────────────────────

    it('captures baseline usage over the N days before the change', () => {
        const changedAt = `${dateDaysBefore(40)}T00:00:00.000Z`;
        const changedDate = changedAt.slice(0, 10);
        const id = insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_plan: 'pro',
            new_plan: 'max',
            old_monthly_cost: 20,
            new_monthly_cost: 100,
            changed_at: changedAt,
        });
        // 150 interactions inside the 30-day pre-change window → 5/day average.
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'claude_code', 150);

        const captured = captureBaselines(db);
        expect(captured).toBe(1);

        const event = getEvent(db, id);
        expect(event.baseline_usage).toBeCloseTo(5);
        expect(event.baseline_window_days).toBe(DEFAULT_BASELINE_WINDOW_DAYS);
    });

    it('is idempotent — re-running captures nothing new', () => {
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 100,
            changed_at: `${dateDaysBefore(40)}T00:00:00.000Z`,
        });
        expect(captureBaselines(db)).toBe(1);
        expect(captureBaselines(db)).toBe(0);
    });

    // ── Post-change evaluation & flagging ──────────────────────────────────────

    it('flags a large cost increase with negligible usage increase', () => {
        const changedDate = dateDaysBefore(40);
        const changedAt = `${changedDate}T00:00:00.000Z`;
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_plan: 'pro',
            new_plan: 'max',
            old_monthly_cost: 20,
            new_monthly_cost: 80, // 4× cost
            changed_at: changedAt,
        });
        // baseline 5/day, post 5/day → usage ratio 1, cost ratio 4 ≥ 3×1 → flagged.
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'claude_code', 150);
        insertUsage(db, alice, dateDaysBefore(-15, new Date(changedDate)), 'claude_code', 150);

        const result = evaluatePlanRoi(db);
        expect(result.evaluated).toBe(1);
        expect(result.flagged).toBe(1);

        const alerts = listActiveAlerts(db);
        expect(alerts).toHaveLength(1);
        const alert = alerts[0];
        expect(alert.alert_type).toBe('plan_roi');
        expect(alert.tool).toBe('claude_code');
        // A review prompt is not confirmed waste — monthly_waste stays null so it does
        // not inflate hard-dollar waste totals; the cost increase lives in details.
        expect(alert.monthly_waste).toBeNull();
        expect(alert.details.old_plan).toBe('pro');
        expect(alert.details.new_plan).toBe('max');
        expect(alert.details.cost_delta).toBe(60);
        expect(alert.details.usage_delta).toBe(0);
        expect(alert.details.cost_ratio).toBe(4);
        expect(typeof alert.details.days_since_change).toBe('number');
        // Review-oriented framing, never accusatory.
        expect(String(alert.details.note)).toMatch(/review/i);
        expect(String(alert.details.note)).not.toMatch(/wrong|fault|abuse|waste/i);
    });

    it('does NOT flag a cost increase matched by a proportional usage increase', () => {
        const changedDate = dateDaysBefore(40);
        const changedAt = `${changedDate}T00:00:00.000Z`;
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 40, // 2× cost
            changed_at: changedAt,
        });
        // baseline 5/day, post 10/day → usage ratio 2; cost ratio 2 < 3×2 → not flagged.
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'claude_code', 150);
        insertUsage(db, alice, dateDaysBefore(-15, new Date(changedDate)), 'claude_code', 300);

        const result = evaluatePlanRoi(db);
        expect(result.evaluated).toBe(1);
        expect(result.flagged).toBe(0);
        expect(listActiveAlerts(db)).toHaveLength(0);
    });

    it('does not raise a duplicate alert when run twice', () => {
        const changedDate = dateDaysBefore(40);
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 80,
            changed_at: `${changedDate}T00:00:00.000Z`,
        });
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'claude_code', 150);

        expect(evaluatePlanRoi(db).flagged).toBe(1);
        const second = evaluatePlanRoi(db);
        expect(second.evaluated).toBe(0);
        expect(listActiveAlerts(db)).toHaveLength(1);
    });

    // ── Settling-period gating ─────────────────────────────────────────────────

    it('does not evaluate before the settling period elapses, but does capture baseline', () => {
        const changedDate = dateDaysBefore(5); // only 5 days ago, settling default 30
        const id = insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 80,
            changed_at: `${changedDate}T00:00:00.000Z`,
        });
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'claude_code', 150);

        const result = evaluatePlanRoi(db);
        expect(result.baselinesCaptured).toBe(1);
        expect(result.evaluated).toBe(0);

        const event = getEvent(db, id);
        expect(event.baseline_usage).toBeCloseTo(5);
        expect(event.evaluated_at).toBeNull();
        expect(listActiveAlerts(db)).toHaveLength(0);
    });

    it('evaluates once the settling period has elapsed (via injected now)', () => {
        const changedAt = '2026-01-01T00:00:00.000Z';
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 80,
            changed_at: changedAt,
        });
        insertUsage(db, alice, '2025-12-20', 'claude_code', 150); // pre-change

        // 10 days after change: settling (30d) not elapsed → no evaluation.
        const early = evaluatePlanRoi(db, {now: new Date('2026-01-11T00:00:00.000Z')});
        expect(early.evaluated).toBe(0);

        // 31 days after change: settling elapsed → evaluated.
        const late = evaluatePlanRoi(db, {now: new Date('2026-02-01T00:00:00.000Z')});
        expect(late.evaluated).toBe(1);
        expect(late.flagged).toBe(1);
    });

    // ── Threshold settings & per-team overrides ────────────────────────────────

    it('respects a per-team threshold override when the governing flag is on', () => {
        const changedDate = dateDaysBefore(40);
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 40, // 2× cost
            changed_at: `${changedDate}T00:00:00.000Z`,
        });
        // baseline 5/day, post 5/day → usage ratio 1. Cost ratio 2.
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'claude_code', 150);
        insertUsage(db, alice, dateDaysBefore(-15, new Date(changedDate)), 'claude_code', 150);

        // Global threshold 3: 2 ≥ 3×1 is false → not flagged.
        // Lower the team threshold to 1.5 and allow overrides: 2 ≥ 1.5×1 → flagged.
        setGlobalSetting(db, 'roi_managers_can_override', true);
        setTeamSetting(db, 'engineering', 'roi_threshold', 1.5);

        const result = evaluatePlanRoi(db);
        expect(result.flagged).toBe(1);
        expect(listActiveAlerts(db)[0].details.threshold).toBe(1.5);
    });

    it('ignores a team override while its governing flag is off', () => {
        const changedDate = dateDaysBefore(40);
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 40,
            changed_at: `${changedDate}T00:00:00.000Z`,
        });
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'claude_code', 150);
        insertUsage(db, alice, dateDaysBefore(-15, new Date(changedDate)), 'claude_code', 150);

        // Override row exists but the managers_can_override flag is off (default) →
        // resolution falls back to the global default of 3 → not flagged.
        setTeamSetting(db, 'engineering', 'roi_threshold', 1.5);

        const result = evaluatePlanRoi(db);
        expect(result.flagged).toBe(0);
    });

    it('respects a per-team settling override that defers evaluation', () => {
        const changedAt = '2026-01-01T00:00:00.000Z';
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 80,
            changed_at: changedAt,
        });
        insertUsage(db, alice, '2025-12-20', 'claude_code', 150);

        // Stretch settling to 60 days for this team; 40 days later is still too soon.
        setGlobalSetting(db, 'roi_managers_can_override', true);
        setTeamSetting(db, 'engineering', 'roi_settling_days', 60);

        const at40 = evaluatePlanRoi(db, {now: new Date('2026-02-10T00:00:00.000Z')});
        expect(at40.evaluated).toBe(0);

        const at61 = evaluatePlanRoi(db, {now: new Date('2026-03-03T00:00:00.000Z')});
        expect(at61.evaluated).toBe(1);
    });

    // ── Non-upgrades are never flagged ─────────────────────────────────────────

    it('does not evaluate or flag a downgrade', () => {
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 80,
            new_monthly_cost: 20, // downgrade
            changed_at: `${dateDaysBefore(40)}T00:00:00.000Z`,
        });
        const result = evaluatePlanRoi(db);
        expect(result.baselinesCaptured).toBe(0);
        expect(result.evaluated).toBe(0);
        expect(result.flagged).toBe(0);
    });

    it('does not evaluate or flag a lateral (same-cost) change', () => {
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 40,
            new_monthly_cost: 40, // lateral
            changed_at: `${dateDaysBefore(40)}T00:00:00.000Z`,
        });
        const result = evaluatePlanRoi(db);
        expect(result.evaluated).toBe(0);
        expect(result.flagged).toBe(0);
    });

    it('does not evaluate a free→paid transition (undefined cost ratio)', () => {
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 0,
            new_monthly_cost: 20,
            changed_at: `${dateDaysBefore(40)}T00:00:00.000Z`,
        });
        const result = evaluatePlanRoi(db);
        expect(result.evaluated).toBe(0);
        expect(result.flagged).toBe(0);
    });

    it('does not flag when usage grew from zero baseline', () => {
        const changedDate = dateDaysBefore(40);
        insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 80,
            changed_at: `${changedDate}T00:00:00.000Z`,
        });
        // No baseline usage at all, but heavy post-change usage → usage ratio Infinity.
        insertUsage(db, alice, dateDaysBefore(-15, new Date(changedDate)), 'claude_code', 600);

        const result = evaluatePlanRoi(db);
        expect(result.evaluated).toBe(1);
        expect(result.flagged).toBe(0);
    });

    it('ignores inactive-day interactions when averaging usage (matches the waste detector)', () => {
        const changedDate = dateDaysBefore(40);
        const id = insertPlanChange(db, {
            developer_id: alice,
            tool: 'claude_code',
            old_monthly_cost: 20,
            new_monthly_cost: 80,
            changed_at: `${changedDate}T00:00:00.000Z`,
        });
        // A snapshot with interaction_count but is_active = 0 must NOT count as usage.
        db.prepare(
            `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count)
             VALUES (?, ?, ?, 'claude_code', 'test', 'high', 0, 300)`,
        ).run('inactive-row', alice, dateDaysBefore(15, new Date(changedDate)));

        captureBaselines(db);
        expect(getEvent(db, id).baseline_usage).toBe(0);
    });

    // ── Tool switch baseline uses the OLD tool's prior usage ────────────────────

    it('measures baseline against the old tool for a tool switch', () => {
        const changedDate = dateDaysBefore(40);
        const id = insertPlanChange(db, {
            developer_id: alice,
            tool: 'cursor',
            old_tool: 'copilot',
            old_monthly_cost: 20,
            new_monthly_cost: 80,
            changed_at: `${changedDate}T00:00:00.000Z`,
        });
        // Prior usage is on the OLD tool (copilot); new tool (cursor) has none yet.
        insertUsage(db, alice, dateDaysBefore(15, new Date(changedDate)), 'copilot', 300);

        captureBaselines(db);
        expect(getEvent(db, id).baseline_usage).toBeCloseTo(10); // 300 / 30
    });
});
