/**
 * Optional AI prompt-technique annotation for a showcase (Task 6.3.7 / #170).
 *
 * A showcase may carry ONE optional, machine-written note that names the concrete
 * prompt technique the developer used ("provides the type signature up front, so the
 * model doesn't guess the interface"). It is deliberately the lowest-value layer —
 * the human voice (the developer's inline annotations + the mandatory curators' note)
 * always leads; this is a secondary, clearly-AI footnote. Two hard rules shape it:
 *
 *   1. LOCAL BY DEFAULT. The annotation runs on a local model (Ollama) by default,
 *      reusing the Phase 3/5 {@link SummaryModelClient} pattern — so nothing leaves
 *      the network for it unless an operator deliberately points it at a cloud
 *      endpoint. The default model is the documented local default; an optional
 *      override makes it configurable without changing that default.
 *
 *   2. SPECIFIC OR SILENT. The prompt instructs the model to name the concrete
 *      technique or output NOTHING; generic praise ("great prompt", "clear and
 *      effective") is forbidden. The prompt is a soft instruction, so
 *      {@link filterSpecificOrSilent} is the HARD backstop: it honors the model's
 *      `NONE` sentinel AND suppresses any output that is only generic praise. A
 *      suppressed (silent) generation writes nothing — the column stays null rather
 *      than holding a vacuous compliment.
 *
 * Reuse, not clone: the model client and its config resolution come from the
 * summaries model-client (the canonical text-generation helper); this module adds
 * only the showcase-specific prompt, the specific-or-silent filter, the policy gate
 * check, and the render shape — it does not re-implement HTTP, provider branches, or
 * endpoint validation.
 */

import type Database from 'better-sqlite3';
import type {SummaryModelConfig} from '../config/types';
import {
    resolveSummaryModel,
    SummaryModelClient,
    type ResolvedSummaryModel,
    type SummaryModelLogger,
} from '../summaries/model-client';
import {getContribution} from '../contributions/store';
import {isAiAnnotationEnabledForTeam} from './gate';
import {getShowcaseUnit, upsertShowcaseUnit} from './unitsStore';

/** The documented default: a small, fast LOCAL model. Nothing leaves the network. */
const DEFAULT_LOCAL_MODEL: SummaryModelConfig = {type: 'ollama', model_name: 'llama3.1:8b'};

/** The exact token the model is told to emit when it cannot be specific. */
export const SILENT_SENTINEL = 'NONE';

/**
 * Resolve the model the annotation runs on. Defaults to the local Ollama model and
 * merges an optional override on top (so an operator may point it elsewhere). Reuses
 * the canonical summaries resolver for the defaults + endpoint-scheme validation
 * rather than re-deriving them — the summary `level` is irrelevant here because we
 * pass only a base `model` block with no per-level override, so any level selects the
 * (absent) override slot and falls through to the base.
 */
export function resolveAnnotationModel(override?: SummaryModelConfig): ResolvedSummaryModel {
    const model: SummaryModelConfig = {...DEFAULT_LOCAL_MODEL, ...(override ?? {})};
    return resolveSummaryModel({model}, 'weekly');
}

/** Construct the model client for the annotation, reusing the summaries client. */
export function createAnnotationClient(
    override?: SummaryModelConfig,
    options: {fetchImpl?: typeof fetch; logger?: SummaryModelLogger} = {},
): SummaryModelClient {
    return new SummaryModelClient(resolveAnnotationModel(override), options);
}

/** A defensive cap on how long an annotation may be (one secondary sentence). */
const MAX_ANNOTATION_CHARS = 400;

/**
 * Build the specific-or-silent prompt for one conversation. The wording is the soft
 * half of the contract: name the ONE concrete technique specifically, or output
 * exactly `NONE`. The hard half is {@link filterSpecificOrSilent} on the output.
 */
export function buildAnnotationPrompt(conversation: string): string {
    return [
        'You are annotating a developer\'s AI coding conversation for an internal teaching',
        'showcase. Your job is to name, in ONE short sentence, the ONE concrete prompt',
        'technique the developer used that made the interaction work — something specific',
        'and observable in the transcript.',
        '',
        'Examples of SPECIFIC (good):',
        '- "Provides the full type signature up front, so the model doesn\'t guess the interface."',
        '- "Pastes the failing test first, anchoring the model to the exact expected behavior."',
        '- "Asks for three approaches before committing, then picks one with stated trade-offs."',
        '',
        'Rules:',
        `- If you cannot identify a SPECIFIC, concrete technique, output exactly: ${SILENT_SENTINEL}`,
        '- NEVER output generic praise ("great prompt", "clear and effective", "well done").',
        '  Generic praise teaches nothing; silence is better.',
        '- One sentence. No preamble, no markdown, no quotes around your answer.',
        '',
        'Conversation (JSON turns):',
        conversation,
        '',
        'Your one-sentence specific technique, or NONE:',
    ].join('\n');
}

/**
 * Multi-word praise phrases stripped before the substantive-token count, so the praise
 * words themselves never count as "specific content". Linear-time alternations (no
 * nested quantifiers — no ReDoS). Case-insensitive, whole-phrase matched.
 */
const GENERIC_PRAISE_PHRASES: readonly RegExp[] = [
    /\bwell[\s-]+(done|crafted|written|structured|phrased|thought[\s-]*out)\b/i,
    /\bnicely\s+done\b/i,
    /\bkeep\s+(it\s+)?up\b/i,
    /\bgood\s+(prompt\s+engineering|job)\b/i,
    /\bprompt\s+engineering\b/i,
];

/**
 * Standalone praise ADJECTIVES — the vacuous-compliment vocabulary. These are stripped
 * (not just matched) before counting substantive tokens, so "Smart, elegant approach"
 * collapses to "approach" rather than counting smart+elegant as real content. The list
 * is deliberately broad: the filter must not depend on the model picking one specific
 * adjective to suppress generic praise (the acceptance criterion is "generic praise is
 * never stored", not "these particular adjectives are caught"). The real backstop is
 * the universal substantive-token FLOOR below, which suppresses ANY content-free output
 * regardless of which adjective it used.
 */
const PRAISE_ADJECTIVES =
    /\b(great|good|nice|excellent|wonderful|fantastic|impressive|solid|strong|amazing|awesome|perfect|smart|brilliant|beautiful|clever|elegant|exceptional|outstanding|terrific|superb|clear|concise|effective|efficient|thoughtful|neat|tidy|clean|cool|sharp)\b/gi;

/**
 * The minimum number of substantive (technique-bearing) tokens an annotation must carry
 * to be worth storing. Below this it teaches nothing — a bare compliment or a fragment —
 * so it is silenced. A genuinely specific technique note ("anchors with the explicit
 * type signature") clears this comfortably.
 */
const MIN_SUBSTANTIVE_TOKENS = 3;

/** Filler/stopwords that don't make an annotation "specific" on their own. */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'this', 'that',
    'is', 'was', 'were', 'it', 'its', 'as', 'at', 'by', 'be', 'are', 'you', 'your', 'they',
    'very', 'really', 'so', 'too', 'here', 'used', 'use', 'uses', 'using', 'made', 'make',
    'makes', 'did', 'does', 'done', 'their', 'them', 'into', 'just', 'also', 'which', 'who',
    'what', 'when', 'where', 'how', 'why', 'overall', 'work', 'prompt', 'job', 'example',
    'approach', 'question', 'usage', 'one', 'none', 'nothing', 'anything', 'something',
]);

/**
 * Count substantive tokens once generic praise is stripped: lowercase, remove praise
 * phrases and standalone praise adjectives, split on non-letters, keep tokens of length
 * >= 3 that aren't stopwords. This is what distinguishes "great prompt, very clear"
 * (residual: nothing) from "great use of an explicit type signature anchor" (residual:
 * explicit, type, signature, anchor).
 */
function substantiveTokenCount(text: string): number {
    let stripped = text.toLowerCase();
    for (const pattern of GENERIC_PRAISE_PHRASES) {
        stripped = stripped.replace(new RegExp(pattern.source, 'gi'), ' ');
    }
    stripped = stripped.replace(PRAISE_ADJECTIVES, ' ');
    const tokens = stripped.split(/[^a-z]+/i).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    return tokens.length;
}

/** Whether the output is the exact `NONE` sentinel (allowing trailing punctuation). */
function isSilentSentinel(trimmed: string): boolean {
    return trimmed.replace(/[^a-z]/gi, '').toUpperCase() === SILENT_SENTINEL;
}

/**
 * The HARD specific-or-silent backstop on a raw model output. Returns the cleaned
 * annotation when it is a specific technique, or `null` (silent) when it must be
 * suppressed. Suppressed when:
 *   - the output is empty/whitespace, or
 *   - it is exactly the `NONE` sentinel (the model's own "I can't be specific"), or
 *   - it carries too few substantive tokens once generic praise is stripped — the
 *     UNIVERSAL floor that catches a content-free compliment regardless of which praise
 *     adjective it used (so the filter never depends on an exhaustive praise allowlist).
 * A specific note is trimmed and capped to one secondary sentence's worth of text.
 */
export function filterSpecificOrSilent(raw: string): string | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (isSilentSentinel(trimmed)) {
        return null;
    }
    if (substantiveTokenCount(trimmed) < MIN_SUBSTANTIVE_TOKENS) {
        return null;
    }
    return trimmed.length > MAX_ANNOTATION_CHARS ? `${trimmed.slice(0, MAX_ANNOTATION_CHARS).trimEnd()}…` : trimmed;
}

/** The outcome of generating an annotation from a conversation (no DB write). */
export type AnnotationOutcome =
    | {status: 'specific'; annotation: string}
    | {status: 'silent'}
    | {status: 'failed'; error: string; retryable: boolean};

/**
 * Generate an annotation for a conversation: build the prompt, call the model, and run
 * the specific-or-silent filter on the result. Never throws for an operational model
 * failure — the client returns a discriminated result and this maps it to `failed`.
 * `silent` covers both an explicit model failure-to-be-specific (`NONE`) and a generic
 * compliment the filter suppressed.
 */
export async function generateAnnotation(
    client: SummaryModelClient,
    conversation: string,
): Promise<AnnotationOutcome> {
    const result = await client.generate(buildAnnotationPrompt(conversation));
    if (!result.ok) {
        return {status: 'failed', error: result.error, retryable: result.retryable};
    }
    const filtered = filterSpecificOrSilent(result.text);
    return filtered === null ? {status: 'silent'} : {status: 'specific', annotation: filtered};
}

/** The outcome of the end-to-end annotate-and-store service. */
export type AnnotateOutcome =
    | {status: 'not_found'}
    | {status: 'disabled'}
    | {status: 'specific'; annotation: string}
    | {status: 'silent'}
    | {status: 'failed'; error: string; retryable: boolean};

export interface AnnotateInput {
    contributionId: string;
    /** Optional model override; absent ⇒ the local default (nothing leaves the network). */
    model?: SummaryModelConfig;
    /** Pre-built client (tests inject a mock); absent ⇒ built from `model`. */
    client?: SummaryModelClient;
    /** Client construction options (e.g. fetch/logger) when building from `model`. */
    clientOptions?: {fetchImpl?: typeof fetch; logger?: SummaryModelLogger};
}

/**
 * Annotate a showcase unit end-to-end and persist a SPECIFIC result.
 *
 * Order is deliberate and fail-closed for the privacy/setting contract:
 *   1. the contribution must be a showcase (have a unit) — else `not_found`;
 *   2. the AI annotation must be ENABLED for the showcase's team (resolved live from
 *      `showcase_ai_annotation_enabled`) — else `disabled`, and the model is NEVER
 *      called, so a disabled team sends nothing anywhere;
 *   3. only then is the (local-by-default) model called and the output filtered.
 *
 * Persistence rule: ONLY a `specific` outcome is written (into
 * `showcase_units.ai_annotation`, via the canonical upsert so its mandatory-note and
 * publish-path gates still hold). A `silent` outcome writes NOTHING — it never
 * overwrites a prior annotation with a vacuous one, and the column stays null when
 * none existed. A `failed` outcome (model unreachable, etc.) also writes nothing.
 */
export async function annotateShowcaseUnit(db: Database.Database, input: AnnotateInput): Promise<AnnotateOutcome> {
    const unit = getShowcaseUnit(db, input.contributionId);
    if (!unit) {
        return {status: 'not_found'};
    }
    // The gate is resolved for the showcase's own team (its spine scope target), so a
    // per-team override is honored exactly like the other showcase policy checks.
    const contribution = getContribution(db, input.contributionId);
    const team = contribution?.scopeTarget ?? null;
    if (!isAiAnnotationEnabledForTeam(db, team)) {
        return {status: 'disabled'};
    }

    const client = input.client ?? createAnnotationClient(input.model, input.clientOptions);
    const outcome = await generateAnnotation(client, unit.conversation);
    if (outcome.status === 'specific') {
        upsertShowcaseUnit(db, {
            contributionId: unit.contributionId,
            conversation: unit.conversation,
            curatorsNote: unit.curatorsNote,
            publishPath: unit.publishPath,
            outcomeLink: unit.outcomeLink,
            aiAnnotation: outcome.annotation,
        });
    }
    return outcome;
}

/**
 * The render shape for the AI annotation: machine-readable flags that mark it as
 * unambiguously AI-generated and SECONDARY to the human voice. A renderer keys off
 * `source`/`prominence` to style it as a clearly-AI footnote rather than letting it
 * masquerade as the developer's or curator's words.
 */
export interface RenderedAiAnnotation {
    /** Whether a usable annotation is present (a blank/whitespace value is absent). */
    present: boolean;
    /** Attribution — always 'ai_generated', never human. The "clearly AI" flag. */
    source: 'ai_generated';
    /** Visual weight relative to the human voice — always secondary. */
    prominence: 'secondary';
    /** Human-facing label that names it as an AI suggestion. */
    label: string;
    /** The annotation text, or null when absent. */
    text: string | null;
}

/** The label every rendered AI annotation carries, marking it clearly as AI. */
export const AI_ANNOTATION_LABEL = 'AI-suggested prompt technique';

/**
 * Render a stored annotation as a clearly-AI, secondary note. A null/blank value
 * renders as `present: false` with null text, so a renderer simply omits the footnote
 * rather than showing an empty AI block. The `source`/`prominence` flags are constant
 * by design — the annotation is ALWAYS AI and ALWAYS secondary to the human voice.
 */
export function renderAiAnnotation(annotation: string | null | undefined): RenderedAiAnnotation {
    const text = typeof annotation === 'string' && annotation.trim() !== '' ? annotation.trim() : null;
    return {
        present: text !== null,
        source: 'ai_generated',
        prominence: 'secondary',
        label: AI_ANNOTATION_LABEL,
        text,
    };
}
