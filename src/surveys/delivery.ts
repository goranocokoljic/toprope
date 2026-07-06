/**
 * Survey delivery rendering (Task 4.3 / #98).
 *
 * Builds the Slack message (interactive: one button per tap-to-answer choice,
 * plus a Decline button) and the plain-text email fallback for a survey. The
 * actual transport (SlackClient / Emailer) is invoked by dispatch.ts — this
 * module only shapes the payloads, so it's pure and unit-testable.
 */
import type {SlackBlock} from '../slack/blocks';
import type {Emailer} from './email';
import type {SurveyRecord} from './types';

// Slack action ids. Each answer button is `survey_answer:<choiceValue>` (unique
// within the actions block, and self-describing so the handler reads the choice
// straight off the action_id); the survey id rides in the button `value`.
export const ACTION_SURVEY_ANSWER_PREFIX = 'toprope_survey_answer:';
export const ACTION_SURVEY_DECLINE = 'toprope_survey_decline';

// Slack caps button text at 75 chars; keep choice labels safe.
function truncate(text: string, max = 75): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Build the Slack message for a survey: a section with the question, an actions
 * row of choice buttons, and a Decline button. The intro line keeps the framing
 * voluntary ("totally optional").
 */
export function buildSurveyMessage(survey: SurveyRecord): {text: string; blocks: SlackBlock[]} {
    const answerButtons: SlackBlock[] = survey.choices.map((choice) => ({
        type: 'button',
        action_id: `${ACTION_SURVEY_ANSWER_PREFIX}${choice.value}`,
        text: {type: 'plain_text', text: truncate(choice.label)},
        value: survey.id,
    }));

    answerButtons.push({
        type: 'button',
        action_id: ACTION_SURVEY_DECLINE,
        text: {type: 'plain_text', text: 'Prefer not to say'},
        value: survey.id,
    });

    return {
        text: survey.question_text,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${survey.question_text}\n\n_Totally optional — your answer just adds helpful context._`,
                },
            },
            {type: 'actions', elements: answerButtons},
        ],
    };
}

/**
 * Build the plain-text email fallback. Lists the choices as a simple menu and
 * tells the developer how to respond (via the dashboard) — and that it's
 * voluntary.
 */
export function buildSurveyEmail(survey: SurveyRecord): {subject: string; body: string} {
    const lines: string[] = [survey.question_text, ''];
    if (survey.choices.length > 0) {
        for (const choice of survey.choices) {
            lines.push(`  • ${choice.label}`);
        }
        lines.push('');
    }
    lines.push(
        'This quick check-in is voluntary — you can answer (or decline) from your Toprope dashboard.',
    );
    return {subject: 'A quick question about your AI tooling', body: lines.join('\n')};
}

/** Send a survey by email via the injected Emailer. */
export async function deliverSurveyByEmail(
    emailer: Emailer,
    to: string,
    survey: SurveyRecord,
): Promise<void> {
    const {subject, body} = buildSurveyEmail(survey);
    await emailer.sendEmail({to, subject, body});
}
