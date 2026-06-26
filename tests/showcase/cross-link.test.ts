import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {createContribution} from '../../src/contributions/store';
import {hideOrgItemForTeam} from '../../src/contributions/scope';
import type {Contribution, ContributionScope, ContributionState} from '../../src/contributions/types';
import {
    CrossLinkError,
    linkShowcaseToPractice,
    listPracticesForShowcase,
    listShowcasesForPractice,
    unlinkShowcaseFromPractice,
} from '../../src/showcase/crossLink';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const DEV = 'dev1';

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        id,
        `${id}@test.com`,
        team,
        '2026-06-20T00:00:00.000Z',
    );
}

interface SeedOpts {
    scope?: ContributionScope;
    scopeTarget?: string | null;
    state?: ContributionState;
    /** UTC ISO; drives surfacing order (newest first). */
    timestamp?: string;
}

function seedShowcase(db: Database.Database, opts: SeedOpts = {}): Contribution {
    return createContribution(db, {
        contentType: 'showcase_example',
        title: 'showcase',
        authorId: DEV,
        scope: opts.scope ?? 'org',
        scopeTarget: opts.scopeTarget ?? null,
        state: opts.state ?? 'published',
        body: '{}',
        timestamp: opts.timestamp,
    });
}

function seedPractice(db: Database.Database, opts: SeedOpts = {}): Contribution {
    return createContribution(db, {
        contentType: 'best_practice',
        title: 'practice',
        authorId: DEV,
        scope: opts.scope ?? 'org',
        scopeTarget: opts.scopeTarget ?? null,
        state: opts.state ?? 'published',
        body: '{}',
        timestamp: opts.timestamp,
    });
}

describe('showcase <-> best-practice cross-link (#171)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seedDeveloper(db, DEV, 'eng');
    });

    afterEach(() => {
        db.close();
    });

    // --- AC#1: a showcase can link to a practice (validated creation) --------

    it('links a showcase to a practice and is idempotent', () => {
        const showcase = seedShowcase(db);
        const practice = seedPractice(db);

        expect(linkShowcaseToPractice(db, showcase.id, practice.id)).toBe(true);
        // Re-linking the same pair is a no-op (composite PK), not an error.
        expect(linkShowcaseToPractice(db, showcase.id, practice.id)).toBe(false);
    });

    it('rejects a link when the showcase id does not exist', () => {
        const practice = seedPractice(db);
        try {
            linkShowcaseToPractice(db, 'ghost', practice.id);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(CrossLinkError);
            expect((err as CrossLinkError).code).toBe('showcase_not_found');
        }
    });

    it('rejects a link when the practice id does not exist', () => {
        const showcase = seedShowcase(db);
        try {
            linkShowcaseToPractice(db, showcase.id, 'ghost');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as CrossLinkError).code).toBe('practice_not_found');
        }
    });

    it('rejects a link with the ends reversed (practice id in the showcase slot)', () => {
        const showcase = seedShowcase(db);
        const practice = seedPractice(db);
        // Passing the practice id where a showcase is expected must fail by content type.
        try {
            linkShowcaseToPractice(db, practice.id, showcase.id);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as CrossLinkError).code).toBe('not_a_showcase');
        }
    });

    it('rejects a link when the practice end is actually a showcase', () => {
        const showcase = seedShowcase(db);
        const otherShowcase = seedShowcase(db);
        try {
            linkShowcaseToPractice(db, showcase.id, otherShowcase.id);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as CrossLinkError).code).toBe('not_a_practice');
        }
    });

    it('rejects a link to a removed contribution', () => {
        const showcase = seedShowcase(db);
        const practice = seedPractice(db, {state: 'removed'});
        try {
            linkShowcaseToPractice(db, showcase.id, practice.id);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as CrossLinkError).code).toBe('removed');
        }
        // Nothing was written despite the validation failure.
        expect(listPracticesForShowcase(db, showcase.id, 'eng')).toHaveLength(0);
    });

    // --- AC#2: the link surfaces on BOTH sides ------------------------------

    it('surfaces the link both ways', () => {
        const showcase = seedShowcase(db);
        const practice = seedPractice(db);
        linkShowcaseToPractice(db, showcase.id, practice.id);

        const practices = listPracticesForShowcase(db, showcase.id, 'eng');
        expect(practices.map((c) => c.id)).toEqual([practice.id]);

        const showcases = listShowcasesForPractice(db, practice.id, 'eng');
        expect(showcases.map((c) => c.id)).toEqual([showcase.id]);
    });

    it('returns nothing for an unlinked showcase / practice', () => {
        const showcase = seedShowcase(db);
        const practice = seedPractice(db);
        expect(listPracticesForShowcase(db, showcase.id, 'eng')).toHaveLength(0);
        expect(listShowcasesForPractice(db, practice.id, 'eng')).toHaveLength(0);
    });

    it('orders multiple linked practices newest-first, deterministically', () => {
        const showcase = seedShowcase(db);
        const older = seedPractice(db, {timestamp: '2026-01-01T00:00:00.000Z'});
        const newer = seedPractice(db, {timestamp: '2026-03-01T00:00:00.000Z'});
        linkShowcaseToPractice(db, showcase.id, older.id);
        linkShowcaseToPractice(db, showcase.id, newer.id);

        const ids = listPracticesForShowcase(db, showcase.id, 'eng').map((c) => c.id);
        expect(ids).toEqual([newer.id, older.id]);
    });

    it('breaks a same-timestamp tie on id ascending (total, deterministic order)', () => {
        const showcase = seedShowcase(db);
        const ts = '2026-02-02T00:00:00.000Z';
        const a = seedPractice(db, {timestamp: ts});
        const b = seedPractice(db, {timestamp: ts});
        linkShowcaseToPractice(db, showcase.id, a.id);
        linkShowcaseToPractice(db, showcase.id, b.id);

        const ids = listPracticesForShowcase(db, showcase.id, 'eng').map((c) => c.id);
        const expected = [a.id, b.id].sort();
        expect(ids).toEqual(expected);
    });

    it('drops a link from surfacing once unlinked', () => {
        const showcase = seedShowcase(db);
        const practice = seedPractice(db);
        linkShowcaseToPractice(db, showcase.id, practice.id);
        expect(unlinkShowcaseFromPractice(db, showcase.id, practice.id)).toBe(true);
        // A second unlink finds nothing to remove.
        expect(unlinkShowcaseFromPractice(db, showcase.id, practice.id)).toBe(false);

        expect(listPracticesForShowcase(db, showcase.id, 'eng')).toHaveLength(0);
        expect(listShowcasesForPractice(db, practice.id, 'eng')).toHaveLength(0);
    });

    // --- AC#3: out-of-scope linked items are NOT exposed --------------------

    it('does not expose a team-scoped linked practice to a viewer on another team', () => {
        const showcase = seedShowcase(db); // org-wide
        const teamPractice = seedPractice(db, {scope: 'team', scopeTarget: 'eng'});
        linkShowcaseToPractice(db, showcase.id, teamPractice.id);

        // Same team sees it...
        expect(listPracticesForShowcase(db, showcase.id, 'eng').map((c) => c.id)).toEqual([teamPractice.id]);
        // ...a different team does not...
        expect(listPracticesForShowcase(db, showcase.id, 'sales')).toHaveLength(0);
        // ...and a teamless viewer does not.
        expect(listPracticesForShowcase(db, showcase.id, null)).toHaveLength(0);
    });

    it('does not expose a team-scoped linked showcase to a viewer on another team (reverse direction)', () => {
        const teamShowcase = seedShowcase(db, {scope: 'team', scopeTarget: 'eng'});
        const practice = seedPractice(db); // org-wide
        linkShowcaseToPractice(db, teamShowcase.id, practice.id);

        expect(listShowcasesForPractice(db, practice.id, 'eng').map((c) => c.id)).toEqual([teamShowcase.id]);
        expect(listShowcasesForPractice(db, practice.id, 'sales')).toHaveLength(0);
    });

    it('does not surface an unpublished linked practice', () => {
        const showcase = seedShowcase(db);
        const draftPractice = seedPractice(db, {state: 'draft'});
        const unpubPractice = seedPractice(db, {state: 'unpublished'});
        const livePractice = seedPractice(db);
        // Linking a draft is allowed (it'll surface once published); it just isn't surfaced yet.
        linkShowcaseToPractice(db, showcase.id, draftPractice.id);
        linkShowcaseToPractice(db, showcase.id, unpubPractice.id);
        linkShowcaseToPractice(db, showcase.id, livePractice.id);

        expect(listPracticesForShowcase(db, showcase.id, 'eng').map((c) => c.id)).toEqual([livePractice.id]);
    });

    it('respects a per-team hide of an org-wide linked practice', () => {
        const showcase = seedShowcase(db);
        const orgPractice = seedPractice(db); // org-wide
        linkShowcaseToPractice(db, showcase.id, orgPractice.id);
        hideOrgItemForTeam(db, {contributionId: orgPractice.id, team: 'eng', actorId: DEV, permitted: true});

        // Honored by default → hidden for the eng viewer...
        expect(listPracticesForShowcase(db, showcase.id, 'eng')).toHaveLength(0);
        // ...still visible to another team (the hide is per-team)...
        expect(listPracticesForShowcase(db, showcase.id, 'sales').map((c) => c.id)).toEqual([orgPractice.id]);
        // ...and visible to eng again when hides are not permitted.
        expect(
            listPracticesForShowcase(db, showcase.id, 'eng', {hidesPermitted: false}).map((c) => c.id),
        ).toEqual([orgPractice.id]);
    });
});
