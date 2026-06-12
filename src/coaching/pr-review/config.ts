/**
 * PR/Review metrics threshold configuration (Task 5.2 / #123).
 *
 * Defaults ← global override, stored as one JSON row in the generic `settings`
 * table (scope 'global', key 'pr_review_thresholds') — the same direct-row
 * pattern the anomaly config uses (src/anomaly/config.ts): the typed settings
 * registry models flat scalar keys, a poor fit for a structured threshold map.
 * No per-team layer: these metrics are developer-private trajectories, never
 * team-tuned rankings (design §5.3 — within-developer-over-time only).
 */

import type Database from 'better-sqlite3';
import type {PRReviewThresholds} from './types';

const THRESHOLDS_KEY = 'pr_review_thresholds';

/** Issue-suggested defaults: churn 0.20, reject 0.30; baseline = prior 8 periods. */
export const DEFAULT_PR_REVIEW_THRESHOLDS: PRReviewThresholds = {
    churnHighThreshold: 0.2,
    rejectThreshold: 0.3,
    aiSignatureThreshold: 0.5,
    minPrs: 3,
    baselinePeriods: 8,
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
 * Extract the valid, recognised fields of a stored override. Invalid values are
 * dropped so a hand-edited row degrades to "inherit the default for that field"
 * rather than corrupting resolution — same contract as the anomaly config.
 */
function coerceOverride(raw: Record<string, unknown> | null): Partial<PRReviewThresholds> {
    if (!raw) return {};
    const out: Partial<PRReviewThresholds> = {};
    // The three rate-like thresholds compare against [0,1] ratios (churn rate,
    // rejection rate, AI-signature score). A value outside [0,1] would silently
    // make a signal unreachable (e.g. rejectThreshold 50 disables 'struggling'),
    // so out-of-range values are dropped like any other invalid field.
    const ratio = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (ratio(raw.churnHighThreshold)) out.churnHighThreshold = raw.churnHighThreshold;
    if (ratio(raw.rejectThreshold)) out.rejectThreshold = raw.rejectThreshold;
    if (ratio(raw.aiSignatureThreshold)) out.aiSignatureThreshold = raw.aiSignatureThreshold;
    if (
        typeof raw.minPrs === 'number' &&
        Number.isInteger(raw.minPrs) &&
        raw.minPrs >= 1
    ) {
        out.minPrs = raw.minPrs;
    }
    if (
        typeof raw.baselinePeriods === 'number' &&
        Number.isInteger(raw.baselinePeriods) &&
        raw.baselinePeriods >= 1
    ) {
        out.baselinePeriods = raw.baselinePeriods;
    }
    return out;
}

/** The effective thresholds: hardcoded defaults ← global settings override. */
export function resolvePRReviewThresholds(db: Database.Database): PRReviewThresholds {
    return {...DEFAULT_PR_REVIEW_THRESHOLDS, ...coerceOverride(readJsonRow(db, THRESHOLDS_KEY))};
}

/**
 * Set (merge) the global thresholds override. Used by tests and the future
 * coaching-settings surface (Task 5.10), mirroring the anomaly config's
 * setters that predated their Task 4.12 settings-API wiring.
 */
export function setPRReviewThresholds(
    db: Database.Database,
    partial: Partial<PRReviewThresholds>,
): void {
    const current = coerceOverride(readJsonRow(db, THRESHOLDS_KEY));
    db.prepare(
        `INSERT INTO settings (scope, scope_name, key, value, updated_at)
         VALUES ('global', '', ?, ?, ?)
         ON CONFLICT(scope, scope_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(THRESHOLDS_KEY, JSON.stringify({...current, ...partial}), new Date().toISOString());
}
