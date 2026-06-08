/**
 * Question templates per trigger type (Task 4.3 / #98).
 *
 * Each template turns an observed condition into a concise, respectful question
 * with a few tap-to-answer choices plus an "other" escape hatch for free text.
 * The framing is deliberately curious, not accusatory — surveys are about
 * understanding, not interrogation. Every template offers a neutral, blameless
 * set of explanations and never implies the developer did anything wrong.
 */
import type {SurveyChoice, SurveyQuestion, SurveyTriggerType} from './types';

// Human labels for tool slugs, so questions read naturally ("GitHub Copilot"
// rather than "copilot"). Unknown tools fall back to the raw slug.
const TOOL_LABELS: Record<string, string> = {
    copilot: 'GitHub Copilot',
    cursor: 'Cursor',
    claude_code: 'Claude Code',
    windsurf: 'Windsurf',
    chatgpt: 'ChatGPT',
};

function toolLabel(tool: unknown): string {
    if (typeof tool !== 'string' || tool.length === 0) return 'an AI tool';
    return TOOL_LABELS[tool] ?? tool;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Choices shared by most templates: the survey is voluntary, and "something
// else" lets the developer add free-text context instead of picking a bucket.
const SWITCHED_TOOL: SurveyChoice = {value: 'switched_tool', label: 'I switched to a different tool'};
const LESS_AI: SurveyChoice = {value: 'less_ai', label: 'I used AI less this period'};
const WORK_CHANGED: SurveyChoice = {value: 'work_changed', label: 'My work changed (less coding, leave, etc.)'};
const OTHER: SurveyChoice = {value: 'other', label: 'Something else (add a note)'};

/**
 * Build the question + choices for a survey of the given trigger type, using the
 * observed context (deltas, tool names, day counts). Falls back to a generic but
 * still respectful prompt when context fields are missing, so a survey is never
 * un-renderable.
 */
export function buildSurveyQuestion(
    triggerType: SurveyTriggerType,
    context: Record<string, unknown> = {},
): SurveyQuestion {
    switch (triggerType) {
        case 'usage_drop':
            return usageDropQuestion(context);
        case 'unused_new_seat':
            return unusedNewSeatQuestion(context);
        case 'plan_change':
            return planChangeQuestion(context);
        case 'anomaly':
            return anomalyQuestion(context);
        case 'manual':
            return manualQuestion(context);
        default:
            // Exhaustive over SurveyTriggerType; a future type lands here.
            return {
                questionText: "We'd love a little context on your recent AI tool usage — anything to share?",
                choices: [OTHER],
            };
    }
}

function usageDropQuestion(context: Record<string, unknown>): SurveyQuestion {
    const tool = toolLabel(context.tool);
    const dropPct = asNumber(context.drop_pct);
    const magnitude =
        dropPct !== undefined ? `dropped about ${Math.round(Math.abs(dropPct))}%` : 'dropped recently';
    return {
        questionText:
            `We noticed your ${tool} usage ${magnitude} compared with the previous period. ` +
            'No problem at all — we just want to keep the picture accurate. What best describes it?',
        choices: [SWITCHED_TOOL, LESS_AI, WORK_CHANGED, OTHER],
    };
}

function unusedNewSeatQuestion(context: Record<string, unknown>): SurveyQuestion {
    const tool = toolLabel(context.tool);
    const days = asNumber(context.days_unused);
    const window = days !== undefined ? ` for about ${Math.round(days)} days` : '';
    return {
        questionText:
            `You have a ${tool} seat that hasn't shown any activity${window}. ` +
            'Want to keep it? Letting us know helps us right-size licences (and free up budget).',
        choices: [
            {value: 'still_need', label: "I'm using it / still need it"},
            {value: 'not_set_up', label: "I haven't set it up yet"},
            {value: 'prefer_other', label: 'I prefer a different tool'},
            {value: 'dont_need', label: "I don't need it — feel free to reclaim"},
            OTHER,
        ],
    };
}

function planChangeQuestion(context: Record<string, unknown>): SurveyQuestion {
    const tool = toolLabel(context.tool);
    const oldTool = asString(context.old_tool);
    const lead = oldTool
        ? `We saw you moved from ${toolLabel(oldTool)} to ${tool}.`
        : `We saw a change to your ${tool} plan.`;
    return {
        questionText:
            `${lead} How's it going so far? Your take helps us understand whether the change is paying off.`,
        choices: [
            {value: 'better', label: 'Working better for me'},
            {value: 'about_same', label: 'About the same'},
            {value: 'worse', label: 'Not as good as before'},
            {value: 'too_early', label: 'Too early to tell'},
            OTHER,
        ],
    };
}

function anomalyQuestion(context: Record<string, unknown>): SurveyQuestion {
    const metric = asString(context.metric) ?? 'one of your activity signals';
    return {
        questionText:
            `We spotted an unusual change in ${metric} recently. ` +
            'Nothing to worry about — is there context that would help us read it correctly?',
        choices: [
            {value: 'expected', label: 'Expected — there was a reason'},
            {value: 'data_looks_off', label: 'That data looks off to me'},
            {value: 'no_change', label: "Nothing changed on my end"},
            OTHER,
        ],
    };
}

function manualQuestion(context: Record<string, unknown>): SurveyQuestion {
    // A manager-authored question rides in context.question_text; choices, if
    // supplied, are validated by the caller. Fall back to a neutral default.
    const questionText =
        asString(context.question_text) ?? "Your manager would like a little context on your AI tool usage.";
    const rawChoices = Array.isArray(context.choices) ? context.choices : [];
    const choices: SurveyChoice[] = [];
    for (const c of rawChoices) {
        if (c && typeof c === 'object') {
            const value = asString((c as Record<string, unknown>).value);
            const label = asString((c as Record<string, unknown>).label);
            if (value && label) choices.push({value, label});
        }
    }
    return {questionText, choices: choices.length > 0 ? choices : [OTHER]};
}
