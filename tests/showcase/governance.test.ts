import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {insertShowcaseExample, getShowcaseExampleById, listShowcaseRemovalsForAuthor} from '../../src/showcase/store';
import {
    isExampleInTeamShowcase,
    removeExampleAsTeamLead,
    ShowcaseGovernanceError,
} from '../../src/showcase/governance';
import type {ShowcaseExample, ShowcasePublishRecord} from '../../src/showcase/types';

const NOW = '2026-06-13T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

function pub(db: Database.Database, overrides: Partial<ShowcasePublishRecord> = {}): ShowcaseExample {
    return insertShowcaseExample(db, {
        authorDeveloperId: 'alice',
        publishedAt: NOW,
        scope: 'team',
        scopeTarget: 'eng',
        title: 'example',
        taskType: 'refactor',
        tool: 'claude_code',
        content: 'redacted content',
        authorNote: null,
        ...overrides,
    });
}

function lead(reason: string | null = 'off-topic'): {removedByUserId: string; removedByEmail: string; reason: string | null} {
    return {removedByUserId: 'lead-user', removedByEmail: 'lead@test.com', reason};
}

describe('showcase governance service (Task 5.9)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        for (const t of ['eng', 'design']) {
            db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(t, NOW);
        }
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'carol', 'design');
    });

    afterEach(() => {
        db.close();
    });

    // --- Team-membership rule ---------------------------------------------

    it('treats a team-scoped example as belonging to its scope_target team', () => {
        const ex = pub(db, {scope: 'team', scopeTarget: 'eng'});
        expect(isExampleInTeamShowcase(db, ex, 'eng')).toBe(true);
        expect(isExampleInTeamShowcase(db, ex, 'design')).toBe(false);
    });

    it('treats an org-scoped example as belonging to its author’s current team', () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null});
        expect(isExampleInTeamShowcase(db, ex, 'eng')).toBe(true); // alice is on eng
        expect(isExampleInTeamShowcase(db, ex, 'design')).toBe(false);
    });

    // --- Removal happy path ------------------------------------------------

    it('removes a team example, logs it, and notifies the author — atomically', () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng', title: 'My ex'});
        const result = removeExampleAsTeamLead(db, {exampleId: ex.id, team: 'eng', ...lead()});

        expect(result.example.status).toBe('removed');
        expect(getShowcaseExampleById(db, ex.id)?.status).toBe('removed');

        const feed = listShowcaseRemovalsForAuthor(db, 'alice');
        expect(feed).toHaveLength(1);
        expect(feed[0]).toMatchObject({
            id: result.removalId,
            exampleTitle: 'My ex',
            removedByEmail: 'lead@test.com',
            team: 'eng',
            reason: 'off-topic',
        });
    });

    it('lets a lead remove their team’s org-wide contribution (author on the team)', () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null});
        const result = removeExampleAsTeamLead(db, {exampleId: ex.id, team: 'eng', ...lead(null)});
        expect(result.example.status).toBe('removed');
        expect(listShowcaseRemovalsForAuthor(db, 'alice')[0].reason).toBeNull();
    });

    // --- Authorization + state guards -------------------------------------

    it('refuses to remove an example outside the lead’s team (403 → not_team_showcase)', () => {
        const ex = pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design'});
        expect(() => removeExampleAsTeamLead(db, {exampleId: ex.id, team: 'eng', ...lead()})).toThrowError(
            ShowcaseGovernanceError,
        );
        try {
            removeExampleAsTeamLead(db, {exampleId: ex.id, team: 'eng', ...lead()});
        } catch (err) {
            expect((err as ShowcaseGovernanceError).code).toBe('not_team_showcase');
        }
        // Nothing changed; no audit row written.
        expect(getShowcaseExampleById(db, ex.id)?.status).toBe('published');
        expect(listShowcaseRemovalsForAuthor(db, 'carol')).toHaveLength(0);
    });

    it('returns example_not_found for a missing id', () => {
        try {
            removeExampleAsTeamLead(db, {exampleId: 'does-not-exist', team: 'eng', ...lead()});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as ShowcaseGovernanceError).code).toBe('example_not_found');
        }
    });

    it('refuses to remove an already-removed example (not_published) without double-logging', () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng'});
        removeExampleAsTeamLead(db, {exampleId: ex.id, team: 'eng', ...lead()});
        try {
            removeExampleAsTeamLead(db, {exampleId: ex.id, team: 'eng', ...lead()});
            throw new Error('expected throw');
        } catch (err) {
            expect((err as ShowcaseGovernanceError).code).toBe('not_published');
        }
        // Exactly one audit row from the single successful removal.
        expect(listShowcaseRemovalsForAuthor(db, 'alice')).toHaveLength(1);
    });
});
