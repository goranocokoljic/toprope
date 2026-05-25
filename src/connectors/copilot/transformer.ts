import {randomUUID} from 'crypto';
import type {CopilotUserMetrics, CopilotSeat} from './client';

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

export interface InactiveSeat {
    login: string;
    last_activity_at: string | null;
    days_inactive: number;
}

const INACTIVE_THRESHOLD_DAYS = 14;
const TOOL = 'copilot';

export function transformMetrics(
    metrics: CopilotUserMetrics[],
    loginToDevId: Map<string, string>,
    storeRawData: boolean,
): ToolSnapshot[] {
    const snapshots: ToolSnapshot[] = [];

    for (const entry of metrics) {
        const developerId = loginToDevId.get(entry.login);
        if (!developerId) continue;

        const interactionCount = entry.total_suggestions_count;
        const acceptanceCount = entry.total_acceptances_count;
        const acceptanceRate =
            interactionCount > 0 ? acceptanceCount / interactionCount : null;

        const featuresUsed: Record<string, number> = {
            completions: entry.total_suggestions_count,
            chat: entry.total_active_chat_count,
            chat_insertions: entry.total_chat_insertion_events,
            chat_copies: entry.total_chat_copy_events,
        };

        const modelsUsed: Record<string, number> = {};
        if (entry.breakdown) {
            for (const b of entry.breakdown) {
                if (b.model && b.acceptances_count !== undefined) {
                    modelsUsed[b.model] = (modelsUsed[b.model] ?? 0) + b.acceptances_count;
                }
            }
        }

        const isActive = interactionCount > 0 || entry.total_active_chat_count > 0 ? 1 : 0;

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
            models_used: Object.keys(modelsUsed).length > 0 ? JSON.stringify(modelsUsed) : null,
            estimated_cost: null,
            tokens_consumed: null,
            raw_data: storeRawData ? JSON.stringify(entry) : null,
        });
    }

    return snapshots;
}

export function detectInactiveSeats(seats: CopilotSeat[], asOf: Date = new Date()): InactiveSeat[] {
    const inactive: InactiveSeat[] = [];

    for (const seat of seats) {
        const lastActivity = seat.last_activity_at ? new Date(seat.last_activity_at) : null;

        if (!lastActivity) {
            inactive.push({
                login: seat.assignee?.login ?? seat.login,
                last_activity_at: null,
                days_inactive: Infinity,
            });
            continue;
        }

        const diffMs = asOf.getTime() - lastActivity.getTime();
        const daysInactive = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (daysInactive >= INACTIVE_THRESHOLD_DAYS) {
            inactive.push({
                login: seat.assignee?.login ?? seat.login,
                last_activity_at: seat.last_activity_at,
                days_inactive: daysInactive,
            });
        }
    }

    return inactive;
}
