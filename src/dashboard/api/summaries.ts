/**
 * Summary read + generation endpoints (Task 3.11 / #80).
 *
 *   GET  /api/summaries?level=&scope=   — list summaries, most recent first
 *   GET  /api/summaries/:id             — one summary's full text + metadata
 *   POST /api/summaries/:id/regenerate  — regenerate (optional { focus })
 *   POST /api/summaries/generate        — on-demand generate { level, period, scope }
 *
 * Every summary response carries `basis` and `tier`/`data_basis` so the UI can
 * label the narrative honestly (a "git-based estimate" at launch). The summaries
 * table predates Phase 3 and stores no basis column, so it is recomputed at read
 * time from the same engine the summary was generated from
 * ({@link computeScopeAggregate}) — cheap at launch scale and always consistent
 * with the current underlying data, rather than a value frozen at generation.
 *
 * Admin-gated like the rest of the manager API.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import type {SummariesConfig} from '../../config/types';
import {isAdmin, forbidden} from './guards';
import {
    getSummaryById,
    listSummaries,
    targetFromRecord,
    type SummaryListFilter,
    type SummaryRecord,
} from '../../summaries/store';
import {generateSummary, type GenerateOptions} from '../../summaries/generator';
import {parseLevel, parseScope, validatePeriod, type SummaryTarget} from '../../summaries/target';
import {computeScopeAggregate} from '../../summaries/input-source';
import {deriveDataBasis} from '../../summaries/input-builder';

/** The basis/tier a summary response carries for honest UI labelling. */
interface SummaryTier {
    /** Maturity basis: git_estimate | mixed | measured. */
    basis: string;
    /** Data-quality tier the period was computed at: high | medium | low. */
    tier: string;
    /** Human-readable statement of what the numbers derive from. */
    data_basis: string;
}

/**
 * Recompute the basis/tier for a stored summary from its target's current
 * aggregate. Passing a null benchmark skips the org-average cost fold — basis and
 * data-quality don't depend on it. Returns null if the target can't be folded
 * (e.g. its scope no longer resolves), so a list never fails on one bad row.
 */
function summaryTier(db: Database.Database, record: SummaryRecord): SummaryTier | null {
    try {
        const target = targetFromRecord(record);
        const agg = computeScopeAggregate(db, target.scope, target.level, target.period, null);
        return {
            basis: agg.ai_maturity_basis,
            tier: agg.data_quality,
            data_basis: deriveDataBasis(agg.ai_maturity_basis),
        };
    } catch {
        return null;
    }
}

/** A list item: metadata + staleness + basis/tier, without the full narrative text. */
function toListItem(db: Database.Database, record: SummaryRecord): Record<string, unknown> {
    return {
        id: record.id,
        scope: record.scope,
        scope_name: record.scope_name,
        period_type: record.period_type,
        period_value: record.period_value,
        model_used: record.model_used,
        generated_at: record.generated_at,
        regenerated_count: record.regenerated_count,
        is_stale: record.is_stale,
        ...(summaryTier(db, record) ?? {basis: null, tier: null, data_basis: null}),
    };
}

/** A full summary response: the list item plus the narrative text + input hash. */
function toDetail(db: Database.Database, record: SummaryRecord): Record<string, unknown> {
    return {
        ...toListItem(db, record),
        summary_text: record.summary_text,
        input_hash: record.input_hash,
    };
}

/** Parse the scope query/body token ('org' | 'team:<name>') into list filters. */
function scopeFilter(raw: string): Pick<SummaryListFilter, 'scope' | 'scopeName'> {
    const scope = parseScope(raw);
    return scope.type === 'org' ? {scope: 'org'} : {scope: 'team', scopeName: scope.name};
}

const LEVELS = new Set(['weekly', 'monthly', 'quarterly', 'yearly']);

/**
 * Test seam: the model-client factory the generator uses. Production leaves it
 * unset (the generator resolves the real config-driven client); tests inject a
 * fake so the generate/regenerate routes can be exercised without a live model.
 */
export interface SummaryRouteOptions {
    createClient?: GenerateOptions['createClient'];
}

/**
 * Run a generation and translate its discriminated result into an HTTP response.
 * A non-retryable failure is the caller's fault (bad scope/config) → 400; a
 * retryable one is a transient model/output problem → 503.
 */
async function runGeneration(
    db: Database.Database,
    summaries: SummariesConfig | undefined,
    target: SummaryTarget,
    focus: string | undefined,
    createClient: GenerateOptions['createClient'],
    reply: FastifyReply,
): Promise<unknown> {
    const options: GenerateOptions = {};
    if (focus) options.focus = focus;
    if (createClient) options.createClient = createClient;
    const result = await generateSummary(db, summaries, target, options);
    if (!result.ok) {
        const status = result.retryable ? 503 : 400;
        return reply
            .status(status)
            .send({error: result.retryable ? 'Service Unavailable' : 'Bad Request', message: result.error});
    }
    return {data: toDetail(db, result.summary)};
}

export function registerSummaryRoutes(
    app: FastifyInstance,
    db: Database.Database,
    summaries: SummariesConfig | undefined,
    options: SummaryRouteOptions = {},
): void {
    const {createClient} = options;
    // ── list ────────────────────────────────────────────────────────────────
    app.get<{Querystring: {level?: string; scope?: string}}>(
        '/api/summaries',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }

            const filter: SummaryListFilter = {};
            const {level, scope} = request.query;
            if (level !== undefined) {
                if (!LEVELS.has(level)) {
                    return reply.status(400).send({
                        error: 'Bad Request',
                        message: `Unknown level '${level}' (expected weekly|monthly|quarterly|yearly)`,
                    });
                }
                filter.level = level as SummaryListFilter['level'];
            }
            if (scope !== undefined) {
                try {
                    Object.assign(filter, scopeFilter(scope));
                } catch (err) {
                    return reply.status(400).send({
                        error: 'Bad Request',
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            const items = listSummaries(db, filter).map((r) => toListItem(db, r));
            return {data: items};
        },
    );

    // ── detail ──────────────────────────────────────────────────────────────
    app.get<{Params: {id: string}}>('/api/summaries/:id', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        const record = getSummaryById(db, request.params.id);
        if (!record) {
            return reply
                .status(404)
                .send({error: 'Not Found', message: `Summary '${request.params.id}' not found`});
        }
        return {data: toDetail(db, record)};
    });

    // ── regenerate ────────────────────────────────────────────────────────────
    app.post<{Params: {id: string}; Body: {focus?: unknown} | undefined}>(
        '/api/summaries/:id/regenerate',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }

            const record = getSummaryById(db, request.params.id);
            if (!record) {
                return reply
                    .status(404)
                    .send({error: 'Not Found', message: `Summary '${request.params.id}' not found`});
            }

            const focusRaw = request.body?.focus;
            if (focusRaw !== undefined && typeof focusRaw !== 'string') {
                return reply
                    .status(400)
                    .send({error: 'Bad Request', message: 'Body field "focus" must be a string'});
            }
            const focus = focusRaw?.trim() ? focusRaw.trim() : undefined;

            return runGeneration(db, summaries, targetFromRecord(record), focus, createClient, reply);
        },
    );

    // ── on-demand generate ────────────────────────────────────────────────────
    app.post<{Body: {level?: unknown; period?: unknown; scope?: unknown} | undefined}>(
        '/api/summaries/generate',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }

            const body = request.body ?? {};
            if (
                typeof body.level !== 'string' ||
                typeof body.period !== 'string' ||
                typeof body.scope !== 'string'
            ) {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Body must include string "level", "period", and "scope"',
                });
            }

            let target: SummaryTarget;
            try {
                const level = parseLevel(body.level);
                const scope = parseScope(body.scope);
                const period = validatePeriod(level, body.period);
                target = {level, period, scope};
            } catch (err) {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: err instanceof Error ? err.message : String(err),
                });
            }

            return runGeneration(db, summaries, target, undefined, createClient, reply);
        },
    );
}
