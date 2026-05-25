import {describe, it, expect} from 'vitest';
import {transformMetrics} from '../../../src/connectors/windsurf/transformer';
import type {WindsurfUserMetrics} from '../../../src/connectors/windsurf/client';

const DEV_ID = 'dev-uuid-1';
const EMAIL = 'alice@company.com';

function makeEntry(overrides: Partial<WindsurfUserMetrics> = {}): WindsurfUserMetrics {
    return {
        user_id: 'ws-user-1',
        email: EMAIL,
        date: '2024-01-15',
        completions_shown: 100,
        completions_accepted: 45,
        ai_code_percentage: 38.5,
        cascade_sessions: 8,
        chat_messages: 15,
        flows_run: 3,
        ...overrides,
    };
}

describe('transformMetrics', () => {
    it('maps a normal entry to a snapshot', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry()], map, false);

        expect(snap.developer_id).toBe(DEV_ID);
        expect(snap.date).toBe('2024-01-15');
        expect(snap.tool).toBe('windsurf');
        expect(snap.data_quality).toBe('high');
        expect(snap.data_source).toBe('api');
        expect(snap.is_active).toBe(1);
    });

    it('sets interaction_count from completions_shown', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry({completions_shown: 80})], map, false);

        expect(snap.interaction_count).toBe(80);
    });

    it('sets acceptance_count from completions_accepted', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry({completions_accepted: 30})], map, false);

        expect(snap.acceptance_count).toBe(30);
    });

    it('calculates acceptance_rate from completions_shown and completions_accepted', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({completions_shown: 100, completions_accepted: 40});
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.acceptance_rate).toBeCloseTo(0.4, 5);
    });

    it('sets acceptance_rate to null when completions_shown is 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({completions_shown: 0, completions_accepted: 0});
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.acceptance_rate).toBeNull();
    });

    it('populates features_used with autocomplete, cascade, chat, flows', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({completions_accepted: 45, cascade_sessions: 8, chat_messages: 15, flows_run: 3})],
            map,
            false,
        );

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.autocomplete).toBe(45);
        expect(features.cascade).toBe(8);
        expect(features.chat).toBe(15);
        expect(features.flows).toBe(3);
    });

    it('includes ai_code_percentage in features_used when non-zero', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry({ai_code_percentage: 42.5})], map, false);

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.ai_code_percentage).toBeCloseTo(42.5, 5);
    });

    it('does not include ai_code_percentage in features_used when zero', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry({ai_code_percentage: 0})], map, false);

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.ai_code_percentage).toBeUndefined();
    });

    it('sets is_active=1 when completions_shown > 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({completions_shown: 10, cascade_sessions: 0, chat_messages: 0})],
            map,
            false,
        );

        expect(snap.is_active).toBe(1);
    });

    it('sets is_active=1 when cascade_sessions > 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({completions_shown: 0, cascade_sessions: 3, chat_messages: 0})],
            map,
            false,
        );

        expect(snap.is_active).toBe(1);
    });

    it('sets is_active=1 when chat_messages > 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({completions_shown: 0, cascade_sessions: 0, chat_messages: 5})],
            map,
            false,
        );

        expect(snap.is_active).toBe(1);
    });

    it('marks snapshot inactive when no usage activity', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({
            completions_shown: 0,
            completions_accepted: 0,
            cascade_sessions: 0,
            chat_messages: 0,
            flows_run: 0,
        });
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.is_active).toBe(0);
    });

    it('skips entries with no matching developer', () => {
        const map = new Map<string, string>();
        const result = transformMetrics([makeEntry()], map, false);

        expect(result).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const result = transformMetrics([], map, false);

        expect(result).toHaveLength(0);
    });

    it('produces separate snapshots for different dates', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry1 = makeEntry({date: '2024-01-15'});
        const entry2 = makeEntry({date: '2024-01-16'});
        const snapshots = transformMetrics([entry1, entry2], map, false);

        expect(snapshots).toHaveLength(2);
        const dates = snapshots.map((s) => s.date).sort();
        expect(dates).toEqual(['2024-01-15', '2024-01-16']);
    });

    it('stores raw_data when storeRawData=true', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry()], map, true);

        expect(snap.raw_data).not.toBeNull();
        const raw = JSON.parse(snap.raw_data!) as Record<string, unknown>;
        expect(raw.email).toBe(EMAIL);
    });

    it('leaves raw_data null when storeRawData=false', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry()], map, false);

        expect(snap.raw_data).toBeNull();
    });

    it('sets models_used to null (Windsurf has no model breakdown)', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry()], map, false);

        expect(snap.models_used).toBeNull();
    });

    it('sets estimated_cost to null (Windsurf does not report cost)', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry()], map, false);

        expect(snap.estimated_cost).toBeNull();
    });
});
