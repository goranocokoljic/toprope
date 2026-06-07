import {describe, it, expect} from 'vitest';
import {transformMetrics} from '../../../src/connectors/cursor/transformer';
import type {CursorUserMetrics} from '../../../src/connectors/cursor/client';

const DEV_ID = 'dev-uuid-1';
const EMAIL = 'alice@company.com';

function makeEntry(overrides: Partial<CursorUserMetrics> = {}): CursorUserMetrics {
    return {
        user_id: 'cur-user-1',
        email: EMAIL,
        date: '2024-01-15',
        autocomplete_shown: 100,
        autocomplete_accepted: 45,
        composer_requests: 8,
        chat_requests: 15,
        models_used: {'gpt-4o': 18, 'claude-3.5-sonnet': 5},
        estimated_cost: 3.25,
        ...overrides,
    };
}

describe('transformMetrics (cursor)', () => {
    it('maps a normal entry to a snapshot', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry()], map, false);

        expect(snap.developer_id).toBe(DEV_ID);
        expect(snap.date).toBe('2024-01-15');
        expect(snap.tool).toBe('cursor');
        expect(snap.data_quality).toBe('high');
        expect(snap.data_source).toBe('api');
        expect(snap.is_active).toBe(1);
    });

    it('sets interaction_count from autocomplete_shown', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry({autocomplete_shown: 80})], map, false);

        expect(snap.interaction_count).toBe(80);
    });

    it('sets acceptance_count from autocomplete_accepted', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry({autocomplete_accepted: 30})], map, false);

        expect(snap.acceptance_count).toBe(30);
    });

    it('calculates acceptance_rate from shown and accepted', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({autocomplete_shown: 100, autocomplete_accepted: 40});
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.acceptance_rate).toBeCloseTo(0.4, 5);
    });

    it('sets acceptance_rate to null when autocomplete_shown is 0', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({autocomplete_shown: 0, autocomplete_accepted: 0});
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.acceptance_rate).toBeNull();
    });

    it('distinguishes autocomplete, composer, and chat in features_used', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({autocomplete_accepted: 45, composer_requests: 8, chat_requests: 15})],
            map,
            false,
        );

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.autocomplete).toBe(45);
        expect(features.composer).toBe(8);
        expect(features.chat).toBe(15);
    });

    it('sets is_active=1 when only autocomplete is used', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({autocomplete_shown: 10, composer_requests: 0, chat_requests: 0})],
            map,
            false,
        );

        expect(snap.is_active).toBe(1);
    });

    it('sets is_active=1 when only composer is used', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({autocomplete_shown: 0, composer_requests: 3, chat_requests: 0})],
            map,
            false,
        );

        expect(snap.is_active).toBe(1);
    });

    it('sets is_active=1 when only chat is used', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({autocomplete_shown: 0, composer_requests: 0, chat_requests: 5})],
            map,
            false,
        );

        expect(snap.is_active).toBe(1);
    });

    it('marks snapshot inactive when no usage activity', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const entry = makeEntry({
            autocomplete_shown: 0,
            autocomplete_accepted: 0,
            composer_requests: 0,
            chat_requests: 0,
        });
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.is_active).toBe(0);
    });

    it('serializes models_used when present', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics(
            [makeEntry({models_used: {'gpt-4o': 12}})],
            map,
            false,
        );

        const models = JSON.parse(snap.models_used!) as Record<string, number>;
        expect(models['gpt-4o']).toBe(12);
    });

    it('sets models_used to null when absent or empty', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [noField] = transformMetrics([makeEntry({models_used: undefined})], map, false);
        const [empty] = transformMetrics([makeEntry({models_used: {}})], map, false);

        expect(noField.models_used).toBeNull();
        expect(empty.models_used).toBeNull();
    });

    it('sets estimated_cost when positive, null otherwise', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [withCost] = transformMetrics([makeEntry({estimated_cost: 5.5})], map, false);
        const [zeroCost] = transformMetrics([makeEntry({estimated_cost: 0})], map, false);
        const [noCost] = transformMetrics([makeEntry({estimated_cost: undefined})], map, false);

        expect(withCost.estimated_cost).toBeCloseTo(5.5, 5);
        expect(zeroCost.estimated_cost).toBeNull();
        expect(noCost.estimated_cost).toBeNull();
    });

    it('leaves tokens_consumed null (Cursor does not report tokens)', () => {
        const map = new Map([[EMAIL, DEV_ID]]);
        const [snap] = transformMetrics([makeEntry()], map, false);

        expect(snap.tokens_consumed).toBeNull();
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
});
