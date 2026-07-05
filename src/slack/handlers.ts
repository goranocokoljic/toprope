import type Database from 'better-sqlite3';
import {findBySlackUserId} from '../registry/developers';
import {createSelfReport, SelfReportError, type SnapshotOutcome} from '../selfreport/core';
import {ACTION_SURVEY_ANSWER_PREFIX, ACTION_SURVEY_DECLINE} from '../surveys/delivery';
import {declineSurvey, getSurveyById, respondToSurvey} from '../surveys/store';
import type {SlackClient} from './client';
import {
    ACTION_DISMISS_PROMPT,
    ACTION_MINUTES,
    ACTION_OPEN_LOG,
    ACTION_TASK,
    ACTION_TOOL,
    BLOCK_MINUTES,
    BLOCK_TASK,
    BLOCK_TOOL,
    buildLogModal,
    minutesForTimeKey,
} from './blocks';

// Shown whenever a Slack user with no developer mapping tries to log usage. The
// fix is an admin action (`toprope dev link --id <id> --slack <slack-user-id>`),
// so the message points the developer at their admin rather than at a self-serve
// step they can't perform.
export const UNLINKED_MESSAGE =
    "Your Slack account isn't linked to a developer profile yet, so I can't log this. " +
    'Ask your admin to link your Slack account (they can run `toprope dev link`).';

export interface SlackHandlerDeps {
    db: Database.Database;
    client: SlackClient;
    // Optional logger for best-effort side effects (confirmation DMs, etc.) that
    // must not fail the request. Defaults to console.error.
    log?: (message: string, err: unknown) => void;
}

// What the route should send back to Slack: an HTTP status and an optional JSON
// body. An empty body (the default) acknowledges the request with a 200.
export interface SlackHandlerResult {
    status: number;
    body?: unknown;
}

const ACK: SlackHandlerResult = {status: 200};

function logError(deps: SlackHandlerDeps, message: string, err: unknown): void {
    const fallback = (m: string, e: unknown): void => console.error(`[slack] ${m}`, e);
    (deps.log ?? fallback)(message, err);
}

function ephemeral(text: string): SlackHandlerResult {
    return {status: 200, body: {response_type: 'ephemeral', text}};
}

function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

// --- safe accessors over JSON.parse'd payloads (typed as unknown) -------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function getString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
    const v = obj?.[key];
    return typeof v === 'string' ? v : undefined;
}

// --- slash command ------------------------------------------------------------

// Parsed `application/x-www-form-urlencoded` body of a slash command.
export interface SlashCommandBody {
    user_id?: string;
    trigger_id?: string;
    command?: string;
    text?: string;
    response_url?: string;
}

/**
 * Handle the `/toprope-log` slash command: if the Slack user is linked to a
 * developer, open the logging modal; otherwise reply with the unlinked message.
 * Identity is the *calling* Slack user — there is no way to target anyone else.
 */
export async function handleSlashCommand(
    body: SlashCommandBody,
    deps: SlackHandlerDeps,
): Promise<SlackHandlerResult> {
    const slackUserId = body.user_id;
    const triggerId = body.trigger_id;
    if (!slackUserId || !triggerId) {
        return ephemeral("Sorry, I couldn't read that request from Slack.");
    }

    const developer = findBySlackUserId(deps.db, slackUserId);
    if (!developer) {
        return ephemeral(UNLINKED_MESSAGE);
    }

    try {
        await deps.client.openView(triggerId, buildLogModal(todayUtc()));
    } catch (err) {
        logError(deps, 'failed to open log modal', err);
        return ephemeral("Sorry, I couldn't open the logging form. Please try again.");
    }
    return ACK;
}

// --- interactivity (view_submission + block_actions) --------------------------

/**
 * Dispatch an interactivity payload (already JSON-parsed from the `payload`
 * field) to the right handler based on its `type`.
 */
export async function handleInteraction(
    payload: unknown,
    deps: SlackHandlerDeps,
): Promise<SlackHandlerResult> {
    const obj = asRecord(payload);
    if (!obj) return ACK;
    const type = getString(obj, 'type');
    if (type === 'view_submission') {
        return handleViewSubmission(obj, deps);
    }
    if (type === 'block_actions') {
        return handleBlockActions(obj, deps);
    }
    // Unknown interaction types are acknowledged so Slack doesn't retry.
    return ACK;
}

// Read the value a user selected for a given block/action out of a view's state.
function selectedOptionValue(
    state: Record<string, unknown> | undefined,
    blockId: string,
    actionId: string,
): string | undefined {
    const values = asRecord(state?.['values']);
    const block = asRecord(values?.[blockId]);
    const action = asRecord(block?.[actionId]);
    const selected = asRecord(action?.['selected_option']);
    return getString(selected, 'value');
}

function plainTextValue(
    state: Record<string, unknown> | undefined,
    blockId: string,
    actionId: string,
): string | undefined {
    const values = asRecord(state?.['values']);
    const block = asRecord(values?.[blockId]);
    const action = asRecord(block?.[actionId]);
    return getString(action, 'value');
}

function viewSubmissionError(blockId: string, message: string): SlackHandlerResult {
    // Slack renders these under the matching input block and keeps the modal open.
    return {status: 200, body: {response_action: 'errors', errors: {[blockId]: message}}};
}

/**
 * Handle a modal submission: resolve the submitting Slack user to a developer
 * and write the self-report through the 4.1 core with source_interface "slack".
 *
 * The developer id comes ONLY from the submitting user's Slack→developer mapping,
 * so a report can never be attributed to anyone but the submitter — there is no
 * field in the form that names a target developer.
 */
export async function handleViewSubmission(
    payload: Record<string, unknown>,
    deps: SlackHandlerDeps,
): Promise<SlackHandlerResult> {
    const user = asRecord(payload['user']);
    const slackUserId = getString(user, 'id');
    if (!slackUserId) {
        return viewSubmissionError(BLOCK_TOOL, "I couldn't identify your Slack account.");
    }

    const developer = findBySlackUserId(deps.db, slackUserId);
    if (!developer) {
        return viewSubmissionError(BLOCK_TOOL, UNLINKED_MESSAGE);
    }

    const view = asRecord(payload['view']);
    const state = asRecord(view?.['state']);
    const tool = selectedOptionValue(state, BLOCK_TOOL, ACTION_TOOL);
    if (!tool) {
        return viewSubmissionError(BLOCK_TOOL, 'Please pick a tool.');
    }
    const minutes = minutesForTimeKey(selectedOptionValue(state, BLOCK_MINUTES, ACTION_MINUTES));
    const task = plainTextValue(state, BLOCK_TASK, ACTION_TASK) ?? null;
    const date = getString(view, 'private_metadata') || todayUtc();

    let snapshot: SnapshotOutcome;
    try {
        const result = createSelfReport(deps.db, {
            developerId: developer.id,
            tool,
            minutes,
            taskDescriptor: task,
            date,
            sourceInterface: 'slack',
        });
        snapshot = result.snapshot;
    } catch (err) {
        if (err instanceof SelfReportError) {
            return viewSubmissionError(BLOCK_TOOL, err.message);
        }
        throw err;
    }

    // Confirmation DM is best-effort and fire-and-forget: the report is already
    // committed, and Slack expects the view_submission response within ~3s — so we
    // must NOT block the modal-closing ACK on a (possibly slow) chat.postMessage.
    const confirmation = buildConfirmationText(tool, minutes, date, snapshot);
    void deps.client
        .postMessage(slackUserId, confirmation)
        .catch((err) => logError(deps, 'failed to post confirmation DM', err));

    // Empty 200 closes the modal cleanly.
    return ACK;
}

export function buildConfirmationText(
    tool: string,
    minutes: number | null,
    date: string,
    snapshot: SnapshotOutcome,
): string {
    const effort = minutes != null ? ` (~${minutes} min)` : '';
    let text = `:white_check_mark: Logged *${tool}* usage for ${date}${effort}.`;
    if (snapshot === 'api_wins') {
        text +=
            "\nWe already have measured API data for this tool/date, so that takes precedence — " +
            'your report is kept on record but did not change the snapshot.';
    } else if (snapshot === 'already_self_report') {
        text += '\nYou were already marked active for this tool/date.';
    }
    return text;
}

/**
 * Handle a block_actions interaction from the daily-prompt message: open the log
 * modal, or dismiss (delete) the prompt.
 */
export async function handleBlockActions(
    payload: Record<string, unknown>,
    deps: SlackHandlerDeps,
): Promise<SlackHandlerResult> {
    const actions = payload['actions'];
    const first = Array.isArray(actions) ? asRecord(actions[0]) : undefined;
    const actionId = getString(first, 'action_id');
    const triggerId = getString(payload, 'trigger_id');
    const responseUrl = getString(payload, 'response_url');

    if (actionId === ACTION_OPEN_LOG && triggerId) {
        try {
            await deps.client.openView(triggerId, buildLogModal(todayUtc()));
        } catch (err) {
            logError(deps, 'failed to open log modal from prompt', err);
        }
        return ACK;
    }

    if (actionId === ACTION_DISMISS_PROMPT && responseUrl) {
        // Dismissible: delete the original prompt message so it doesn't linger.
        try {
            await deps.client.deleteMessage(responseUrl);
        } catch (err) {
            logError(deps, 'failed to dismiss prompt', err);
        }
        return ACK;
    }

    // Data-prompted survey buttons (Task 4.3): an answer choice or a decline. The
    // survey id rides in the button value; the chosen option is the action_id
    // suffix. Identity is the clicking Slack user — a developer can only answer
    // their OWN survey (enforced in respondToSurvey/declineSurvey by id).
    if (actionId && (actionId.startsWith(ACTION_SURVEY_ANSWER_PREFIX) || actionId === ACTION_SURVEY_DECLINE)) {
        const surveyId = getString(first, 'value');
        const slackUserId = getString(asRecord(payload['user']), 'id');
        await handleSurveyAction(deps, actionId, surveyId, slackUserId, responseUrl);
        return ACK;
    }

    return ACK;
}

/**
 * Apply a survey button click: resolve the clicking Slack user to a developer,
 * then record their answer or decline. All failures are logged, never thrown —
 * the interaction is best-effort and must always ACK so Slack doesn't retry. The
 * original message is updated (via response_url) to confirm and remove the now-
 * spent buttons.
 */
async function handleSurveyAction(
    deps: SlackHandlerDeps,
    actionId: string,
    surveyId: string | undefined,
    slackUserId: string | undefined,
    responseUrl: string | undefined,
): Promise<void> {
    if (!surveyId || !slackUserId) return;
    const developer = findBySlackUserId(deps.db, slackUserId);
    if (!developer) return;

    let confirmation: string | undefined;
    try {
        if (actionId === ACTION_SURVEY_DECLINE) {
            const outcome = declineSurvey(deps.db, surveyId, developer.id);
            if (outcome === 'ok') confirmation = 'Thanks — no problem at all. Marked as no answer.';
        } else {
            const choiceValue = actionId.slice(ACTION_SURVEY_ANSWER_PREFIX.length);
            const survey = getSurveyById(deps.db, surveyId);
            // Only honor the click if the survey belongs to this developer; the
            // label (for the confirmation) is looked up from the survey's choices.
            if (survey && survey.developer_id === developer.id) {
                const outcome = respondToSurvey(deps.db, surveyId, developer.id, {
                    responseChoice: choiceValue,
                });
                if (outcome === 'ok') {
                    const label = survey.choices.find((c) => c.value === choiceValue)?.label;
                    confirmation = label
                        ? `Thanks for the context — noted *${label}*.`
                        : 'Thanks for the context.';
                }
            }
        }
    } catch (err) {
        logError(deps, 'failed to record survey action', err);
        return;
    }

    // Replace the original message so the buttons can't be clicked twice.
    if (confirmation && responseUrl) {
        try {
            await deps.client.replaceMessage(responseUrl, confirmation);
        } catch (err) {
            logError(deps, 'failed to confirm survey response', err);
        }
    }
}
