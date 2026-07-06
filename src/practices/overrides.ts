/**
 * Manual surfacing overrides — the lead-gated PIN / SUPPRESS engine (Task 6.2.6 / #161).
 *
 * Tag-based auto-surfacing (6.2.5) gets a practice next to the right metric most of
 * the time; this is the precision lever a lead reaches for when tagging gets it
 * wrong. A lead can PIN a practice to a metric — forcing it to surface there even if
 * it is not tagged with that metric — or SUPPRESS an auto-surfaced one, removing it
 * from that metric. The decisions are stored in `practice_metric_pins` (6.2.1) and
 * merged into the surfacing query by {@link surfacePractices} (6.2.5/6.2.6).
 *
 * This module owns ONE thing the 6.2.1 store deliberately does not: the AUTHORITY to
 * make an override. The store's {@link addMetricPin} is an unconditional writer (any
 * caller, any id); pin/suppress is a governance action restricted to leads/curators.
 * So the engine sits in front of the store and enforces the permission, exactly as
 * the contribution-model engine (6.2.2) sits in front of the state machine and
 * enforces "only a lead may publish/approve/endorse".
 *
 * Permission posture (identical to {@link contributionEngine}): the engine takes
 * `actorIsLead` as a SERVER-DERIVED capability, never reading roles itself and never
 * trusting client input. The caller (route/service) decides who is a lead/curator
 * (admin, team manager, …) and passes the boolean; the engine decides what that
 * capability is allowed to do. A non-lead is rejected with `not_authorized` BEFORE
 * the store is touched, so an unauthorized override never reaches the table.
 *
 * Append-only, last-write-wins: like every override write, each call appends its own
 * row; the surfacing reduction ({@link resolveCurrentMetricOverrides}) takes the
 * latest row per (contribution, metric) as the current decision, so a later pin
 * cancels an earlier suppress and vice-versa with no row deletion.
 */

import type Database from 'better-sqlite3';
import {ContributionStateError} from '../contributions/stateMachine';
import {getContribution} from '../contributions/store';
import {addMetricPin} from './store';
import type {MetricPin, MetricPinAction} from './types';

/** Stable error codes the caller maps to an HTTP status without matching message text. */
export type MetricOverrideErrorCode =
    | 'not_authorized' // the actor is not a lead/curator — pin/suppress is lead-gated
    | 'invalid_metric'; // a blank metric — an override must target a real metric

/**
 * A typed failure from the override engine's authority/validation layer. Distinct
 * from {@link ContributionStateError} (raised for a non-existent contribution), so a
 * caller can tell "you may not do this" / "that metric is blank" apart from "no such
 * practice" and map each to the right status (403 / 400 / 404).
 */
export class MetricOverrideError extends Error {
    constructor(
        readonly code: MetricOverrideErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'MetricOverrideError';
    }
}

/** Inputs for a pin/suppress override. */
export interface OverridePracticeInput {
    /** The practice being pinned/suppressed. Must reference an existing contribution. */
    contributionId: string;
    /** The metric the override targets (e.g. `churn`). Must be non-blank. */
    metric: string;
    /** The acting user — recorded as the override's `actor_id` for audit attribution. */
    actorId: string;
    /**
     * Whether the actor is a lead/curator, derived SERVER-SIDE by the caller. The
     * engine trusts this to gate the override; a client must never set it.
     */
    actorIsLead: boolean;
    /** UTC ISO timestamp for the override row; defaults to now (set by the store). */
    timestamp?: string;
}

/**
 * Validate authority, the metric, and the target's existence, then append the
 * override row. Shared by {@link pinPractice} and {@link suppressPractice} — the only
 * difference between them is the stored `action`, so the guards live once here.
 *
 * Guard order — authority → input → existence — so the most restrictive,
 * cheapest-to-check rule fires first and a non-lead learns nothing about whether a
 * given practice exists:
 *   1. `not_authorized` if the actor is not a lead/curator.
 *   2. `invalid_metric` if the metric is blank (a blank metric can never be surfaced
 *      against — {@link surfacePractices} short-circuits it — so an override on it is
 *      meaningless and is refused rather than written as a dead row).
 *   3. `not_found` (a {@link ContributionStateError}) if the contribution does not
 *      exist — a coded error rather than letting the table's FK surface a raw SQLite
 *      failure, mirroring how {@link endorsePractice} guards a missing contribution.
 *
 * The practice's lifecycle state is intentionally NOT checked here: a lead may pin a
 * practice before it is published (the intent "force this here once it is live" is
 * valid), and surfacing only ever force-surfaces PUBLISHED practices anyway, so the
 * read path — not the write — is where "published" is enforced. This keeps the
 * override a pure record of intent.
 */
function recordOverride(db: Database.Database, action: MetricPinAction, input: OverridePracticeInput): MetricPin {
    if (!input.actorIsLead) {
        throw new MetricOverrideError(
            'not_authorized',
            `Only a lead/curator may ${action} a practice for a metric.`,
        );
    }
    if (input.metric.trim() === '') {
        throw new MetricOverrideError('invalid_metric', `A non-blank metric is required to ${action} a practice.`);
    }
    if (!getContribution(db, input.contributionId)) {
        throw new ContributionStateError('not_found', `Contribution '${input.contributionId}' not found.`);
    }
    return addMetricPin(db, {
        contributionId: input.contributionId,
        metric: input.metric,
        action,
        actorId: input.actorId,
        createdAt: input.timestamp,
    });
}

/**
 * PIN a practice to a metric: force it to surface there, even when it is not tagged
 * with that metric. Lead-gated (`not_authorized` for a non-lead). Returns the stored
 * override row. Appending a pin over an existing suppress for the same
 * (contribution, metric) is how a suppress is reversed — the later row wins.
 */
export function pinPractice(db: Database.Database, input: OverridePracticeInput): MetricPin {
    return recordOverride(db, 'pin', input);
}

/**
 * SUPPRESS a practice for a metric: remove an auto-surfaced practice from that metric.
 * Lead-gated (`not_authorized` for a non-lead). Returns the stored override row.
 * Appending a suppress over an existing pin reverses the pin — the later row wins.
 */
export function suppressPractice(db: Database.Database, input: OverridePracticeInput): MetricPin {
    return recordOverride(db, 'suppress', input);
}
