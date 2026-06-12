/**
 * Available-data coaching thresholds (Task 5.1 / #122).
 *
 * Defaults ← global override, stored as one JSON row in the generic `settings`
 * table (scope 'global', key 'available_coaching_thresholds') — the same
 * direct-row pattern the anomaly and pr-review configs use. No per-team layer:
 * these are developer-private within-developer trajectories, never team-tuned
 * (design §4 — all private, manager sees aggregate trends only). The future
 * coaching-settings surface (Task 5.10) will consume the setter.
 */

import type Database from 'better-sqlite3';
import type {AvailableCoachingThresholds} from './types';

const THRESHOLDS_KEY = 'available_coaching_thresholds';

/**
 * Defaults: a churn move of ≥25% vs the developer's own baseline reads as
 * elevated/lower; an acceptance move of ≥5 percentage points reads as a trend;
 * baseline is the prior 4 periods; coaching needs ≥2 active days so a single
 * stray commit doesn't trigger a reflection.
 */
export const DEFAULT_AVAILABLE_COACHING_THRESHOLDS: AvailableCoachingThresholds = {
    churnChangeThreshold: 0.25,
    acceptanceChangeThreshold: 0.05,
    baselinePeriods: 4,
    minActiveDays: 2,
};

function readJsonRow(db: Database.Database, key: string): Record<string, unknown> | null {
    const row = db
        .prepare("SELECT value FROM settings WHERE scope = 'global' AND scope_name = '' AND key = ?")
        .get(key) as {value: string} | undefined;
    if (!row) return null;
    try {
        const parsed = JSON.parse(row.value) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Extract the valid recognised fields of a stored override. Invalid values are
 * dropped so a hand-edited row degrades to "inherit the default for that field"
 * rather than corrupting resolution — same contract as the anomaly/pr-review
 * configs.
 */
function coerceOverride(
    raw: Record<string, unknown> | null,
): Partial<AvailableCoachingThresholds> {
    if (!raw) return {};
    const out: Partial<AvailableCoachingThresholds> = {};
    // Change thresholds are non-negative fractions/pp; a negative value would
    // make every move count as a trend, so out-of-range values are dropped.
    const nonNegFraction = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (nonNegFraction(raw.churnChangeThreshold)) out.churnChangeThreshold = raw.churnChangeThreshold;
    if (nonNegFraction(raw.acceptanceChangeThreshold)) {
        out.acceptanceChangeThreshold = raw.acceptanceChangeThreshold;
    }
    const posInt = (v: unknown): v is number =>
        typeof v === 'number' && Number.isInteger(v) && v >= 1;
    if (posInt(raw.baselinePeriods)) out.baselinePeriods = raw.baselinePeriods;
    if (posInt(raw.minActiveDays)) out.minActiveDays = raw.minActiveDays;
    return out;
}

/** The effective thresholds: hardcoded defaults ← global settings override. */
export function resolveAvailableCoachingThresholds(
    db: Database.Database,
): AvailableCoachingThresholds {
    return {
        ...DEFAULT_AVAILABLE_COACHING_THRESHOLDS,
        ...coerceOverride(readJsonRow(db, THRESHOLDS_KEY)),
    };
}

/**
 * Set (merge) the global thresholds override. Used by tests and the future
 * coaching-settings surface (Task 5.10), mirroring the pr-review config setter.
 */
export function setAvailableCoachingThresholds(
    db: Database.Database,
    partial: Partial<AvailableCoachingThresholds>,
): void {
    const current = coerceOverride(readJsonRow(db, THRESHOLDS_KEY));
    db.prepare(
        `INSERT INTO settings (scope, scope_name, key, value, updated_at)
         VALUES ('global', '', ?, ?, ?)
         ON CONFLICT(scope, scope_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(THRESHOLDS_KEY, JSON.stringify({...current, ...partial}), new Date().toISOString());
}
