import {randomUUID} from 'crypto';
import type {ClaudeCodeUsageEntry} from './client';

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

const TOOL = 'claude_code';

interface DayAggregate {
    requestCount: number;
    sessionCount: number;
    toolUseCount: number;
    toolSuccessCount: number;
    commits: number;
    prsCreated: number;
    linesAdded: number;
    linesRemoved: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    models: Record<string, number>;
    rawEntries: ClaudeCodeUsageEntry[];
}

function emptyAggregate(): DayAggregate {
    return {
        requestCount: 0,
        sessionCount: 0,
        toolUseCount: 0,
        toolSuccessCount: 0,
        commits: 0,
        prsCreated: 0,
        linesAdded: 0,
        linesRemoved: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        models: {},
        rawEntries: [],
    };
}

function aggregateEntries(entries: ClaudeCodeUsageEntry[]): Map<string, Map<string, DayAggregate>> {
    const byEmailDate = new Map<string, Map<string, DayAggregate>>();

    for (const entry of entries) {
        const email = entry.user_email;
        const date = entry.date;

        if (!byEmailDate.has(email)) byEmailDate.set(email, new Map());
        const byDate = byEmailDate.get(email)!;
        if (!byDate.has(date)) byDate.set(date, emptyAggregate());

        const agg = byDate.get(date)!;
        agg.requestCount += entry.request_count;
        agg.sessionCount += entry.session_count ?? 0;
        agg.toolUseCount += entry.tool_use_count ?? 0;
        agg.toolSuccessCount += entry.tool_success_count ?? 0;
        agg.commits += entry.commits ?? 0;
        agg.prsCreated += entry.prs_created ?? 0;
        agg.linesAdded += entry.lines_added ?? 0;
        agg.linesRemoved += entry.lines_removed ?? 0;
        agg.costUsd += entry.cost_usd;
        agg.inputTokens += entry.input_tokens;
        agg.outputTokens += entry.output_tokens;
        agg.models[entry.model] = (agg.models[entry.model] ?? 0) + entry.request_count;
        agg.rawEntries.push(entry);
    }

    return byEmailDate;
}

export function transformUsage(
    entries: ClaudeCodeUsageEntry[],
    emailToDevId: Map<string, string>,
    storeRawData: boolean,
): ToolSnapshot[] {
    const snapshots: ToolSnapshot[] = [];
    const byEmailDate = aggregateEntries(entries);

    for (const [email, byDate] of byEmailDate) {
        const developerId = emailToDevId.get(email);
        if (!developerId) continue;

        for (const [date, agg] of byDate) {
            const interactionCount = agg.requestCount;
            const acceptanceCount = agg.toolSuccessCount;
            const acceptanceRate =
                agg.toolUseCount > 0 ? agg.toolSuccessCount / agg.toolUseCount : null;

            const featuresUsed: Record<string, number> = {
                chat: agg.requestCount,
                agent_sessions: agg.sessionCount,
                tool_uses: agg.toolUseCount,
            };
            if (agg.commits > 0) featuresUsed.commits = agg.commits;
            if (agg.prsCreated > 0) featuresUsed.prs_created = agg.prsCreated;

            const isActive = interactionCount > 0 || agg.sessionCount > 0 ? 1 : 0;
            const tokensConsumed = agg.inputTokens + agg.outputTokens;

            snapshots.push({
                id: randomUUID(),
                developer_id: developerId,
                date,
                tool: TOOL,
                data_source: 'api',
                data_quality: 'high',
                is_active: isActive,
                interaction_count: interactionCount,
                acceptance_count: acceptanceCount,
                acceptance_rate: acceptanceRate,
                features_used: JSON.stringify(featuresUsed),
                models_used:
                    Object.keys(agg.models).length > 0 ? JSON.stringify(agg.models) : null,
                estimated_cost: agg.costUsd > 0 ? agg.costUsd : null,
                tokens_consumed: tokensConsumed > 0 ? tokensConsumed : null,
                raw_data: storeRawData ? JSON.stringify(agg.rawEntries) : null,
            });
        }
    }

    return snapshots;
}
