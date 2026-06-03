/**
 * Summary generation orchestrator (Task 3.9 / #78).
 *
 * Runs the full pipeline for one target: build the numbers-only input from
 * snapshots → render the tier-aware prompt → call the configured model → guard the
 * output → store the text with its model, input hash, and timestamp. The steps live
 * in their own modules (input-source, prompts, model-client, store); this is the
 * orchestration that wires them and owns the transactional/failure guarantees.
 *
 * Two guarantees the acceptance criteria hinge on:
 *
 *   - Failure leaves no partial row. The model is called BEFORE any write, so a
 *     model-down / timeout / empty-response result returns a failure and the
 *     summaries table is untouched — the period is simply retried next time. The
 *     output guard (fabricated direct-usage language) is treated the same way: a
 *     violating generation is rejected, not stored.
 *
 *   - Regeneration increments, never resets. The stored regenerated_count is read
 *     first and incremented when a row already exists, so generating again (with or
 *     without a new focus) records that the summary was regenerated; a brand-new
 *     summary starts at 0. A successful write always clears is_stale (the new text
 *     matches the freshly built input).
 */

import type Database from 'better-sqlite3';
import type {SummariesConfig} from '../config/types';
import {createSummaryModelClient, type SummaryModelClient} from './model-client';
import {buildSummaryPrompt, findFabricatedUsageLanguage} from './prompts';
import {buildSummaryInputForTarget} from './input-source';
import {hashInput, summaryId, getSummaryById, upsertSummary, type SummaryRecord} from './store';
import type {SummaryTarget} from './target';

/** Optional steering + injection points for one generation. */
export interface GenerateOptions {
    /**
     * Regeneration focus passed into the prompt (e.g. "cost"). Steers emphasis
     * among the present metrics only — it never licenses describing absent data.
     */
    focus?: string;
    /** Injectable clock (tests pin generated_at); defaults to wall clock. */
    now?: () => Date;
    /**
     * Injectable model-client factory (tests drive the provider branches without a
     * live server). Defaults to the real config-resolving factory.
     */
    createClient?: (summaries: SummariesConfig | undefined, level: SummaryTarget['level']) => SummaryModelClient;
}

/** Result of a generation attempt — success carries the stored record. */
export type GenerateResult =
    | {ok: true; summary: SummaryRecord}
    | {ok: false; error: string; retryable: boolean};

/**
 * Generate (or regenerate) the summary for `target`. On model failure or a
 * rejected output, returns `ok: false` and writes nothing; on success, upserts the
 * row (incrementing regenerated_count when one already existed) and returns it.
 */
export async function generateSummary(
    db: Database.Database,
    summaries: SummariesConfig | undefined,
    target: SummaryTarget,
    options: GenerateOptions = {},
): Promise<GenerateResult> {
    const now = options.now ?? ((): Date => new Date());
    const createClient = options.createClient ?? createSummaryModelClient;

    // Build the numbers-only payload (privacy gate runs inside buildSummaryInput).
    const payload = buildSummaryInputForTarget(db, target);

    // Refuse to summarise a scope with no developers at all — an org with no
    // registry, or (the common case) a mistyped `team:<name>` that matches no team.
    // Without this guard the payload is all-zeros yet still passes the privacy gate,
    // so the model would invent a narrative for a team that doesn't exist. A real
    // team that exists but was simply idle this period has developer_count > 0 and
    // is summarised normally (its zeros are genuine). Not retryable — the scope
    // itself is the problem, so re-running won't help.
    if (payload.scope.developer_count === 0) {
        return {
            ok: false,
            retryable: false,
            error:
                `No developers in scope ${target.scope.type}:${target.scope.name} — ` +
                'nothing to summarise (check the team name exists in the registry)',
        };
    }

    const prompt = buildSummaryPrompt(payload, options.focus ? {focus: options.focus} : undefined);

    // Resolving/constructing the client can throw on a misconfiguration (no
    // model_name, unsupported provider, non-http endpoint — resolveSummaryModel
    // surfaces those loudly by design). Fold that into the same discriminated
    // failure the operational path returns, so generateSummary NEVER throws for a
    // model/config problem: the CLI prints a clean line and a future scheduler/API
    // caller gets {ok:false} rather than an exception. Not retryable — a config
    // error won't fix itself on the next tick.
    let client: SummaryModelClient;
    try {
        client = createClient(summaries, target.level);
    } catch (err) {
        return {
            ok: false,
            retryable: false,
            error: `Summary model not configured for ${target.level}: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Call the model BEFORE any write so a failure can't leave a partial row.
    const result = await client.generate(prompt);
    if (!result.ok) {
        return {ok: false, error: result.error, retryable: result.retryable};
    }

    // Hard output guard: a non-measured period must not store fabricated
    // direct-usage language. A violation is rejected (and retryable — the model is
    // non-deterministic, so a re-run may comply), never persisted.
    const fabricated = findFabricatedUsageLanguage(result.text, payload);
    if (fabricated.length > 0) {
        return {
            ok: false,
            retryable: true,
            error:
                `Generated ${target.level} summary for ${target.scope.name} contained fabricated ` +
                `direct-usage language (${fabricated.map((t) => `"${t}"`).join(', ')}); not stored`,
        };
    }

    const id = summaryId(target);
    const existing = getSummaryById(db, id);
    const record: SummaryRecord = {
        id,
        scope: target.scope.type,
        scope_name: target.scope.name,
        period_type: target.level,
        period_value: target.period,
        summary_text: result.text,
        model_used: result.model,
        input_hash: hashInput(payload),
        generated_at: now().toISOString(),
        // Fresh summary starts at 0; an existing one being regenerated increments.
        regenerated_count: existing ? existing.regenerated_count + 1 : 0,
        is_stale: 0,
    };
    upsertSummary(db, record);
    return {ok: true, summary: record};
}
