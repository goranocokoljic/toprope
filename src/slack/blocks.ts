import {SELF_REPORT_TOOLS, type SelfReportTool} from '../selfreport/core';

// Identifiers shared between the form builders here and the submission parser in
// handlers.ts. Keeping them in one place avoids the form and the parser drifting
// apart (a mismatch would silently drop a field).
export const CALLBACK_LOG_SUBMIT = 'govproxy_log_submit';
export const ACTION_OPEN_LOG = 'govproxy_open_log';
export const ACTION_DISMISS_PROMPT = 'govproxy_dismiss_prompt';

export const BLOCK_TOOL = 'tool_block';
export const ACTION_TOOL = 'tool_select';
export const BLOCK_MINUTES = 'minutes_block';
export const ACTION_MINUTES = 'minutes_select';
export const BLOCK_TASK = 'task_block';
export const ACTION_TASK = 'task_input';

// Human labels for each self-reportable tool, in the order they appear in the form.
const TOOL_LABELS: Record<SelfReportTool, string> = {
    copilot: 'GitHub Copilot',
    cursor: 'Cursor',
    claude_code: 'Claude Code',
    windsurf: 'Windsurf',
    chatgpt: 'ChatGPT',
    other: 'Other',
};

// Rough-effort buttons, mapped to a representative minute value stored on the
// raw self_report. The mapping is deliberately coarse — self-reporting captures
// "did you use it, roughly how much," not precise time tracking.
export interface TimeOption {
    key: string;
    label: string;
    minutes: number;
}
export const TIME_OPTIONS: TimeOption[] = [
    {key: 'lt30', label: 'Less than 30 min', minutes: 15},
    {key: 'about1h', label: 'About 1 hour', minutes: 60},
    {key: 'half_day', label: 'About half a day', minutes: 240},
    {key: 'full_day', label: 'About a full day', minutes: 480},
];

const TIME_BY_KEY = new Map(TIME_OPTIONS.map((o) => [o.key, o]));

// Resolve a rough-time option key (from the form) to a minute value, or null for
// an unknown/absent key (the time field is optional).
export function minutesForTimeKey(key: string | undefined | null): number | null {
    if (!key) return null;
    return TIME_BY_KEY.get(key)?.minutes ?? null;
}

// A Slack Block Kit payload is an open-ended JSON object; we don't model its full
// schema (Slack's own types are large and we only emit a fixed shape).
export type SlackView = Record<string, unknown>;
export type SlackBlock = Record<string, unknown>;

/**
 * Build the modal view opened by the slash command. Tool is required; rough time
 * and task descriptor are optional. The `private_metadata` carries the usage
 * date so the submission handler doesn't have to re-derive it.
 */
export function buildLogModal(privateMetadata = ''): SlackView {
    const toolOptions = SELF_REPORT_TOOLS.map((tool) => ({
        text: {type: 'plain_text', text: TOOL_LABELS[tool]},
        value: tool,
    }));
    const timeOptions = TIME_OPTIONS.map((o) => ({
        text: {type: 'plain_text', text: o.label},
        value: o.key,
    }));

    return {
        type: 'modal',
        callback_id: CALLBACK_LOG_SUBMIT,
        private_metadata: privateMetadata,
        title: {type: 'plain_text', text: 'Log AI usage'},
        submit: {type: 'plain_text', text: 'Log it'},
        close: {type: 'plain_text', text: 'Cancel'},
        blocks: [
            {
                type: 'input',
                block_id: BLOCK_TOOL,
                label: {type: 'plain_text', text: 'Which tool did you use?'},
                element: {
                    type: 'static_select',
                    action_id: ACTION_TOOL,
                    placeholder: {type: 'plain_text', text: 'Pick a tool'},
                    options: toolOptions,
                },
            },
            {
                type: 'input',
                block_id: BLOCK_MINUTES,
                optional: true,
                label: {type: 'plain_text', text: 'Roughly how long? (optional)'},
                element: {
                    type: 'radio_buttons',
                    action_id: ACTION_MINUTES,
                    options: timeOptions,
                },
            },
            {
                type: 'input',
                block_id: BLOCK_TASK,
                optional: true,
                label: {type: 'plain_text', text: 'What were you working on? (optional, private)'},
                element: {
                    type: 'plain_text_input',
                    action_id: ACTION_TASK,
                    multiline: false,
                },
                hint: {
                    type: 'plain_text',
                    text: 'Only ever visible to you — never shared with managers or AI models.',
                },
            },
        ],
    };
}

/**
 * Build the optional daily-prompt message: a gentle nudge with a button that
 * opens the log form and a Dismiss button. Designed to be opt-in and easy to
 * ignore.
 */
export function buildDailyPromptMessage(): {text: string; blocks: SlackBlock[]} {
    return {
        text: 'Used an AI tool today? Tap to log it.',
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '*Used an AI tool today?* Logging it helps us understand and support how the team works. Takes a few taps — totally optional.',
                },
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        action_id: ACTION_OPEN_LOG,
                        style: 'primary',
                        text: {type: 'plain_text', text: 'Log AI usage'},
                    },
                    {
                        type: 'button',
                        action_id: ACTION_DISMISS_PROMPT,
                        text: {type: 'plain_text', text: 'Dismiss'},
                    },
                ],
            },
        ],
    };
}
