/**
 * Survey dispatch (Task 4.3 / #98).
 *
 * Ties detection, templates, persistence, settings, and delivery together:
 *   - createAndDispatch: turn a trigger candidate into a survey, then auto-send
 *     or leave queued per the trigger type's setting (global + per-team override)
 *   - sendSurvey: deliver a queued survey — Slack preferred, email fallback —
 *     and mark it sent (used by the auto path AND by a manager approving a
 *     queued manual survey)
 *   - createManualSurvey: a manager-authored survey (always queued for sending)
 *   - runTriggerSweep: detect everything and dispatch each, with dedup
 *
 * Delivery is best-effort: a Slack/email failure is reported, never thrown out
 * of a sweep, so one undeliverable survey can't abort the batch.
 */
import type Database from 'better-sqlite3';
import type {Developer} from '../registry/types';
import {getDeveloperById} from '../registry/developers';
import {resolveSetting} from '../settings/store';
import {createSlackClient, type SlackClient} from '../slack/client';
import type {GovProxyConfig} from '../config/types';
import {buildSurveyMessage, deliverSurveyByEmail} from './delivery';
import {createLogEmailer, type Emailer} from './email';
import {
    createSurvey,
    getSurveyById,
    hasRecentOpenSurvey,
    listSurveys,
    markSurveySent,
} from './store';
import {buildSurveyQuestion} from './templates';
import type {SurveyTriggerCandidate, TriggerDetectionOptions} from './triggers';
import {detectAllTriggers} from './triggers';
import {
    type AutomatedTriggerType,
    type SurveyChoice,
    type SurveyDelivery,
    type SurveyRecord,
    type SurveyTriggerType,
} from './types';

export interface DispatchDeps {
    db: Database.Database;
    // Slack bot client (Task 4.2). Absent when Slack isn't configured — delivery
    // then falls back to email.
    slackClient?: SlackClient;
    // Email fallback transport. Absent → email delivery is unavailable.
    emailer?: Emailer;
    log?: (message: string, err?: unknown) => void;
}

function logErr(deps: DispatchDeps, message: string, err?: unknown): void {
    (deps.log ?? ((m, e) => console.error(`[surveys] ${m}`, e ?? '')))(message, err);
}

// Delivery deps minus the DB handle — the part wiring sites (server/CLI/
// scheduler) construct from config or inject for tests.
export type SurveyDispatchOverrides = Omit<DispatchDeps, 'db'>;

/**
 * The Slack client for survey delivery, derived from config: a real client only
 * when the bot is enabled with a token, otherwise undefined (delivery then falls
 * back to email). One place for this conditional so the server, CLI, and
 * scheduler don't each re-derive it.
 */
export function surveySlackClientFromConfig(config: GovProxyConfig): SlackClient | undefined {
    return config.slack?.enabled && config.slack.bot_token
        ? createSlackClient(config.slack.bot_token)
        : undefined;
}

/**
 * Build the full dispatch deps for a given DB + config, applying any test/wiring
 * overrides. Slack from config (unless overridden), the logging emailer as the
 * email fallback (unless overridden). Shared by the CLI and the scheduler; the
 * server reuses the override shape directly for its route registration.
 */
export function buildSurveyDispatchDeps(
    db: Database.Database,
    config: GovProxyConfig,
    overrides: SurveyDispatchOverrides = {},
): DispatchDeps {
    return {
        db,
        slackClient: overrides.slackClient ?? surveySlackClientFromConfig(config),
        emailer: overrides.emailer ?? createLogEmailer(),
        log: overrides.log,
    };
}

// Resolve the auto-send setting for a trigger type + team. Settings only exist
// for the automated trigger types; anything else (manual) is never auto-sent.
export function isAutoSend(
    db: Database.Database,
    triggerType: SurveyTriggerType,
    team?: string | null,
): boolean {
    if (!isAutomatedTriggerType(triggerType)) return false;
    return resolveSetting(db, `survey_${triggerType}_auto`, team) === true;
}

function isAutomatedTriggerType(t: SurveyTriggerType): t is AutomatedTriggerType {
    return t === 'usage_drop' || t === 'unused_new_seat' || t === 'plan_change' || t === 'anomaly';
}

export type SendResult =
    | {delivered: true; delivery: SurveyDelivery}
    | {delivered: false; reason: 'not_queued' | 'undeliverable' | 'developer_missing'};

/**
 * Deliver a queued survey to its developer. Slack is preferred (the developer
 * gets an interactive prompt); email is the fallback when there's no linked
 * Slack id or no Slack client. On success the survey is marked sent with the
 * channel used. A survey that isn't queued, or can't be delivered anywhere, is
 * left untouched and reported.
 */
export async function sendSurvey(deps: DispatchDeps, surveyId: string): Promise<SendResult> {
    const survey = getSurveyById(deps.db, surveyId);
    if (!survey) return {delivered: false, reason: 'not_queued'};
    if (survey.status !== 'queued') return {delivered: false, reason: 'not_queued'};

    const developer = getDeveloperById(deps.db, survey.developer_id);
    if (!developer) return {delivered: false, reason: 'developer_missing'};

    const slackUserId = developer.external_ids.slack;
    if (slackUserId && deps.slackClient) {
        const {text, blocks} = buildSurveyMessage(survey);
        try {
            await deps.slackClient.postMessage(slackUserId, text, blocks);
            // Only flip status after a confirmed delivery, so a failed send leaves
            // the survey queued for retry rather than silently "sent". markSurveySent
            // is status-guarded; if it returns false a concurrent send already
            // claimed this survey, so report that rather than a second success.
            if (!markSurveySent(deps.db, survey.id, 'slack')) {
                return {delivered: false, reason: 'not_queued'};
            }
            return {delivered: true, delivery: 'slack'};
        } catch (err) {
            logErr(deps, `Slack delivery failed for survey ${survey.id}; trying email`, err);
            // fall through to email
        }
    }

    if (developer.email && deps.emailer) {
        try {
            await deliverSurveyByEmail(deps.emailer, developer.email, survey);
            if (!markSurveySent(deps.db, survey.id, 'email')) {
                return {delivered: false, reason: 'not_queued'};
            }
            return {delivered: true, delivery: 'email'};
        } catch (err) {
            logErr(deps, `Email delivery failed for survey ${survey.id}`, err);
            return {delivered: false, reason: 'undeliverable'};
        }
    }

    // No channel could deliver. Log it so a stranded survey leaves a trace
    // (otherwise an auto-send that never reaches the developer is invisible).
    logErr(deps, `Survey ${survey.id} is undeliverable (no Slack id and no email/emailer); left queued`);
    return {delivered: false, reason: 'undeliverable'};
}

/**
 * Whether a survey could be delivered to this developer with the given deps —
 * i.e. there is at least one usable channel (a linked Slack id + a Slack client,
 * or an email + an emailer). Used to skip the auto-retry for surveys that are
 * *structurally* undeliverable (no channel at all), so they aren't re-attempted
 * and re-error-logged on every sweep. A transient channel failure is different —
 * the channel exists, so such a survey is still retried.
 */
function hasDeliverableChannel(deps: DispatchDeps, developer: Developer): boolean {
    if (developer.external_ids.slack && deps.slackClient) return true;
    if (developer.email && deps.emailer) return true;
    return false;
}

/**
 * Re-attempt delivery of surveys that are still queued but should have
 * auto-sent — i.e. an automated-trigger survey whose team setting is auto, left
 * queued by a prior failed/undeliverable send. This is what lets a transient
 * Slack/email outage self-heal on the next sweep instead of stranding the survey
 * forever (it would otherwise be deduped, never recreated, and never retried).
 * Manual surveys are skipped: they wait for an explicit manager send.
 */
export async function resendStrandedAutoSurveys(
    deps: DispatchDeps,
): Promise<{retried: number; recovered: number}> {
    let retried = 0;
    let recovered = 0;
    for (const survey of listSurveys(deps.db, {status: 'queued'})) {
        if (!isAutomatedTriggerType(survey.trigger_type as SurveyTriggerType)) continue;
        if (!isAutoSend(deps.db, survey.trigger_type as SurveyTriggerType, survey.team)) continue;
        // Skip surveys with no usable channel: retrying can't help until the
        // developer is linked, so re-attempting (and re-error-logging) them every
        // sweep would just be noise. They wait, untouched, for a manager send or
        // for the developer to gain a channel. Only genuinely retryable surveys
        // (a real channel that transiently failed) are re-sent here.
        const developer = getDeveloperById(deps.db, survey.developer_id);
        if (!developer || !hasDeliverableChannel(deps, developer)) continue;
        retried++;
        const result = await sendSurvey(deps, survey.id);
        if (result.delivered) recovered++;
    }
    return {retried, recovered};
}

export type DispatchResult =
    | {created: true; survey: SurveyRecord; dispatched: boolean; send?: SendResult}
    | {created: false; reason: 'duplicate' | 'developer_missing'};

export interface CreateAndDispatchOptions {
    // Skip creating if an open survey for this developer+trigger already exists
    // since this ISO timestamp. Defaults to 30 days ago. `manual` is never deduped.
    dedupSince?: string;
}

/**
 * Create a survey from a trigger candidate and dispatch it per the trigger's
 * auto/manual setting. Auto → delivered immediately; manual → left queued for a
 * manager. Deduped against a recent open survey for the same developer+trigger.
 */
export async function createAndDispatch(
    deps: DispatchDeps,
    candidate: SurveyTriggerCandidate,
    options: CreateAndDispatchOptions = {},
): Promise<DispatchResult> {
    const developer = getDeveloperById(deps.db, candidate.developerId);
    if (!developer) return {created: false, reason: 'developer_missing'};

    const since = options.dedupSince ?? thirtyDaysAgoIso();
    if (
        candidate.triggerType !== 'manual' &&
        hasRecentOpenSurvey(deps.db, candidate.developerId, candidate.triggerType, since)
    ) {
        return {created: false, reason: 'duplicate'};
    }

    const question = buildSurveyQuestion(candidate.triggerType, candidate.triggerContext);
    const survey = createSurvey(deps.db, {
        developerId: candidate.developerId,
        triggerType: candidate.triggerType,
        triggerContext: candidate.triggerContext,
        question,
    });

    if (!isAutoSend(deps.db, candidate.triggerType, candidate.team)) {
        // Manual (or auto-send off): hold in the queue for manager approval.
        return {created: true, survey, dispatched: false};
    }

    const send = await sendSurvey(deps, survey.id);
    return {created: true, survey, dispatched: send.delivered, send};
}

export interface ManualSurveyInput {
    developerId: string;
    questionText: string;
    choices?: SurveyChoice[];
}

/**
 * Create a manager-authored manual survey (always queued — the manager sends it
 * via the approval flow). Returns the created survey, or null if the developer
 * doesn't exist.
 */
export function createManualSurvey(
    db: Database.Database,
    input: ManualSurveyInput,
): SurveyRecord | null {
    if (!getDeveloperById(db, input.developerId)) return null;
    const question = buildSurveyQuestion('manual', {
        question_text: input.questionText,
        choices: input.choices,
    });
    return createSurvey(db, {
        developerId: input.developerId,
        triggerType: 'manual',
        triggerContext: {authored: 'manual'},
        question,
    });
}

export interface SweepSummary {
    candidates: number;
    created: number;
    autoSent: number;
    queued: number;
    duplicates: number;
    undeliverable: number;
    // Stranded auto-surveys re-attempted this sweep, and how many of those
    // finally went out (a transient outage self-healing).
    retried: number;
    recovered: number;
}

/**
 * Detect every data-backed trigger and dispatch each candidate, then re-attempt
 * any auto-surveys still stranded in the queue from a prior failed send. Returns
 * a summary suitable for a CLI/scheduler report. Anomaly triggers are not
 * included (their source, Task 4.7, isn't built — see triggers.ts).
 */
export async function runTriggerSweep(
    deps: DispatchDeps,
    options: TriggerDetectionOptions & CreateAndDispatchOptions = {},
): Promise<SweepSummary> {
    // Retry stranded auto-surveys first, so a candidate deduped against an
    // existing queued survey doesn't mask that the survey never actually sent.
    const {retried, recovered} = await resendStrandedAutoSurveys(deps);
    const candidates = detectAllTriggers(deps.db, options);
    const summary: SweepSummary = {
        candidates: candidates.length,
        created: 0,
        autoSent: 0,
        queued: 0,
        duplicates: 0,
        undeliverable: 0,
        retried,
        recovered,
    };

    for (const candidate of candidates) {
        const result = await createAndDispatch(deps, candidate, options);
        if (!result.created) {
            if (result.reason === 'duplicate') summary.duplicates++;
            continue;
        }
        summary.created++;
        if (result.dispatched) {
            summary.autoSent++;
        } else if (result.send && !result.send.delivered) {
            // auto-send was on but delivery failed → still queued, flag it
            summary.undeliverable++;
            summary.queued++;
        } else {
            summary.queued++;
        }
    }

    return summary;
}

function thirtyDaysAgoIso(): string {
    return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}
