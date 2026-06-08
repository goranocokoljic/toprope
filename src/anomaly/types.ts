/**
 * Shared vocabulary for the anomaly detection engine (Task 4.7 / #102).
 *
 * Kept in one module so the pure engine, the config layer, the store, and the
 * scan orchestrator all agree on the same string unions — and so the DB CHECK
 * constraints in migration 023 have a single TypeScript mirror.
 */

/** Which entity a metric belongs to. */
export type AnomalyScope = 'developer' | 'team';

/** The detection method applied to a metric (configurable per metric). */
export type AnomalyMethod = 'statistical' | 'percentage_change';

/**
 * Severity assigned to a flagged anomaly. The engine emits `notable` or `high`;
 * `info` is reserved in the vocabulary for surfaces (Task 4.8) that may want to
 * down-rank borderline cases. Ordered least → most severe.
 */
export type AnomalySeverity = 'info' | 'notable' | 'high';

/**
 * Data tier behind a metric, stored on every anomaly so surfaces can label it
 * honestly. `git_estimate` for git-derived and cost metrics (the launch tier);
 * `measured` for tool metrics (interactions, acceptance_rate) that only carry
 * real values once a tool connector is online.
 */
export type AnomalyBasis = 'git_estimate' | 'measured';

/** Human workflow state of an anomaly once detected. */
export type AnomalyStatus = 'open' | 'acknowledged' | 'resolved';

/** The seven metrics the engine can evaluate. */
export type AnomalyMetric =
    | 'commits'
    | 'prs_merged'
    | 'churn'
    | 'ai_signature'
    | 'interactions'
    | 'acceptance_rate'
    | 'cost';

/** A persisted anomaly row (mirrors the `anomalies` table). */
export interface AnomalyRecord {
    id: string;
    scope: AnomalyScope;
    scope_id: string;
    metric: AnomalyMetric;
    period: string;
    method: AnomalyMethod;
    observed_value: number;
    expected_value: number;
    deviation: number;
    severity: AnomalySeverity;
    basis: AnomalyBasis;
    status: AnomalyStatus;
    detected_at: string;
    /**
     * When this anomaly was pushed to its Slack alert channel(s), or null if it
     * has not been announced yet (Task 4.8). Preserved across re-detection so a
     * re-scan never re-spams; see migration 024 and src/anomaly/notify.ts.
     */
    notified_at: string | null;
}
