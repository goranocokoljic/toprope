import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    addMetricPin,
    getFeedback,
    getFeedbackCounts,
    getPracticeDetails,
    listFeedback,
    listMetricPins,
    listUsageEvents,
    recordFeedback,
    recordUsageEvent,
    removeMetricPin,
    setPracticeDetails,
    setPracticeEndorsed,
} from '../../src/practices/store';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';
const T3 = '2026-06-22T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        'eng',
        T1,
    );
}

/** Seed a published best-practice contribution and return its id. */
function seedContribution(db: Database.Database, id: string, authorId: string): string {
    db.prepare(
        `INSERT INTO contributions
         (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
         VALUES (?, 'best_practice', 'Use prepared statements', ?, 'org', NULL, 'published', 1, ?, ?)`,
    ).run(id, authorId, T1, T1);
    return id;
}

describe('practices store (#156)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice');
        seedDeveloper(db, 'bob');
        seedContribution(db, 'c1', 'alice');
    });

    afterEach(() => {
        db.close();
    });

    // --- Practice details ---------------------------------------------------

    describe('practice details', () => {
        it('returns undefined when no details have been set', () => {
            expect(getPracticeDetails(db, 'c1')).toBeUndefined();
        });

        it('inserts details on first set and reads them back', () => {
            const details = setPracticeDetails(db, 'c1', {modelUsed: 'claude-opus-4-8', endorsed: true});
            expect(details).toEqual({contributionId: 'c1', modelUsed: 'claude-opus-4-8', endorsed: true});
            expect(getPracticeDetails(db, 'c1')).toEqual(details);
        });

        it('defaults to NULL model and unendorsed when set with no fields', () => {
            const details = setPracticeDetails(db, 'c1');
            expect(details).toEqual({contributionId: 'c1', modelUsed: null, endorsed: false});
        });

        it('UPSERTs in place — a second set updates rather than duplicating', () => {
            setPracticeDetails(db, 'c1', {modelUsed: 'gpt', endorsed: false});
            const updated = setPracticeDetails(db, 'c1', {modelUsed: 'claude', endorsed: true});
            expect(updated).toEqual({contributionId: 'c1', modelUsed: 'claude', endorsed: true});
            const count = db.prepare('SELECT COUNT(*) AS n FROM practice_details WHERE contribution_id = ?').get('c1') as {
                n: number;
            };
            expect(count.n).toBe(1);
        });

        it('preserves an omitted field on update (model kept when only endorsed changes)', () => {
            setPracticeDetails(db, 'c1', {modelUsed: 'claude', endorsed: false});
            const updated = setPracticeDetails(db, 'c1', {endorsed: true});
            expect(updated).toEqual({contributionId: 'c1', modelUsed: 'claude', endorsed: true});
        });

        it('setPracticeEndorsed creates the row when absent and toggles the flag', () => {
            const created = setPracticeEndorsed(db, 'c1', true);
            expect(created).toEqual({contributionId: 'c1', modelUsed: null, endorsed: true});
            const toggled = setPracticeEndorsed(db, 'c1', false);
            expect(toggled.endorsed).toBe(false);
        });

        it('rejects details for a missing contribution (FK)', () => {
            expect(() => setPracticeDetails(db, 'ghost', {endorsed: true})).toThrow();
        });
    });

    // --- Metric pins --------------------------------------------------------

    describe('metric pins', () => {
        it('stores a pin and reads it back', () => {
            const pin = addMetricPin(db, {
                contributionId: 'c1',
                metric: 'churn',
                action: 'pin',
                actorId: 'alice',
                createdAt: T1,
            });
            expect(pin).toMatchObject({contributionId: 'c1', metric: 'churn', action: 'pin', actorId: 'alice'});
            expect(pin.id).toBeTruthy();
            const stored = listMetricPins(db, {contributionId: 'c1'});
            expect(stored).toHaveLength(1);
            expect(stored[0]).toEqual(pin);
        });

        it('stores a suppress override distinctly from a pin', () => {
            addMetricPin(db, {contributionId: 'c1', metric: 'churn', action: 'pin', actorId: 'alice', createdAt: T1});
            addMetricPin(db, {
                contributionId: 'c1',
                metric: 'churn',
                action: 'suppress',
                actorId: 'bob',
                createdAt: T2,
            });
            const pins = listMetricPins(db, {action: 'pin'});
            const suppressions = listMetricPins(db, {action: 'suppress'});
            expect(pins).toHaveLength(1);
            expect(suppressions).toHaveLength(1);
            expect(suppressions[0].actorId).toBe('bob');
        });

        it('filters by metric and lists newest first', () => {
            addMetricPin(db, {contributionId: 'c1', metric: 'churn', action: 'pin', actorId: 'a', createdAt: T1});
            addMetricPin(db, {contributionId: 'c1', metric: 'cost_per_pr', action: 'pin', actorId: 'a', createdAt: T2});
            addMetricPin(db, {contributionId: 'c1', metric: 'churn', action: 'suppress', actorId: 'a', createdAt: T3});
            const churn = listMetricPins(db, {contributionId: 'c1', metric: 'churn'});
            expect(churn.map((p) => p.createdAt)).toEqual([T3, T1]);
            expect(listMetricPins(db, {metric: 'cost_per_pr'})).toHaveLength(1);
        });

        it('lists everything with no filter', () => {
            addMetricPin(db, {contributionId: 'c1', metric: 'churn', action: 'pin', actorId: 'a'});
            addMetricPin(db, {contributionId: 'c1', metric: 'churn', action: 'suppress', actorId: 'a'});
            expect(listMetricPins(db)).toHaveLength(2);
        });

        it('removes a pin by id', () => {
            const pin = addMetricPin(db, {contributionId: 'c1', metric: 'churn', action: 'pin', actorId: 'a'});
            expect(removeMetricPin(db, pin.id)).toBe(true);
            expect(listMetricPins(db, {contributionId: 'c1'})).toHaveLength(0);
        });

        it('returns false removing a non-existent pin', () => {
            expect(removeMetricPin(db, 'nope')).toBe(false);
        });

        it('rejects a pin for a missing contribution (FK)', () => {
            expect(() =>
                addMetricPin(db, {contributionId: 'ghost', metric: 'churn', action: 'pin', actorId: 'a'}),
            ).toThrow();
        });
    });

    // --- Feedback -----------------------------------------------------------

    describe('feedback', () => {
        it('records a developer signal and reads it back', () => {
            const fb = recordFeedback(db, {
                contributionId: 'c1',
                developerId: 'alice',
                signal: 'helpful',
                createdAt: T1,
            });
            expect(fb).toMatchObject({contributionId: 'c1', developerId: 'alice', signal: 'helpful', createdAt: T1});
            expect(getFeedback(db, 'c1', 'alice')).toEqual(fb);
        });

        it('is one-per-dev — flipping a vote UPSERTs in place, keeping the row id', () => {
            const first = recordFeedback(db, {
                contributionId: 'c1',
                developerId: 'alice',
                signal: 'helpful',
                createdAt: T1,
            });
            const flipped = recordFeedback(db, {
                contributionId: 'c1',
                developerId: 'alice',
                signal: 'not_helpful',
                createdAt: T2,
            });
            // Same underlying row (id preserved), updated signal + timestamp.
            expect(flipped.id).toBe(first.id);
            expect(flipped.signal).toBe('not_helpful');
            expect(flipped.createdAt).toBe(T2);
            expect(listFeedback(db, 'c1')).toHaveLength(1);
        });

        it('keeps different developers’ feedback separate', () => {
            recordFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful', createdAt: T1});
            recordFeedback(db, {contributionId: 'c1', developerId: 'bob', signal: 'not_helpful', createdAt: T2});
            expect(listFeedback(db, 'c1')).toHaveLength(2);
            expect(getFeedback(db, 'c1', 'alice')?.signal).toBe('helpful');
            expect(getFeedback(db, 'c1', 'bob')?.signal).toBe('not_helpful');
        });

        it('returns undefined for a developer with no feedback', () => {
            expect(getFeedback(db, 'c1', 'bob')).toBeUndefined();
        });

        it('tallies helpful / not-helpful counts, counting a flipped vote once', () => {
            recordFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful', createdAt: T1});
            recordFeedback(db, {contributionId: 'c1', developerId: 'bob', signal: 'helpful', createdAt: T1});
            // Alice flips — must move from helpful to not_helpful, not double-count.
            recordFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'not_helpful', createdAt: T2});
            expect(getFeedbackCounts(db, 'c1')).toEqual({helpful: 1, notHelpful: 1});
        });

        it('returns zeroed counts for a practice with no feedback', () => {
            expect(getFeedbackCounts(db, 'c1')).toEqual({helpful: 0, notHelpful: 0});
        });

        it('rejects feedback for a missing developer (FK)', () => {
            expect(() =>
                recordFeedback(db, {contributionId: 'c1', developerId: 'ghost', signal: 'helpful'}),
            ).toThrow();
        });

        it('rejects feedback for a missing contribution (FK)', () => {
            expect(() =>
                recordFeedback(db, {contributionId: 'ghost', developerId: 'alice', signal: 'helpful'}),
            ).toThrow();
        });
    });

    // --- Usage events -------------------------------------------------------

    describe('usage events', () => {
        it('records a usage event and reads it back', () => {
            const ev = recordUsageEvent(db, {
                contributionId: 'c1',
                developerId: 'alice',
                event: 'viewed',
                metricContext: 'churn',
                occurredAt: T1,
            });
            expect(ev).toMatchObject({
                contributionId: 'c1',
                developerId: 'alice',
                event: 'viewed',
                metricContext: 'churn',
                occurredAt: T1,
            });
            expect(listUsageEvents(db, 'c1')).toEqual([ev]);
        });

        it('defaults metric_context to null when omitted', () => {
            const ev = recordUsageEvent(db, {contributionId: 'c1', developerId: 'alice', event: 'applied'});
            expect(ev.metricContext).toBeNull();
        });

        it('is append-only — multiple events for the same dev accumulate in time order', () => {
            recordUsageEvent(db, {contributionId: 'c1', developerId: 'alice', event: 'viewed', occurredAt: T1});
            recordUsageEvent(db, {contributionId: 'c1', developerId: 'alice', event: 'applied', occurredAt: T3});
            recordUsageEvent(db, {contributionId: 'c1', developerId: 'alice', event: 'viewed', occurredAt: T2});
            const events = listUsageEvents(db, 'c1');
            expect(events.map((e) => e.occurredAt)).toEqual([T1, T2, T3]);
        });

        it('accepts an open-enum event kind not in the known list', () => {
            const ev = recordUsageEvent(db, {contributionId: 'c1', developerId: 'alice', event: 'dismissed'});
            expect(ev.event).toBe('dismissed');
        });

        it('returns an empty list for a practice with no events', () => {
            expect(listUsageEvents(db, 'c1')).toEqual([]);
        });

        it('rejects an event for a missing contribution (FK)', () => {
            expect(() =>
                recordUsageEvent(db, {contributionId: 'ghost', developerId: 'alice', event: 'viewed'}),
            ).toThrow();
        });
    });
});
