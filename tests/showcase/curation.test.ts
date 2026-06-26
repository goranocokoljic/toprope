import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {createContribution, getContribution} from '../../src/contributions/store';
import {listReviewEvents} from '../../src/contributions/store';
import {
    approveAsDeveloper,
    draftSelfPublish,
    publishShowcase,
    submitForReview,
} from '../../src/showcase/publishPaths';
import {addShowcaseAnnotation} from '../../src/showcase/annotations';
import {assembleCuratedUnit, curatorsNoteGate, CurationError} from '../../src/showcase/curation';
import type {PrePublishContext} from '../../src/contributions/stateMachine';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const DEV = 'dev1';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        id,
        `${id}@test.com`,
        'eng',
        '2026-06-20T00:00:00.000Z',
    );
}

function eventTypes(db: Database.Database, contributionId: string): string[] {
    return listReviewEvents(db, contributionId).map((e) => e.event);
}

/** Drive a freshly drafted showcase to the `submitted` + developer-approved state. */
function submitAndApprove(db: Database.Database, contributionId: string): void {
    submitForReview(db, {contributionId, actorId: DEV});
    approveAsDeveloper(db, {contributionId, developerId: DEV, visibilityScope: 'org'});
}

/** Blank the curators' note directly, sidestepping the store's draft-time gate. */
function blankCuratorsNote(db: Database.Database, contributionId: string): void {
    db.prepare('UPDATE showcase_units SET curators_note = ? WHERE contribution_id = ?').run('   ', contributionId);
}

const CONVERSATION = '[{"id":"t0","role":"user","text":"hi"},{"id":"t1","role":"assistant","text":"yo"}]';

describe('showcase curation — mandatory note gate + prominent display (#167)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seedDeveloper(db, DEV);
    });

    afterEach(() => {
        db.close();
    });

    // --- AC#1: publish is blocked if curators_note is empty (hard gate) ------

    it('publishes normally when the curators note is present (gate does not block valid units)', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 'great session',
            conversation: CONVERSATION,
            curatorsNote: 'shows test-first prompting',
        });
        submitAndApprove(db, contribution.id);

        const published = publishShowcase(db, {contributionId: contribution.id, actorId: DEV});
        expect(published.state).toBe('published');
    });

    it('blocks publish when the curators note is blank, and rolls the publish back', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 'great session',
            conversation: CONVERSATION,
            curatorsNote: 'real note at draft time',
        });
        submitAndApprove(db, contribution.id);
        // A blank note sneaks in AFTER the draft-time gate (e.g. a direct write).
        blankCuratorsNote(db, contribution.id);

        let err: unknown;
        try {
            publishShowcase(db, {contributionId: contribution.id, actorId: DEV});
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(CurationError);
        expect((err as CurationError).code).toBe('missing_curators_note');

        // The throwing hook rolled the whole publish back: still submitted, never published.
        expect(getContribution(db, contribution.id)?.state).toBe('submitted');
        expect(eventTypes(db, contribution.id)).not.toContain('published');
    });

    it('the mandatory gate runs BEFORE caller-supplied hooks (a blank note short-circuits them)', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'note',
        });
        submitAndApprove(db, contribution.id);
        blankCuratorsNote(db, contribution.id);

        let callerHookRan = false;
        expect(() =>
            publishShowcase(db, {
                contributionId: contribution.id,
                actorId: DEV,
                prePublishHooks: [
                    () => {
                        callerHookRan = true;
                    },
                ],
            }),
        ).toThrow(CurationError);
        // The note gate threw first, so the caller's scrub/review hook never executed.
        expect(callerHookRan).toBe(false);
    });

    it('runs caller-supplied hooks after the gate when the note is valid', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'valid note',
        });
        submitAndApprove(db, contribution.id);

        let callerHookRan = false;
        const published = publishShowcase(db, {
            contributionId: contribution.id,
            actorId: DEV,
            prePublishHooks: [
                () => {
                    callerHookRan = true;
                },
            ],
        });
        expect(published.state).toBe('published');
        expect(callerHookRan).toBe(true);
    });

    // --- curatorsNoteGate as a unit (direct hook contract) ------------------

    it('curatorsNoteGate throws not_showcase for a contribution with no unit', () => {
        const contribution = createContribution(db, {
            contentType: 'best_practice',
            title: 'not a showcase',
            authorId: DEV,
            scope: 'team',
            scopeTarget: 'eng',
            state: 'submitted',
            body: 'x',
            changeNote: 'init',
        });
        const ctx: PrePublishContext = {
            db,
            contribution,
            actorId: DEV,
            timestamp: '2026-06-26T00:00:00.000Z',
        };
        let err: unknown;
        try {
            curatorsNoteGate(ctx);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(CurationError);
        expect((err as CurationError).code).toBe('not_showcase');
    });

    it('curatorsNoteGate passes for a unit with a real note', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'a takeaway',
        });
        const ctx: PrePublishContext = {
            db,
            contribution,
            actorId: DEV,
            timestamp: '2026-06-26T00:00:00.000Z',
        };
        expect(() => curatorsNoteGate(ctx)).not.toThrow();
    });

    // --- AC#2 / AC#3: outcome captured + note/outcome render prominently -----

    it('assembleCuratedUnit surfaces the note and outcome link as prominent header fields', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'what to take away',
            outcomeLink: 'https://github.com/org/repo/pull/42',
        });

        const view = assembleCuratedUnit(db, contribution.id);
        expect(view).toBeDefined();
        expect(view?.curatorsNote).toBe('what to take away');
        expect(view?.outcomeLink).toBe('https://github.com/org/repo/pull/42');
        expect(view?.hasOutcomeLink).toBe(true);
        // The body is the canonical inline display: one entry per conversation turn.
        expect(view?.display.turns.map((t) => t.turnRef)).toEqual(['t0', 't1']);
    });

    it('reports hasOutcomeLink=false when no outcome was captured', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'note only',
        });
        const view = assembleCuratedUnit(db, contribution.id);
        expect(view?.outcomeLink).toBeNull();
        expect(view?.hasOutcomeLink).toBe(false);
    });

    it('treats a whitespace-only outcome link as absent for display prominence', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'note',
            outcomeLink: '   ',
        });
        const view = assembleCuratedUnit(db, contribution.id);
        expect(view?.outcomeLink).toBe('   ');
        expect(view?.hasOutcomeLink).toBe(false);
    });

    it('merges inline annotations into the display body beside their anchored turn', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'note',
            outcomeLink: 'goal: ship the parser',
        });
        addShowcaseAnnotation(db, {
            contributionId: contribution.id,
            turnRef: 't1',
            authorId: DEV,
            body: 'I gave it the failing test first on purpose',
        });

        const view = assembleCuratedUnit(db, contribution.id);
        const t1 = view?.display.turns.find((t) => t.turnRef === 't1');
        expect(t1?.annotations.map((a) => a.body)).toEqual(['I gave it the failing test first on purpose']);
        // Header still carries the curation fields above the body.
        expect(view?.curatorsNote).toBe('note');
        expect(view?.hasOutcomeLink).toBe(true);
    });

    it('returns undefined for a non-showcase / unknown id', () => {
        const contribution = createContribution(db, {
            contentType: 'best_practice',
            title: 'a practice',
            authorId: DEV,
            scope: 'team',
            scopeTarget: 'eng',
            state: 'draft',
            body: 'x',
            changeNote: 'init',
        });
        expect(assembleCuratedUnit(db, contribution.id)).toBeUndefined();
        expect(assembleCuratedUnit(db, 'ghost-id')).toBeUndefined();
    });
});
