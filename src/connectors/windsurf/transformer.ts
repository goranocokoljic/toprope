import {randomUUID} from 'crypto';
import type {WindsurfUserMetrics} from './client';

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

const TOOL = 'windsurf';

export function transformMetrics(
    metrics: WindsurfUserMetrics[],
    emailToDevId: Map<string, string>,
    storeRawData: boolean,
): ToolSnapshot[] {
    const snapshots: ToolSnapshot[] = [];

    for (const entry of metrics) {
        const developerId = emailToDevId.get(entry.email);
        if (!developerId) continue;

        const interactionCount = entry.completions_shown;
        const acceptanceCount = entry.completions_accepted;
        const acceptanceRate =
            interactionCount > 0 ? acceptanceCount / interactionCount : null;

        const featuresUsed: Record<string, number> = {
            autocomplete: entry.completions_accepted,
            cascade: entry.cascade_sessions,
            chat: entry.chat_messages,
            flows: entry.flows_run,
        };
        if (entry.ai_code_percentage > 0) {
            featuresUsed.ai_code_percentage = entry.ai_code_percentage;
        }

        const isActive =
            interactionCount > 0 ||
            entry.cascade_sessions > 0 ||
            entry.chat_messages > 0 ||
            entry.flows_run > 0
                ? 1
                : 0;

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
            models_used: null,
            estimated_cost: null,
            tokens_consumed: null,
            raw_data: storeRawData ? JSON.stringify(entry) : null,
        });
    }

    return snapshots;
}
