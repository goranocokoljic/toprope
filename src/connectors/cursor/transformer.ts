import {randomUUID} from 'crypto';
import type {CursorUserMetrics} from './client';

export interface ToolSnapshot {
    id: string;
    developer_id: string;
    date: string;
    tool: string;
    data_source: string;
    data_quality: string;
    is_active: number;
    interaction_count: number;
    acceptance_count: number;
    acceptance_rate: number | null;
    features_used: string | null;
    models_used: string | null;
    estimated_cost: number | null;
    tokens_consumed: number | null;
    raw_data: string | null;
}

const TOOL = 'cursor';

// The API response is an untrusted boundary — the client casts the JSON with
// `as CursorUsageResponse` without a runtime check, so a missing field or a
// numeric string can reach here and would otherwise write a non-integer into an
// INTEGER column or a NaN acceptance_rate. These coercers narrow `unknown`
// before any arithmetic or persistence.

// → a non-negative integer; any non-finite, negative, or zero input yields 0.
function asCount(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// → a positive cost, or null; any non-finite, negative, or zero input yields null.
function asCost(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// `date` is part of the ON CONFLICT(developer_id, date, tool) idempotency key, so
// a malformed or alternately-formatted value (e.g. a full timestamp) would
// defeat dedupe and let two rows land for the same dev/day. Require a strict
// YYYY-MM-DD calendar date.
function isIsoDate(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Untrusted JSON: `models_used` is typed Record<string, number> but could arrive
// as a string/array/number. Only a plain object yields a usable model breakdown.
function isModelMap(value: unknown): value is Record<string, number> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function transformMetrics(
    metrics: CursorUserMetrics[],
    emailToDevId: Map<string, string>,
    storeRawData: boolean,
): ToolSnapshot[] {
    const snapshots: ToolSnapshot[] = [];

    for (const entry of metrics) {
        const developerId = emailToDevId.get(entry.email);
        if (!developerId) continue;
        // Skip rows with a malformed date rather than risk a duplicate snapshot
        // for the day (the date is part of the conflict key).
        if (!isIsoDate(entry.date)) continue;

        const interactionCount = asCount(entry.autocomplete_shown);
        const acceptanceCount = asCount(entry.autocomplete_accepted);
        const composerRequests = asCount(entry.composer_requests);
        const chatRequests = asCount(entry.chat_requests);
        const acceptanceRate =
            interactionCount > 0 ? acceptanceCount / interactionCount : null;

        // Feature breakdown drives the under-utilization insight ("paying for it
        // but only using autocomplete"): keep autocomplete vs Composer vs chat
        // distinct.
        const featuresUsed: Record<string, number> = {
            autocomplete: acceptanceCount,
            composer: composerRequests,
            chat: chatRequests,
        };

        const isActive =
            interactionCount > 0 || composerRequests > 0 || chatRequests > 0 ? 1 : 0;

        const models = entry.models_used;
        const hasModels = isModelMap(models) && Object.keys(models).length > 0;

        snapshots.push({
            id: randomUUID(),
            developer_id: developerId,
            date: entry.date,
            tool: TOOL,
            data_source: 'api',
            data_quality: 'high',
            is_active: isActive,
            interaction_count: interactionCount,
            acceptance_count: acceptanceCount,
            acceptance_rate: acceptanceRate,
            features_used: JSON.stringify(featuresUsed),
            models_used: hasModels ? JSON.stringify(models) : null,
            estimated_cost: asCost(entry.estimated_cost),
            tokens_consumed: null,
            raw_data: storeRawData ? JSON.stringify(entry) : null,
        });
    }

    return snapshots;
}
