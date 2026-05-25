import {describe, it, expect} from 'vitest';
import {transformMetrics, detectInactiveSeats} from '../../../src/connectors/copilot/transformer';
import type {CopilotUserMetrics, CopilotSeat} from '../../../src/connectors/copilot/client';

const DEV_ID = 'dev-uuid-1';
const LOGIN = 'alice';

function makeMetricsEntry(overrides: Partial<CopilotUserMetrics> = {}): CopilotUserMetrics {
    return {
        login: LOGIN,
        date: '2024-01-15',
        total_suggestions_count: 100,
        total_acceptances_count: 40,
        total_lines_suggested: 500,
        total_lines_accepted: 200,
        total_active_chat_count: 10,
        total_chat_insertion_events: 5,
        total_chat_copy_events: 3,
        breakdown: [
            {model: 'gpt-4o', acceptances_count: 30},
            {model: 'claude-sonnet', acceptances_count: 10},
        ],
        ...overrides,
    };
}

function makeSeat(overrides: Partial<CopilotSeat> = {}): CopilotSeat {
    return {
        login: LOGIN,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        pending_cancellation_date: null,
        last_activity_at: null,
        last_activity_editor: null,
        plan_type: 'copilot_business',
        assignee: {login: LOGIN},
        assigning_team: null,
        ...overrides,
    };
}

describe('transformMetrics', () => {
    it('maps a normal entry to a snapshot', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const [snap] = transformMetrics([makeMetricsEntry()], map, false);

        expect(snap.developer_id).toBe(DEV_ID);
        expect(snap.date).toBe('2024-01-15');
        expect(snap.tool).toBe('copilot');
        expect(snap.data_quality).toBe('high');
        expect(snap.data_source).toBe('api');
        expect(snap.is_active).toBe(1);
    });

    it('calculates interaction_count and acceptance_count correctly', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const [snap] = transformMetrics([makeMetricsEntry()], map, false);

        expect(snap.interaction_count).toBe(100);
        expect(snap.acceptance_count).toBe(40);
    });

    it('calculates acceptance_rate correctly', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const [snap] = transformMetrics([makeMetricsEntry()], map, false);

        expect(snap.acceptance_rate).toBeCloseTo(0.4, 5);
    });

    it('sets acceptance_rate to null when no suggestions', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const entry = makeMetricsEntry({total_suggestions_count: 0, total_acceptances_count: 0});
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.acceptance_rate).toBeNull();
    });

    it('populates features_used JSON correctly', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const [snap] = transformMetrics([makeMetricsEntry()], map, false);

        const features = JSON.parse(snap.features_used!) as Record<string, number>;
        expect(features.completions).toBe(100);
        expect(features.chat).toBe(10);
        expect(features.chat_insertions).toBe(5);
        expect(features.chat_copies).toBe(3);
    });

    it('populates models_used JSON from breakdown', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const [snap] = transformMetrics([makeMetricsEntry()], map, false);

        const models = JSON.parse(snap.models_used!) as Record<string, number>;
        expect(models['gpt-4o']).toBe(30);
        expect(models['claude-sonnet']).toBe(10);
    });

    it('sets models_used to null when no breakdown', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const entry = makeMetricsEntry({breakdown: []});
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.models_used).toBeNull();
    });

    it('skips entries with no matching developer', () => {
        const map = new Map<string, string>();
        const result = transformMetrics([makeMetricsEntry()], map, false);

        expect(result).toHaveLength(0);
    });

    it('returns empty array for empty metrics', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const result = transformMetrics([], map, false);

        expect(result).toHaveLength(0);
    });

    it('stores raw_data when storeRawData=true', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const entry = makeMetricsEntry();
        const [snap] = transformMetrics([entry], map, true);

        expect(snap.raw_data).not.toBeNull();
        const raw = JSON.parse(snap.raw_data!) as {login: string};
        expect(raw.login).toBe(LOGIN);
    });

    it('leaves raw_data null when storeRawData=false', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const [snap] = transformMetrics([makeMetricsEntry()], map, false);

        expect(snap.raw_data).toBeNull();
    });

    it('marks snapshot as inactive when counts are zero', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const entry = makeMetricsEntry({
            total_suggestions_count: 0,
            total_acceptances_count: 0,
            total_active_chat_count: 0,
        });
        const [snap] = transformMetrics([entry], map, false);

        expect(snap.is_active).toBe(0);
    });

    it('handles malformed breakdown entry without crashing', () => {
        const map = new Map([[LOGIN, DEV_ID]]);
        const entry = makeMetricsEntry({
            breakdown: [{model: undefined, acceptances_count: undefined}],
        });

        expect(() => transformMetrics([entry], map, false)).not.toThrow();
    });
});

describe('detectInactiveSeats', () => {
    it('flags a seat with no activity', () => {
        const seat = makeSeat({last_activity_at: null});
        const inactive = detectInactiveSeats([seat]);

        expect(inactive).toHaveLength(1);
        expect(inactive[0].login).toBe(LOGIN);
        expect(inactive[0].last_activity_at).toBeNull();
    });

    it('flags a seat inactive for 14+ days', () => {
        const asOf = new Date('2024-02-01T00:00:00Z');
        const seat = makeSeat({last_activity_at: '2024-01-14T00:00:00Z'});
        const inactive = detectInactiveSeats([seat], asOf);

        expect(inactive).toHaveLength(1);
        expect(inactive[0].days_inactive).toBeGreaterThanOrEqual(14);
    });

    it('does not flag an active seat', () => {
        const asOf = new Date('2024-02-01T00:00:00Z');
        const seat = makeSeat({last_activity_at: '2024-01-29T00:00:00Z'});
        const inactive = detectInactiveSeats([seat], asOf);

        expect(inactive).toHaveLength(0);
    });

    it('returns empty array for no seats', () => {
        expect(detectInactiveSeats([])).toHaveLength(0);
    });

    it('falls back to seat.login when assignee is null', () => {
        const seat = {
            ...makeSeat({last_activity_at: null}),
            assignee: null as unknown as {login: string},
        };
        const inactive = detectInactiveSeats([seat]);

        expect(inactive).toHaveLength(1);
        expect(inactive[0].login).toBe(LOGIN);
    });
});
