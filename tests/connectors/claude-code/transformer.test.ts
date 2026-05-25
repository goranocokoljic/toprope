import {describe, it, expect} from 'vitest';
import {transformUsage} from '../../../src/connectors/claude-code/transformer';
import type {ClaudeCodeUsageEntry} from '../../../src/connectors/claude-code/client';

const DEV_ID = 'dev-uuid-1';
const EMAIL = 'alice@company.com';

function makeEntry(overrides: Partial<ClaudeCodeUsageEntry> = {}): ClaudeCodeUsageEntry {
    return {
        user_id: 'user-1',
        user_email: EMAIL,
        date: '2024-01-15',
        model: 'claude-sonnet-4-6',
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
        cost_usd: 0.25,
        request_count: 10,
        session_count: 3,
        tool_use_count: 8,
        tool_success_count: 6,
        commits: 2,
        prs_created: 1,
        lines_added: 150,
        lines_removed: 30,
        ...overrides,
    };
}

describe('transformUsage', () => {
    it('maps a normal entry to a snapshot', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry()], map, false);

        expect(snap.developer_id).toBe(DEV_ID);
        expect(snap.date).toBe('2024-01-15');
        expect(snap.tool).toBe('claude_code');
        expect(snap.data_quality).toBe('high');
        expect(snap.data_source).toBe('api');
        expect(snap.is_active).toBe(1);
    });

    it('sets interaction_count from request_count', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry({request_count: 42})], map, false);

        expect(snap.interaction_count).toBe(42);
    });

    it('sets acceptance_count from tool_success_count', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry()], map, false);

        expect(snap.acceptance_count).toBe(6);
    });

    it('calculates acceptance_rate from tool_use_count and tool_success_count', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({tool_use_count: 10, tool_success_count: 7});
        const [snap] = transformUsage([entry], map, false);

        expect(snap.acceptance_rate).toBeCloseTo(0.7, 5);
    });

    it('sets acceptance_rate to null when tool_use_count is 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({tool_use_count: 0, tool_success_count: 0});
        const [snap] = transformUsage([entry], map, false);

        expect(snap.acceptance_rate).toBeNull();
    });

    it('populates features_used with chat, agent_sessions, tool_uses', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry()], map, false);

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.chat).toBe(10);
        expect(features.agent_sessions).toBe(3);
        expect(features.tool_uses).toBe(8);
    });

    it('includes commits in features_used when non-zero', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry({commits: 5})], map, false);

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.commits).toBe(5);
    });

    it('includes prs_created in features_used when non-zero', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry({prs_created: 2})], map, false);

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.prs_created).toBe(2);
    });

    it('does not include commits/prs in features_used when zero', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry({commits: 0, prs_created: 0})], map, false);

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.commits).toBeUndefined();
        expect(features.prs_created).toBeUndefined();
    });

    it('populates models_used from entry model', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry({model: 'claude-opus-4-7', request_count: 5})], map, false);

        const models = JSON.parse(snap.models_used!) as Record<string, number>;
        expect(models['claude-opus-4-7']).toBe(5);
    });

    it('sets estimated_cost from cost_usd', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry({cost_usd: 1.5})], map, false);

        expect(snap.estimated_cost).toBeCloseTo(1.5, 5);
    });

    it('sets estimated_cost to null when cost is 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry({cost_usd: 0})], map, false);

        expect(snap.estimated_cost).toBeNull();
    });

    it('sets tokens_consumed as sum of input + output tokens', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({input_tokens: 1000, output_tokens: 500});
        const [snap] = transformUsage([entry], map, false);

        expect(snap.tokens_consumed).toBe(1500);
    });

    it('aggregates multiple model rows for same user+day into one snapshot', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry1 = makeEntry({model: 'claude-sonnet-4-6', request_count: 10, cost_usd: 0.5, input_tokens: 500, output_tokens: 200});
        const entry2 = makeEntry({model: 'claude-opus-4-7', request_count: 5, cost_usd: 1.0, input_tokens: 300, output_tokens: 100});
        const snapshots = transformUsage([entry1, entry2], map, false);

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].interaction_count).toBe(15);
        expect(snapshots[0].estimated_cost).toBeCloseTo(1.5, 5);
        expect(snapshots[0].tokens_consumed).toBe(1100);
    });

    it('produces separate snapshots for different days', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry1 = makeEntry({date: '2024-01-15'});
        const entry2 = makeEntry({date: '2024-01-16'});
        const snapshots = transformUsage([entry1, entry2], map, false);

        expect(snapshots).toHaveLength(2);
        const dates = snapshots.map((s) => s.date).sort();
        expect(dates).toEqual(['2024-01-15', '2024-01-16']);
    });

    it('skips entries with no matching developer', () => {
        const map = new Map<string, string>();
        const result = transformUsage([makeEntry()], map, false);

        expect(result).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const result = transformUsage([], map, false);

        expect(result).toHaveLength(0);
    });

    it('stores raw_data when storeRawData=true', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry()], map, true);

        expect(snap.raw_data).not.toBeNull();
        const raw = JSON.parse(snap.raw_data!) as unknown[];
        expect(raw).toHaveLength(1);
    });

    it('leaves raw_data null when storeRawData=false', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformUsage([makeEntry()], map, false);

        expect(snap.raw_data).toBeNull();
    });

    it('marks snapshot inactive when request_count and session_count are 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({request_count: 0, session_count: 0});
        const [snap] = transformUsage([entry], map, false);

        expect(snap.is_active).toBe(0);
    });
});
