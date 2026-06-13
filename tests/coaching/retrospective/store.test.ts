import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../../dashboard/fixtures';
import {
    insertRetrospective,
    listRetrospectivesForDeveloper,
    getRetrospectiveForDeveloper,
    deleteRetrospectiveForDeveloper,
} from '../../../src/coaching/retrospective/store';
import type {RetrospectiveOutput} from '../../../src/coaching/retrospective/types';

const NOW = '2026-06-15T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

function output(developerId: string, overrides: Partial<RetrospectiveOutput> = {}): RetrospectiveOutput {
    return {
        developerId,
        sessionId: 'sess-1',
        generatedAt: NOW,
        analysisModel: 'local-default',
        analysisLocation: 'local',
        retrospectiveText: 'Here is your session retrospective.',
        highlights: {worked: ['good context'], improve: ['be more specific']},
        analyzedCaptureCount: 3,
        ...overrides,
    };
}

describe('Retrospective store (Task 5.7)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    it('inserts and reads back a retrospective with its highlights', () => {
        const saved = insertRetrospective(db, output('alice'));
        expect(saved.id).toBeTruthy();
        expect(saved.createdAt).toBeTruthy();
        const fetched = getRetrospectiveForDeveloper(db, 'alice', saved.id);
        expect(fetched).toBeDefined();
        expect(fetched!.retrospectiveText).toBe('Here is your session retrospective.');
        expect(fetched!.analysisLocation).toBe('local');
        expect(fetched!.highlights).toEqual({worked: ['good context'], improve: ['be more specific']});
        expect(fetched!.analyzedCaptureCount).toBe(3);
    });

    it('persists analysis_location for both local and cloud', () => {
        const local = insertRetrospective(db, output('alice', {analysisLocation: 'local', analysisModel: 'local-default'}));
        const cloud = insertRetrospective(db, output('alice', {analysisLocation: 'cloud', analysisModel: 'cloud-x'}));
        expect(getRetrospectiveForDeveloper(db, 'alice', local.id)!.analysisLocation).toBe('local');
        expect(getRetrospectiveForDeveloper(db, 'alice', cloud.id)!.analysisLocation).toBe('cloud');
    });

    it('rejects an unknown analysis_location at the DB CHECK', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO retrospectives (id, developer_id, session_id, generated_at, analysis_model, analysis_location, retrospective_text, highlights, analyzed_capture_count, created_at)
                     VALUES ('r1','alice','s','${NOW}','m','elsewhere','t',NULL,1,'${NOW}')`,
                )
                .run(),
        ).toThrow();
    });

    it('stores null highlights without error', () => {
        const saved = insertRetrospective(db, output('alice', {highlights: null}));
        expect(getRetrospectiveForDeveloper(db, 'alice', saved.id)!.highlights).toBeNull();
    });

    it('lists a developer’s own retrospectives newest first', () => {
        insertRetrospective(db, output('alice', {generatedAt: '2026-06-15T00:00:00.000Z'}));
        insertRetrospective(db, output('alice', {generatedAt: '2026-06-16T00:00:00.000Z'}));
        const list = listRetrospectivesForDeveloper(db, 'alice');
        expect(list).toHaveLength(2);
        expect(list[0].generatedAt).toBe('2026-06-16T00:00:00.000Z');
    });

    it('scopes reads to the owner (no cross-developer access)', () => {
        const saved = insertRetrospective(db, output('alice'));
        expect(getRetrospectiveForDeveloper(db, 'bob', saved.id)).toBeUndefined();
        expect(listRetrospectivesForDeveloper(db, 'bob')).toHaveLength(0);
    });

    it('scopes deletes to the owner', () => {
        const saved = insertRetrospective(db, output('alice'));
        expect(deleteRetrospectiveForDeveloper(db, 'bob', saved.id)).toBe(false);
        expect(getRetrospectiveForDeveloper(db, 'alice', saved.id)).toBeDefined();
        expect(deleteRetrospectiveForDeveloper(db, 'alice', saved.id)).toBe(true);
        expect(getRetrospectiveForDeveloper(db, 'alice', saved.id)).toBeUndefined();
    });

    it('cascades retrospectives when the developer is deleted', () => {
        const saved = insertRetrospective(db, output('alice'));
        db.prepare('DELETE FROM developers WHERE id = ?').run('alice');
        expect(getRetrospectiveForDeveloper(db, 'alice', saved.id)).toBeUndefined();
    });
});
