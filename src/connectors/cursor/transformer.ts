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

export function transformMetrics(
    metrics: CursorUserMetrics[],
    emailToDevId: Map<string, string>,
    storeRawData: boolean,
): ToolSnapshot[] {
    const snapshots: ToolSnapshot[] = [];

    for (const entry of metrics) {
        const developerId = emailToDevId.get(entry.email);
        if (!developerId) continue;

        const interactionCount = entry.autocomplete_shown;
        const acceptanceCount = entry.autocomplete_accepted;
        const acceptanceRate =
            interactionCount > 0 ? acceptanceCount / interactionCount : null;

        // Feature breakdown drives the under-utilization insight ("paying for it
        // but only using autocomplete"): keep autocomplete vs Composer vs chat
        // distinct.
        const featuresUsed: Record<string, number> = {
            autocomplete: entry.autocomplete_accepted,
            composer: entry.composer_requests,
            chat: entry.chat_requests,
        };

        const isActive =
            interactionCount > 0 ||
            entry.composer_requests > 0 ||
            entry.chat_requests > 0
                ? 1
                : 0;

        const models = entry.models_used;
        const hasModels = models != null && Object.keys(models).length > 0;
        const cost = entry.estimated_cost;

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
            estimated_cost: cost != null && cost > 0 ? cost : null,
            tokens_consumed: null,
            raw_data: storeRawData ? JSON.stringify(entry) : null,
        });
    }

    return snapshots;
}
