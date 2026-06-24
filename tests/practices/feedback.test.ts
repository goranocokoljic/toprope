import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {getFeedback, getFeedbackCounts, listFeedback} from '../../src/practices/store';
import {
    feedbackRankScore,
    helpfulRatio,
    toggleFeedback,
    wilsonLowerBound,
} from '../../src/practices/feedback';

const T1 = '2026-06-20T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        'eng',
        T1,
    );
}

function seedContribution(db: Database.Database, id: string): void {
    db.prepare(
        `INSERT INTO contributions
         (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
         VALUES (?, 'best_practice', 'Use prepared statements', 'alice', 'org', NULL, 'published', 1, ?, ?)`,
    ).run(id, T1, T1);
}

describe('feedback mechanics (Task 6.2.4 / #159)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice');
        seedDeveloper(db, 'bob');
        seedContribution(db, 'c1');
    });

    afterEach(() => {
        db.close();
    });

    // --- helpful-ratio math --------------------------------------------------

    describe('wilsonLowerBound', () => {
        it('is 0 with no evidence (total 0)', () => {
            expect(wilsonLowerBound(0, 0)).toBe(0);
        });

        it('is 0 for an all-negative tally (0 helpful)', () => {
            expect(wilsonLowerBound(0, 4)).toBe(0);
        });

        it('always sits at or below the raw proportion', () => {
            // The lower bound discounts the proportion by uncertainty, so it never exceeds it.
            for (const [h, n] of [
                [1, 1],
                [3, 3],
                [8, 12],
                [40, 50],
            ] as const) {
                expect(wilsonLowerBound(h, n)).toBeLessThanOrEqual(h / n);
            }
        });

        it('rises toward the proportion as the sample grows (more votes = more confidence)', () => {
            // Same 100% proportion, more votes → a higher (more confident) lower bound.
            expect(wilsonLowerBound(10, 10)).toBeGreaterThan(wilsonLowerBound(1, 1));
            expect(wilsonLowerBound(50, 50)).toBeGreaterThan(wilsonLowerBound(10, 10));
        });

        it('ranks a credible majority above a single lone upvote', () => {
            // The whole point: 1/1 (raw 1.0) must NOT outrank 40/45 (raw ~0.89).
            expect(wilsonLowerBound(40, 45)).toBeGreaterThan(wilsonLowerBound(1, 1));
        });
    });

    describe('helpfulRatio', () => {
        it('is null when there is no feedback', () => {
            expect(helpfulRatio({helpful: 0, notHelpful: 0})).toBeNull();
        });

        it('is the raw helpful share otherwise', () => {
            expect(helpfulRatio({helpful: 8, notHelpful: 4})).toBeCloseTo(8 / 12, 10);
            expect(helpfulRatio({helpful: 3, notHelpful: 0})).toBe(1);
            expect(helpfulRatio({helpful: 0, notHelpful: 5})).toBe(0);
        });
    });

    describe('feedbackRankScore', () => {
        it('is 0 for a practice with no feedback', () => {
            expect(feedbackRankScore({helpful: 0, notHelpful: 0})).toBe(0);
        });

        it('equals the Wilson lower bound over helpful / total', () => {
            expect(feedbackRankScore({helpful: 8, notHelpful: 4})).toBe(wilsonLowerBound(8, 12));
        });
    });

    // --- togglable capture ---------------------------------------------------

    describe('toggleFeedback', () => {
        it('sets a signal when the developer has none', () => {
            const res = toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'});
            expect(res).toEqual({signal: 'helpful', removed: false});
            expect(getFeedback(db, 'c1', 'alice')?.signal).toBe('helpful');
        });

        it('pressing the SAME signal again clears it (toggle off)', () => {
            toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'});
            const res = toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'});
            expect(res).toEqual({signal: null, removed: true});
            expect(getFeedback(db, 'c1', 'alice')).toBeUndefined();
            expect(getFeedbackCounts(db, 'c1')).toEqual({helpful: 0, notHelpful: 0});
        });

        it('pressing the OTHER signal flips it (still one current signal)', () => {
            toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'});
            const res = toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'not_helpful'});
            expect(res).toEqual({signal: 'not_helpful', removed: false});
            expect(getFeedback(db, 'c1', 'alice')?.signal).toBe('not_helpful');
            expect(listFeedback(db, 'c1')).toHaveLength(1); // one current signal, not two rows
        });

        it('toggles cleanly through a full on → off → on cycle', () => {
            expect(toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'}).signal).toBe(
                'helpful',
            );
            expect(toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'}).signal).toBeNull();
            const back = toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'});
            expect(back.signal).toBe('helpful');
            expect(back.removed).toBe(false);
            expect(getFeedbackCounts(db, 'c1')).toEqual({helpful: 1, notHelpful: 0});
        });

        it('keeps developers independent — one toggling off does not touch another', () => {
            toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'});
            toggleFeedback(db, {contributionId: 'c1', developerId: 'bob', signal: 'helpful'});
            toggleFeedback(db, {contributionId: 'c1', developerId: 'alice', signal: 'helpful'}); // alice off
            expect(getFeedback(db, 'c1', 'alice')).toBeUndefined();
            expect(getFeedback(db, 'c1', 'bob')?.signal).toBe('helpful');
            expect(getFeedbackCounts(db, 'c1')).toEqual({helpful: 1, notHelpful: 0});
        });

        it('honors an explicit timestamp when setting', () => {
            const res = toggleFeedback(db, {
                contributionId: 'c1',
                developerId: 'alice',
                signal: 'helpful',
                createdAt: T1,
            });
            expect(res.signal).toBe('helpful');
            expect(getFeedback(db, 'c1', 'alice')?.createdAt).toBe(T1);
        });
    });
});
