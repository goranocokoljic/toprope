import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {getContribution} from '../../src/contributions/store';
import {draftSelfPublish, submitForReview} from '../../src/showcase/publishPaths';
import {addAnnotation} from '../../src/showcase/unitsStore';
import {
    addShowcaseAnnotation,
    AnnotationError,
    assembleInlineDisplay,
    editShowcaseAnnotation,
    getAnnotationHistory,
    listShowcaseAnnotations,
} from '../../src/showcase/annotations';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const DEV = 'dev1';
const OTHER = 'dev2';

/** A three-turn conversation with no explicit ids → refs anchor by index "0".."2". */
const CONVO = '[{"role":"user","text":"write a test"},{"role":"assistant","text":"ok"},{"role":"user","text":"now the code"}]';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        id,
        `${id}@test.com`,
        'eng',
        '2026-06-20T00:00:00.000Z',
    );
}

/** Draft a self-publish showcase owned by DEV; returns its contribution id. */
function draft(db: Database.Database, conversation: string = CONVO): string {
    const {contribution} = draftSelfPublish(db, {
        developerId: DEV,
        title: 'A great session',
        conversation,
        curatorsNote: 'shows test-first prompting',
    });
    return contribution.id;
}

describe('showcase annotations (#166)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seedDeveloper(db, DEV);
        seedDeveloper(db, OTHER);
    });

    afterEach(() => {
        db.close();
    });

    // --- anchoring ----------------------------------------------------------

    it('anchors an annotation to a turn by index and stores it', () => {
        const id = draft(db);
        const ann = addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: 'gave it the failing test first'});
        expect(ann.turnRef).toBe('0');
        expect(ann.authorId).toBe(DEV);
        expect(listShowcaseAnnotations(db, id).map((a) => a.body)).toEqual(['gave it the failing test first']);
    });

    it('anchors by an explicit turn id when the conversation provides one', () => {
        const id = draft(db, '[{"id":"turn-a","text":"x"},{"id":"turn-b","text":"y"}]');
        const ann = addShowcaseAnnotation(db, {contributionId: id, turnRef: 'turn-b', authorId: DEV, body: 'why turn b'});
        expect(ann.turnRef).toBe('turn-b');
    });

    it('rejects an annotation whose turnRef does not anchor to any turn', () => {
        const id = draft(db);
        expect(() => addShowcaseAnnotation(db, {contributionId: id, turnRef: '9', authorId: DEV, body: 'dangling'})).toThrow(
            AnnotationError,
        );
        try {
            addShowcaseAnnotation(db, {contributionId: id, turnRef: 'nope', authorId: DEV, body: 'dangling'});
        } catch (e) {
            expect((e as AnnotationError).code).toBe('turn_not_found');
        }
        // Nothing persisted on a rejected anchor.
        expect(listShowcaseAnnotations(db, id)).toEqual([]);
    });

    it('rejects any anchor when the conversation has no parseable turns', () => {
        const id = draft(db, 'not json at all');
        try {
            addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: 'x'});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('turn_not_found');
        }
    });

    // --- author restriction -------------------------------------------------

    it('only the conversation developer-author may add an annotation', () => {
        const id = draft(db);
        try {
            addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: OTHER, body: 'not mine to write'});
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(AnnotationError);
            expect((e as AnnotationError).code).toBe('not_author');
        }
        expect(listShowcaseAnnotations(db, id)).toEqual([]);
    });

    it('only the author may edit an annotation', () => {
        const id = draft(db);
        const ann = addShowcaseAnnotation(db, {contributionId: id, turnRef: '1', authorId: DEV, body: 'original'});
        try {
            editShowcaseAnnotation(db, ann.id, {actorId: OTHER, body: 'hijacked'});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('not_author');
        }
        expect(listShowcaseAnnotations(db, id).map((a) => a.body)).toEqual(['original']);
    });

    // --- editable pre-publish + versioning ----------------------------------

    it('edits an annotation in place before publish', () => {
        const id = draft(db);
        const ann = addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: 'v1 reasoning'});
        const edited = editShowcaseAnnotation(db, ann.id, {actorId: DEV, body: 'v2 reasoning'});
        expect(edited.id).toBe(ann.id);
        expect(edited.body).toBe('v2 reasoning');
        expect(listShowcaseAnnotations(db, id).map((a) => a.body)).toEqual(['v2 reasoning']);
    });

    it('versions every annotation change on the unit lineage, retaining prior bodies', () => {
        const id = draft(db);
        expect(getContribution(db, id)?.currentVersion).toBe(1); // v1 = raw conversation

        const ann = addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: 'first take'});
        expect(getContribution(db, id)?.currentVersion).toBe(2);

        editShowcaseAnnotation(db, ann.id, {actorId: DEV, body: 'sharper take'});
        expect(getContribution(db, id)?.currentVersion).toBe(3);

        const history = getAnnotationHistory(db, id);
        expect(history).toHaveLength(3);
        expect(history[0]).toEqual([]); // v1 conversation has no annotation layer
        expect(history[1].map((a) => a.body)).toEqual(['first take']); // prior body retained...
        expect(history[2].map((a) => a.body)).toEqual(['sharper take']); // ...alongside the new one
    });

    it('refuses to add or edit once the showcase is submitted (frozen pre-publish)', () => {
        const id = draft(db);
        const ann = addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: 'before submit'});
        submitForReview(db, {contributionId: id, actorId: DEV});

        try {
            addShowcaseAnnotation(db, {contributionId: id, turnRef: '1', authorId: DEV, body: 'too late'});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('not_editable');
        }
        try {
            editShowcaseAnnotation(db, ann.id, {actorId: DEV, body: 'too late'});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('not_editable');
        }
        // The frozen content is unchanged.
        expect(listShowcaseAnnotations(db, id).map((a) => a.body)).toEqual(['before submit']);
    });

    // --- inline display -----------------------------------------------------

    it('assembles inline display with annotations beside their anchored turns, in order', () => {
        const id = draft(db);
        addShowcaseAnnotation(db, {contributionId: id, turnRef: '2', authorId: DEV, body: 'note on turn 2', timestamp: '2026-06-20T00:00:00.000Z'});
        addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: 'first note on 0', timestamp: '2026-06-20T00:00:01.000Z'});
        addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: 'second note on 0', timestamp: '2026-06-20T00:00:02.000Z'});

        const display = assembleInlineDisplay(db, id);
        expect(display).toBeDefined();
        expect(display!.turns).toHaveLength(3);
        expect(display!.turns.map((t) => t.turnRef)).toEqual(['0', '1', '2']);
        // Turn 0 carries both notes, oldest-first; turn 1 none; turn 2 one.
        expect(display!.turns[0].annotations.map((a) => a.body)).toEqual(['first note on 0', 'second note on 0']);
        expect(display!.turns[1].annotations).toEqual([]);
        expect(display!.turns[2].annotations.map((a) => a.body)).toEqual(['note on turn 2']);
        // The raw turn payload travels with each turn for rendering.
        expect((display!.turns[0].turn as {text: string}).text).toBe('write a test');
        expect(display!.orphaned).toEqual([]);
    });

    it('returns undefined inline display for a non-showcase id', () => {
        expect(assembleInlineDisplay(db, 'ghost')).toBeUndefined();
    });

    it('surfaces an annotation that no longer anchors as orphaned (drift), never dropping it', () => {
        // The conversation is unparseable, so no turn refs exist. Insert a row directly
        // through the store (bypassing the service anchoring guard) to simulate drift.
        const id = draft(db, 'no longer valid json');
        addAnnotation(db, {contributionId: id, turnRef: 'gone', authorId: DEV, body: 'stranded note'});

        const display = assembleInlineDisplay(db, id);
        expect(display).toBeDefined();
        expect(display!.turns).toEqual([]); // unparseable conversation → no turns, no throw
        expect(display!.orphaned.map((a) => a.body)).toEqual(['stranded note']);
    });

    // --- guards -------------------------------------------------------------

    it('rejects a blank annotation body', () => {
        const id = draft(db);
        try {
            addShowcaseAnnotation(db, {contributionId: id, turnRef: '0', authorId: DEV, body: '   '});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('empty_body');
        }
    });

    it('rejects pointing at a ghost id (not_found) or a non-showcase contribution (not_showcase)', () => {
        try {
            addShowcaseAnnotation(db, {contributionId: 'ghost', turnRef: '0', authorId: DEV, body: 'x'});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('not_found');
        }

        // A best-practice contribution (no showcase unit) is not a showcase.
        db.prepare(
            `INSERT INTO contributions
             (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
             VALUES ('bp1', 'best_practice', 't', ?, 'org', NULL, 'draft', 1, 'now', 'now')`,
        ).run(DEV);
        try {
            addShowcaseAnnotation(db, {contributionId: 'bp1', turnRef: '0', authorId: DEV, body: 'x'});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('not_showcase');
        }
    });

    it('rejects editing a non-existent annotation', () => {
        try {
            editShowcaseAnnotation(db, 'no-such-annotation', {actorId: DEV, body: 'x'});
            throw new Error('should have thrown');
        } catch (e) {
            expect((e as AnnotationError).code).toBe('annotation_not_found');
        }
    });
});
