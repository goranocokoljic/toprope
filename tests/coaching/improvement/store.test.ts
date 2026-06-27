import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../../dashboard/fixtures';
import {
    insertImprovementReview,
    listImprovementReviewsForDeveloper,
    getImprovementReviewForDeveloper,
    deleteImprovementReviewForDeveloper,
} from '../../../src/coaching/improvement/store';
import type {ImprovementReviewOutput} from '../../../src/coaching/improvement/types';

const NOW = '2026-06-15T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, 'eng', NOW);
}

function output(developerId: string, overrides: Partial<ImprovementReviewOutput> = {}): ImprovementReviewOutput {
    return {
        developerId,
        sessionId: 'sess-1',
        generatedAt: NOW,
        analysisModel: 'local-default',
        analysisLocation: 'local',
        reviewText: 'how this could be better',
        suggestions: [{category: 'specificity', suggestion: '2 of your 3 prompts were brief'}],
        analyzedCaptureCount: 3,
        ...overrides,
    };
}

describe('Improvement review store (Task 6.5)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice');
        seedDeveloper(db, 'bob');
    });

    afterEach(() => db.close());

    it('persists and reads back a review with its suggestions intact', () => {
        const saved = insertImprovementReview(db, output('alice'));
        expect(saved.id).toBeTruthy();
        const read = getImprovementReviewForDeveloper(db, 'alice', saved.id);
        expect(read).toBeDefined();
        expect(read!.analysisLocation).toBe('local');
        expect(read!.suggestions).toEqual([{category: 'specificity', suggestion: '2 of your 3 prompts were brief'}]);
        expect(read!.analyzedCaptureCount).toBe(3);
    });

    it('lists a developer’s own reviews newest-first and never another developer’s', () => {
        insertImprovementReview(db, output('alice', {generatedAt: '2026-06-15T00:00:00.000Z'}));
        insertImprovementReview(db, output('alice', {generatedAt: '2026-06-16T00:00:00.000Z'}));
        insertImprovementReview(db, output('bob'));

        const aliceList = listImprovementReviewsForDeveloper(db, 'alice');
        expect(aliceList).toHaveLength(2);
        expect(aliceList[0].generatedAt >= aliceList[1].generatedAt).toBe(true);
        expect(listImprovementReviewsForDeveloper(db, 'bob')).toHaveLength(1);
    });

    it('scopes get by developer_id — a valid id owned by another developer returns undefined', () => {
        const saved = insertImprovementReview(db, output('alice'));
        expect(getImprovementReviewForDeveloper(db, 'bob', saved.id)).toBeUndefined();
    });

    it('scopes delete by developer_id — another developer cannot delete the review', () => {
        const saved = insertImprovementReview(db, output('alice'));
        expect(deleteImprovementReviewForDeveloper(db, 'bob', saved.id)).toBe(false);
        expect(getImprovementReviewForDeveloper(db, 'alice', saved.id)).toBeDefined();
        expect(deleteImprovementReviewForDeveloper(db, 'alice', saved.id)).toBe(true);
        expect(getImprovementReviewForDeveloper(db, 'alice', saved.id)).toBeUndefined();
    });

    it('drops a suggestion with an unknown category at the write boundary (allowlist)', () => {
        const bad = output('alice', {
            suggestions: [
                {category: 'specificity', suggestion: 'keep me'},
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                {category: 'sneaky' as any, suggestion: 'drop me'},
            ],
        });
        const saved = insertImprovementReview(db, bad);
        expect(saved.suggestions).toEqual([{category: 'specificity', suggestion: 'keep me'}]);
        const read = getImprovementReviewForDeveloper(db, 'alice', saved.id);
        expect(read!.suggestions).toEqual([{category: 'specificity', suggestion: 'keep me'}]);
    });

    it('preserves a real cloud location but decodes a corrupt one to the safe local default', () => {
        // Positive control: a genuine cloud run reads back as cloud (not coerced).
        const cloud = insertImprovementReview(db, output('alice', {analysisLocation: 'cloud', analysisModel: 'cloud-x'}));
        expect(getImprovementReviewForDeveloper(db, 'alice', cloud.id)!.analysisLocation).toBe('cloud');

        // Corruption / a future enum: bypass the column CHECK to write a value the
        // decoder must defend against, then assert it falls back to 'local'.
        const saved = insertImprovementReview(db, output('alice'));
        db.pragma('ignore_check_constraints = ON');
        db.prepare('UPDATE improvement_reviews SET analysis_location = ? WHERE id = ?').run('martian', saved.id);
        db.pragma('ignore_check_constraints = OFF');
        expect(getImprovementReviewForDeveloper(db, 'alice', saved.id)!.analysisLocation).toBe('local');
    });

    it('returns an empty suggestion list when the stored JSON is unparseable', () => {
        const saved = insertImprovementReview(db, output('alice'));
        db.prepare('UPDATE improvement_reviews SET suggestions = ? WHERE id = ?').run('not json', saved.id);
        const read = getImprovementReviewForDeveloper(db, 'alice', saved.id);
        expect(read!.suggestions).toEqual([]);
    });

    it('returns an empty suggestion list when the stored JSON parses but is not an array', () => {
        const saved = insertImprovementReview(db, output('alice'));
        db.prepare('UPDATE improvement_reviews SET suggestions = ? WHERE id = ?').run('{}', saved.id);
        expect(getImprovementReviewForDeveloper(db, 'alice', saved.id)!.suggestions).toEqual([]);
    });

    it('drops malformed/unknown-category entries on READ, keeping only well-formed ones', () => {
        const saved = insertImprovementReview(db, output('alice'));
        // A directly-written array mixing one valid entry with a bad-category entry, a
        // non-string suggestion, and a non-object — only the valid one must survive.
        const corrupt = JSON.stringify([
            {category: 'iteration', suggestion: 'keep me'},
            {category: 'sneaky', suggestion: 'drop me'},
            {category: 'context', suggestion: 42},
            'not an object',
        ]);
        db.prepare('UPDATE improvement_reviews SET suggestions = ? WHERE id = ?').run(corrupt, saved.id);
        expect(getImprovementReviewForDeveloper(db, 'alice', saved.id)!.suggestions).toEqual([
            {category: 'iteration', suggestion: 'keep me'},
        ]);
    });

    it('breaks a same-generated_at ordering tie deterministically on created_at (newest first)', () => {
        // Two reviews for the same conversation at the same generated_at instant — the
        // local-then-cloud same-instant case. The created_at secondary key must order them.
        const a = insertImprovementReview(db, output('alice', {generatedAt: NOW}));
        const b = insertImprovementReview(db, output('alice', {generatedAt: NOW}));
        // Force distinct, known created_at values (server-assigned timestamps can collide).
        db.prepare('UPDATE improvement_reviews SET created_at = ? WHERE id = ?').run('2026-06-15T00:00:00.001Z', a.id);
        db.prepare('UPDATE improvement_reviews SET created_at = ? WHERE id = ?').run('2026-06-15T00:00:00.002Z', b.id);
        const list = listImprovementReviewsForDeveloper(db, 'alice');
        expect(list.map((r) => r.id)).toEqual([b.id, a.id]); // newest created_at first
    });
});
