/**
 * Anomaly Slack notification (Task 4.8 / #103).
 *
 * Pushes newly-detected notable/high TEAM anomalies to the manager's configured
 * Slack channel(s), exactly once each. The work list comes from the store
 * (open + surfaceable + not-yet-announced), so this is safe to run after every
 * scan: a re-scan of the same week re-detects the same anomalies but they are
 * already stamped notified, so nothing re-fires.
 *
 * Three gates decide whether an anomaly actually sends:
 *   1. Severity — only notable/high reach here (the store query filters info out),
 *      so low-severity noise never pings a manager.
 *   2. Settings — the per-team `anomaly_alerts_enabled` (global default + team
 *      override) must be on. A team with alerts off is skipped and left
 *      UNNOTIFIED, so flipping the setting on later announces the still-open ones.
 *   3. Deliverability — a Slack client and at least one channel must be present.
 *      With nowhere to deliver the anomaly is left unnotified for a later run.
 *
 * Delivery is best-effort: a channel-level failure is logged, not thrown, so one
 * undeliverable alert can't abort the batch. An anomaly is stamped notified once
 * it lands in at least one channel; if every channel fails it stays unnotified
 * and is retried next sweep (a transient Slack outage self-heals).
 */

import type Database from 'better-sqlite3';
import {resolveSetting} from '../settings/store';
import type {SlackClient} from '../slack/client';
import {buildAnomalyAlertMessage} from '../slack/blocks';
import {listUnnotifiedTeamAnomalies, markAnomalyNotified} from './store';

export interface AnomalyNotifyDeps {
    db: Database.Database;
    /** Slack client; absent → nothing is deliverable and the run is a no-op. */
    slackClient?: SlackClient;
    /** Channel IDs to push alerts to; empty → nothing is deliverable. */
    channels: string[];
    /** Dashboard base URL for the alert's deep link (optional). */
    dashboardUrl?: string;
    /** Injectable clock (tests pin notified_at); defaults to wall clock. */
    now?: () => Date;
    log?: (message: string, err?: unknown) => void;
}

export interface AnomalyNotifyResult {
    /** Surfaceable, unannounced team anomalies considered this run. */
    candidates: number;
    /** Anomalies delivered to ≥1 channel and stamped notified. */
    notified: number;
    /** Skipped because the team's anomaly_alerts_enabled setting is off. */
    skippedSettings: number;
    /** Skipped because no channel/client could deliver (left for retry). */
    skippedUndeliverable: number;
}

function logErr(deps: AnomalyNotifyDeps, message: string, err?: unknown): void {
    (deps.log ?? ((m: string, e?: unknown): void => console.error(`[anomaly:notify] ${m}`, e ?? '')))(
        message,
        err,
    );
}

/**
 * Notify on every newly-detected notable/high team anomaly that hasn't been
 * announced yet, respecting the per-team alert setting and the configured
 * channels. Returns a tally suitable for a CLI/scheduler log line.
 */
export async function notifyNewAnomalies(deps: AnomalyNotifyDeps): Promise<AnomalyNotifyResult> {
    const now = deps.now ?? ((): Date => new Date());
    const candidates = listUnnotifiedTeamAnomalies(deps.db);
    const result: AnomalyNotifyResult = {
        candidates: candidates.length,
        notified: 0,
        skippedSettings: 0,
        skippedUndeliverable: 0,
    };

    const deliverable = Boolean(deps.slackClient) && deps.channels.length > 0;

    for (const anomaly of candidates) {
        // Gate 2: the team's effective alert setting (global default + override).
        if (resolveSetting(deps.db, 'anomaly_alerts_enabled', anomaly.scope_id) !== true) {
            result.skippedSettings += 1;
            continue;
        }
        // Gate 3: structurally undeliverable — leave unnotified for a later run
        // once a channel/client exists, rather than marking it announced.
        if (!deliverable || !deps.slackClient) {
            result.skippedUndeliverable += 1;
            continue;
        }

        const {text, blocks} = buildAnomalyAlertMessage(anomaly, deps.dashboardUrl);
        let deliveredToAny = false;
        for (const channel of deps.channels) {
            try {
                await deps.slackClient.postMessage(channel, text, blocks);
                deliveredToAny = true;
            } catch (err) {
                logErr(deps, `failed to post anomaly ${anomaly.id} to ${channel}`, err);
            }
        }

        if (deliveredToAny) {
            // Stamp once it lands somewhere, so a partial multi-channel failure
            // doesn't loop forever re-posting to the channels that did succeed.
            markAnomalyNotified(deps.db, anomaly.id, now().toISOString());
            result.notified += 1;
        } else {
            result.skippedUndeliverable += 1;
        }
    }

    return result;
}
