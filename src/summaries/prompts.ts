/**
 * Tier-aware prompt templates (Task 3.8 / #77).
 *
 * THE critical Phase 3 discipline. The summaries are produced from a numbers-only
 * payload (built by the input-builder, Task 3.7) that, at launch, carries only
 * git-derived signals + expense data — direct tool-usage connectors (Copilot /
 * Claude Code / Windsurf) are not yet connected, so those fields are null. The
 * model writing the narrative must therefore NEVER invent direct-usage language
 * ("acceptance rate," "interactions," "suggestions accepted," …) that the data
 * doesn't contain, must describe git signals honestly as such, and must carry the
 * `data_basis` into the prose so a reader knows the numbers are estimates from git
 * activity rather than measured tool usage.
 *
 * Two things live here:
 *
 *   1. The prompt builder (`buildSummaryPrompt`) — a shared preamble enforcing the
 *      tier-aware + privacy + framing rules, concatenated with a per-level block
 *      (audience, length, focus) and the numbers-only input block from the
 *      input-builder. The preamble's wording is tier-aware: for a git-only period
 *      it states plainly that direct tool usage is not connected and forbids the
 *      direct-usage vocabulary outright; once a period is backed by measured/mixed
 *      tool data those terms become permissible because the fields then exist.
 *
 *   2. An output guard (`findFabricatedUsageLanguage` / `assertNoFabricatedUsageLanguage`).
 *      The prompt is a soft instruction to a model; the guard is the hard check.
 *      It scans generated text for the forbidden direct-usage vocabulary and, for a
 *      git-only payload, flags any occurrence. This is the deterministic backbone of
 *      the adversarial test (a mocked model lets us assert stably) and a guard the
 *      generator (Task 3.9) can run on real model output before storing a summary.
 */

import type {SummaryInputPayload} from './input-builder';
import {formatSummaryInput} from './input-builder';

/** The four summary levels, re-exported via the payload's `period.level`. */
export type {SummaryLevel} from './model-client';

/** Optional knobs for one prompt render (the regeneration path, Task 3.9). */
export interface PromptOptions {
    /**
     * Regeneration focus, e.g. "cost" or "seat optimization". Steers which present
     * metrics the narrative emphasises — it never relaxes the tier/privacy
     * constraints and never licenses describing data the payload doesn't contain.
     */
    focus?: string;
}

/**
 * The direct-tool-usage vocabulary the narrative must NOT use for a git-only
 * period. These describe measured interactions with an AI tool (Copilot/Claude
 * Code/Windsurf), which the git-derived payload does not contain. Whole-word /
 * phrase matched, case-insensitive, by the output guard. Kept deliberately tight:
 * each entry is unambiguously a direct-usage metric, so a legitimate git-signal
 * narrative ("commit activity," "merged PRs," "estimated AI-assistance signal")
 * never trips it.
 */
export const FABRICATED_USAGE_TERMS: readonly string[] = [
    'acceptance rate',
    'suggestions accepted',
    'suggestion accepted',
    'suggestion acceptance',
    'completions accepted',
    'completion acceptance',
    'lines accepted',
    'lines of code accepted',
    'tab acceptance',
    'prompts accepted',
    'interactions',
    'interaction count',
    'active usage',
    'usage minutes',
    'tool sessions',
    'chat sessions',
    'messages sent',
];

/**
 * `git_estimate` is the launch state — purely git + expense derived, no direct
 * usage at all — so the preamble gets the strongest "direct tool usage is NOT
 * connected" wording. (`mixed`/`measured` get softer wording; see
 * `directUsageSubstantiated`.)
 */
export function isGitOnly(payload: SummaryInputPayload): boolean {
    return payload.metrics.ai_maturity_basis === 'git_estimate';
}

/**
 * Whether direct-tool-usage vocabulary is substantiated by the payload — the
 * gate for both the preamble's relaxed wording and the output guard. Keyed on the
 * maturity basis: only `measured` (fully backed by direct tool data) substantiates
 * those terms. `git_estimate` clearly does not, and crucially neither does `mixed`
 * — "partial direct tool usage" means some figures are still git-inferred, and the
 * numbers-only payload carries NO per-tool direct-usage fields to tell which is
 * which, so a "mixed" period cannot honestly use "acceptance rate" about any given
 * number. Lumping `mixed` in with `measured` would silently switch the guard off
 * while fabrication is still possible; this keeps the guard on for everything but
 * a fully-measured period. (When per-tool fields are added to the payload, this
 * can become per-field nullness-aware.)
 */
export function directUsageSubstantiated(payload: SummaryInputPayload): boolean {
    return payload.metrics.ai_maturity_basis === 'measured';
}

/** Per-level briefing: audience, target length/depth, and the level's emphasis. */
interface LevelBrief {
    /** Who the narrative is written for. */
    audience: string;
    /** Target length/depth, stated to the model so output scales with the level. */
    targetLength: string;
    /** What this level should foreground. */
    focus: string;
}

/**
 * The four per-level templates. Length/depth scales with the level (weekly is two
 * short paragraphs for a manager; yearly is a full board-facing narrative), and
 * the emphasis shifts from operational (weekly) to investment-vs-return (quarterly)
 * to the year's adoption journey (yearly). Exported so tests can assert each level
 * is distinct and targets the intended depth.
 */
export const LEVEL_BRIEFS: Readonly<Record<SummaryInputPayload['period']['level'], LevelBrief>> = {
    weekly: {
        audience: 'the team manager',
        targetLength:
            'about two short paragraphs — tight and skimmable, the kind of update a manager reads Monday morning',
        focus:
            'operational focus: who was active, the notable changes versus the prior week, and one or two concrete ' +
            'action prompts (e.g. a check-in with an inactive developer). Keep it practical, not strategic.',
    },
    monthly: {
        audience: 'a department head',
        targetLength: 'about one page',
        focus:
            'trend focus: how output and the git-based AI-assistance estimate moved over the month, cost efficiency ' +
            '(cost per merged PR versus the org average), and any seat-optimization candidates (active seats with no ' +
            'activity worth a waste review). Note month-over-month direction where deltas are present.',
    },
    quarterly: {
        audience: 'VP / leadership',
        targetLength: 'about two to three pages',
        focus:
            'investment-versus-return framing: what the AI spend bought in git-observable output over the quarter, the ' +
            'movement of the AI maturity score and the basis it rests on, cost-efficiency trend, and strategic ' +
            'recommendations. Be analytical about where the estimate is strong and where it is still git-inferred.',
    },
    yearly: {
        audience: 'the board / annual review',
        targetLength: 'a full narrative — the longest and most complete of the four levels',
        focus:
            "the year's adoption journey: how the picture changed across the year, ROI framing for the AI spend against " +
            'git-observable output, the maturity-score arc and its basis, and forward recommendations for the next year. ' +
            'Tell the story of the year while staying strictly within the numbers provided.',
    },
};

/**
 * The shared preamble: the tier-aware + privacy + framing rules every level obeys,
 * before any level-specific instruction. Tier-aware by construction — the
 * direct-usage clause is phrased for the period's actual basis, so a git-only
 * period gets an explicit "direct tool usage is not connected" statement and an
 * outright ban on the direct-usage vocabulary, while a measured/mixed period is
 * told it may reference those metrics because the fields then exist.
 */
function buildPreamble(payload: SummaryInputPayload): string {
    // The first sentence is tier-specific; the ban that follows is identical for
    // every tier that doesn't fully substantiate direct usage (git_estimate AND
    // mixed), because the payload carries no per-tool direct-usage fields either way.
    let usageClause: string;
    if (directUsageSubstantiated(payload)) {
        usageClause = [
            `The numbers are derived from ${payload.data_basis}.`,
            'Where direct tool-usage metrics are present in the input, you may describe them as measured; where a',
            'figure is git-derived, describe it as such ("commit activity," "merged PRs," "code churn," "estimated',
            'AI-assistance signal"). Never imply a measurement the input does not contain.',
        ].join('\n');
    } else {
        const lead = isGitOnly(payload)
            ? `Direct tool-usage data is NOT connected for this period. The numbers are derived from ${payload.data_basis}.`
            : `Direct tool-usage data is only PARTIALLY connected for this period, and this payload carries only ` +
              `aggregate git-derived numbers (${payload.data_basis}) — no per-tool usage figure you could cite.`;
        usageClause = [
            lead,
            'You MUST NOT use the words or concepts "acceptance rate," "interactions," "suggestions accepted," or any',
            'other direct-tool-usage metric. Those describe measured interactions with an AI tool, which this data',
            'does not contain. Refer instead to git-derived signals as exactly what they are: "commit activity,"',
            '"merged PRs," "code churn," and the "estimated AI-assistance signal." Do not imply that any figure was',
            'measured directly from an AI tool.',
        ].join('\n');
    }

    return [
        'You are GovProxy, an AI-adoption analyst. You write a clear, factual narrative from the aggregate metrics',
        'provided below. Your voice is concise, analytical, and review-oriented — an internal review, never marketing',
        'copy and never a performance judgement.',
        '',
        'Hard rules — follow every one:',
        '',
        '1. DESCRIBE ONLY THE NUMBERS PROVIDED. Every figure in your narrative must come from the input block below.',
        '   Do not invent, estimate, or extrapolate any metric that is not present. A field shown as "n/a" is not',
        '   available — say nothing that implies a value for it.',
        '',
        `2. ${usageClause.split('\n').join('\n   ')}`,
        '',
        '3. CARRY THE DATA BASIS INTO THE NARRATIVE. State at least once, in plain language, what the numbers are based',
        `   on (the input gives it as: "${payload.data_basis}"). For a git-based period, make clear these are estimates`,
        "   from git activity since direct tool usage isn't yet connected.",
        '',
        '4. DELTAS ONLY WHEN PRESENT. State a change versus the prior period only where the input shows one. If the input',
        '   marks this as the first period for the scope, say "first period — no prior comparison" rather than inventing',
        '   a baseline or a percentage.',
        '',
        '5. FRAME AS REVIEW AND INSIGHT, NEVER JUDGEMENT OF INDIVIDUALS. Work in aggregate. You may mention a specific',
        '   developer ONLY for a neutral, factual, actionable reason (e.g. "inactive 5 days — worth a check-in"). Never',
        '   describe any individual evaluatively, comparatively, or negatively.',
        '',
        '6. STAY IN THE CONCISE ANALYTICAL VOICE. No hype, no filler, no recommendations unsupported by the numbers.',
    ].join('\n');
}

/** Build the per-level instruction block from the level's brief. */
function buildLevelBlock(payload: SummaryInputPayload, options?: PromptOptions): string {
    const level = payload.period.level;
    const brief = LEVEL_BRIEFS[level];
    const lines = [
        `This is the ${level.toUpperCase()} summary, written for ${brief.audience}.`,
        `Length: ${brief.targetLength}.`,
        `Emphasis: ${brief.focus}`,
    ];
    const focus = options?.focus?.trim();
    if (focus) {
        // Regeneration focus (Task 3.9): steer emphasis among the present metrics
        // only — it can never license describing data the payload lacks.
        lines.push(
            `Additional requested focus for this regeneration: ${focus}. Emphasise this where the provided numbers ` +
                'support it, but do not introduce any metric that is not in the input below.',
        );
    }
    return lines.join('\n');
}

/**
 * Assemble the full prompt for one summary: the shared tier-aware preamble, the
 * per-level instruction block, and the numbers-only input block (from the
 * input-builder). The input block is numbers-only by construction — it is rendered
 * from the typed payload, so there is no path for repo free text into the prompt.
 */
export function buildSummaryPrompt(payload: SummaryInputPayload, options?: PromptOptions): string {
    return [
        buildPreamble(payload),
        '',
        buildLevelBlock(payload, options),
        '',
        'Input metrics (the only data you may use):',
        '',
        formatSummaryInput(payload),
        '',
        'Write the summary now.',
    ].join('\n');
}

/**
 * Build a whole-word/phrase, case-insensitive matcher for one forbidden term.
 * Word boundaries (`\b`) keep "interactions" from matching inside an unrelated
 * longer word and keep matching insensitive to surrounding punctuation. The space
 * between words of a multi-word phrase is compiled as `\s+`, not a literal single
 * space, so a phrase the model line-wraps, double-spaces, or joins with a
 * non-breaking space ("the acceptance\nrate climbed") still matches — multi-page
 * narratives wrap mid-phrase routinely, and a literal-space match would let those
 * slip through.
 */
function termPattern(term: string): RegExp {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');
    return new RegExp(`\\b${escaped}\\b`, 'i');
}

const TERM_PATTERNS: ReadonlyArray<{term: string; pattern: RegExp}> = FABRICATED_USAGE_TERMS.map((term) => ({
    term,
    pattern: termPattern(term),
}));

/**
 * Scan generated narrative for fabricated direct-usage language. Returns the list
 * of forbidden terms found (empty = clean). Every term in `FABRICATED_USAGE_TERMS`
 * is forbidden unless the period fully substantiates direct usage
 * (`directUsageSubstantiated`, i.e. the `measured` tier) — so git_estimate AND
 * mixed periods are scanned, and only a fully-measured period is exempt.
 *
 * This is a BACKSTOP, not a guarantee. It is a fixed-phrase blocklist (fail-open):
 * a model that paraphrases ("accepted 34% of suggestions," "adoption rate") emits
 * fabrication this scan never sees. The real control is the prompt; this is a
 * deterministic tripwire that catches the catalogued phrasings and anchors the
 * adversarial test. A clean result means "no known forbidden phrase," NOT "verified
 * compliant" — callers (the generator, Task 3.9) must treat it that way.
 */
export function findFabricatedUsageLanguage(text: string, payload: SummaryInputPayload): string[] {
    if (directUsageSubstantiated(payload)) return [];
    const found: string[] = [];
    for (const {term, pattern} of TERM_PATTERNS) {
        if (pattern.test(text)) found.push(term);
    }
    return found;
}

/**
 * Throwing form of {@link findFabricatedUsageLanguage}. Used as a hard gate on
 * model output before a summary for a non-measured period is stored — a violation
 * means the model ignored the prompt's tier constraint and the text must not be
 * persisted as-is. (Like the underlying scan, this is a tripwire for known phrasings,
 * not proof of compliance.)
 */
export function assertNoFabricatedUsageLanguage(text: string, payload: SummaryInputPayload): void {
    const found = findFabricatedUsageLanguage(text, payload);
    if (found.length > 0) {
        throw new Error(
            `Generated ${payload.period.level} summary for ${payload.scope.name} contains fabricated direct-usage ` +
                `language not supported by the ${payload.data_basis} data: ${found.map((t) => `"${t}"`).join(', ')}`,
        );
    }
}
