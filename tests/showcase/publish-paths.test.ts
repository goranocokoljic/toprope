import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {getContribution} from '../../src/contributions/store';
import {listReviewEvents} from '../../src/contributions/store';
import {ContributionStateError} from '../../src/contributions/stateMachine';
import {getConsent, getShowcaseUnit} from '../../src/showcase/unitsStore';
import {
    approveAsDeveloper,
    draftSelfPublish,
    proposeJointCuration,
    publishShowcase,
    ShowcasePublishError,
    submitForReview,
} from '../../src/showcase/publishPaths';
import {confirmManualReview} from '../../src/showcase/manualReview';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const DEV = 'dev1';
const MANAGER = 'mgr1';

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

describe('showcase publishPaths (#165)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seedDeveloper(db, DEV);
        seedDeveloper(db, MANAGER);
    });

    afterEach(() => {
        db.close();
    });

    // --- self_publish path (developer-initiated) ----------------------------

    it('self_publish path works end to end (developer drafts, submits, approves, publishes)', () => {
        const {contribution, unit} = draftSelfPublish(db, {
            developerId: DEV,
            title: 'A great session',
            conversation: '[{"role":"user","text":"hi"}]',
            curatorsNote: 'shows test-first prompting',
        });
        expect(contribution.state).toBe('draft');
        expect(contribution.authorId).toBe(DEV);
        expect(unit.publishPath).toBe('self_publish');

        submitForReview(db, {contributionId: contribution.id, actorId: DEV});
        expect(getContribution(db, contribution.id)?.state).toBe('submitted');

        approveAsDeveloper(db, {contributionId: contribution.id, developerId: DEV, visibilityScope: 'org'});
        // The mandatory manual review (6.3.6) must be confirmed before publish.
        confirmManualReview(db, {contributionId: contribution.id, actorId: DEV});
        const published = publishShowcase(db, {contributionId: contribution.id, actorId: DEV});

        expect(published.state).toBe('published');
        expect(getContribution(db, contribution.id)?.state).toBe('published');
        // Audit trail records the full lifecycle, including the manual-review confirmation.
        expect(eventTypes(db, contribution.id)).toEqual(['submitted', 'approved', 'reviewed', 'published']);
        // Consent recorded with the explicit scope the developer chose.
        const consent = getConsent(db, contribution.id, DEV);
        expect(consent?.approved).toBe(true);
        expect(consent?.visibilityScope).toBe('org');
    });

    // --- joint_curation path (manager proposes, developer approves) ---------

    it('joint_curation path works end to end and pins the developer as author', () => {
        const {contribution} = proposeJointCuration(db, {
            developerId: DEV,
            managerId: MANAGER,
            title: 'Manager spotted this',
            conversation: '[{"role":"user","text":"hi"}]',
            curatorsNote: 'great refactor dialogue',
        });
        // The developer — not the manager — is the author the gate pins on.
        expect(contribution.authorId).toBe(DEV);
        // The proposal is recorded in the audit trail, attributed to the manager.
        const proposed = listReviewEvents(db, contribution.id).find((e) => e.event === 'proposed');
        expect(proposed?.actorId).toBe(MANAGER);
        expect(contribution.state).toBe('draft');

        submitForReview(db, {contributionId: contribution.id, actorId: MANAGER});
        approveAsDeveloper(db, {contributionId: contribution.id, developerId: DEV, visibilityScope: 'team'});
        // The manager (curator) confirms the mandatory manual review, then may publish
        // AFTER the developer approved.
        confirmManualReview(db, {contributionId: contribution.id, actorId: MANAGER});
        const published = publishShowcase(db, {contributionId: contribution.id, actorId: MANAGER});

        expect(published.state).toBe('published');
        expect(getConsent(db, contribution.id, DEV)?.visibilityScope).toBe('team');
        expect(eventTypes(db, contribution.id)).toContain('approved');
    });

    // --- the defining privacy property -------------------------------------

    it('joint_curation requires explicit developer approval before publish', () => {
        const {contribution} = proposeJointCuration(db, {
            developerId: DEV,
            managerId: MANAGER,
            title: 't',
            conversation: '[]',
            curatorsNote: 'note',
        });
        submitForReview(db, {contributionId: contribution.id, actorId: MANAGER});

        // No developer approval yet → the gate refuses the publish.
        let err: unknown;
        try {
            publishShowcase(db, {contributionId: contribution.id, actorId: MANAGER});
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(ContributionStateError);
        expect((err as ContributionStateError).code).toBe('gate_not_satisfied');
        // It stayed submitted, never published.
        expect(getContribution(db, contribution.id)?.state).toBe('submitted');
    });

    it('a manager CANNOT publish a joint unit without developer approval (manager-cannot-bypass)', () => {
        const {contribution} = proposeJointCuration(db, {
            developerId: DEV,
            managerId: MANAGER,
            title: 't',
            conversation: '[]',
            curatorsNote: 'note',
        });
        submitForReview(db, {contributionId: contribution.id, actorId: MANAGER});

        // The manager tries to forge approval under their own identity → rejected,
        // because they are not the pinned author.
        expect(() =>
            approveAsDeveloper(db, {contributionId: contribution.id, developerId: MANAGER, visibilityScope: 'org'}),
        ).toThrow(ShowcasePublishError);
        try {
            approveAsDeveloper(db, {contributionId: contribution.id, developerId: MANAGER, visibilityScope: 'org'});
        } catch (e) {
            expect((e as ShowcasePublishError).code).toBe('not_developer');
        }
        // No approval event was written, so the publish gate still refuses.
        expect(eventTypes(db, contribution.id)).not.toContain('approved');
        expect(() => publishShowcase(db, {contributionId: contribution.id, actorId: MANAGER})).toThrow(
            ContributionStateError,
        );
        expect(getContribution(db, contribution.id)?.state).toBe('submitted');
        // And no consent row leaked from the failed approval attempt.
        expect(getConsent(db, contribution.id, MANAGER)).toBeUndefined();
    });

    // --- visibility scope: explicit, no default -----------------------------

    it('captures the explicit visibility scope chosen in each path (team and org)', () => {
        const team = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: '[]',
            curatorsNote: 'n',
        });
        submitForReview(db, {contributionId: team.contribution.id, actorId: DEV});
        approveAsDeveloper(db, {contributionId: team.contribution.id, developerId: DEV, visibilityScope: 'team'});
        expect(getConsent(db, team.contribution.id, DEV)?.visibilityScope).toBe('team');

        const org = proposeJointCuration(db, {
            developerId: DEV,
            managerId: MANAGER,
            title: 't',
            conversation: '[]',
            curatorsNote: 'n',
        });
        submitForReview(db, {contributionId: org.contribution.id, actorId: MANAGER});
        approveAsDeveloper(db, {contributionId: org.contribution.id, developerId: DEV, visibilityScope: 'org'});
        expect(getConsent(db, org.contribution.id, DEV)?.visibilityScope).toBe('org');
    });

    it('rejects an approval with a missing or invalid visibility scope (no silent default)', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: '[]',
            curatorsNote: 'n',
        });
        submitForReview(db, {contributionId: contribution.id, actorId: DEV});
        try {
            approveAsDeveloper(db, {
                contributionId: contribution.id,
                developerId: DEV,
                // deliberately invalid scope from an untrusted caller
                visibilityScope: 'world' as never,
            });
            throw new Error('expected approveAsDeveloper to reject the invalid scope');
        } catch (e) {
            expect(e).toBeInstanceOf(ShowcasePublishError);
            expect((e as ShowcasePublishError).code).toBe('invalid_scope');
        }
        // No approval or consent leaked from the rejected call.
        expect(eventTypes(db, contribution.id)).not.toContain('approved');
        expect(getConsent(db, contribution.id, DEV)).toBeUndefined();
    });

    // --- pre-publish hook seam (mandatory scrub/review hook) -----------------

    it('runs pre-publish hooks before publishing', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: '[]',
            curatorsNote: 'n',
        });
        submitForReview(db, {contributionId: contribution.id, actorId: DEV});
        approveAsDeveloper(db, {contributionId: contribution.id, developerId: DEV, visibilityScope: 'org'});
        confirmManualReview(db, {contributionId: contribution.id, actorId: DEV});

        const calls: string[] = [];
        publishShowcase(db, {
            contributionId: contribution.id,
            actorId: DEV,
            prePublishHooks: [(ctx) => calls.push(`hook:${ctx.contribution.state}`)],
        });
        // The hook saw the contribution still 'submitted', just before the flip.
        expect(calls).toEqual(['hook:submitted']);
        expect(getContribution(db, contribution.id)?.state).toBe('published');
    });

    it('rolls the publish back when a pre-publish hook throws (no half-publish)', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: '[]',
            curatorsNote: 'n',
        });
        submitForReview(db, {contributionId: contribution.id, actorId: DEV});
        approveAsDeveloper(db, {contributionId: contribution.id, developerId: DEV, visibilityScope: 'org'});
        confirmManualReview(db, {contributionId: contribution.id, actorId: DEV});

        expect(() =>
            publishShowcase(db, {
                contributionId: contribution.id,
                actorId: DEV,
                prePublishHooks: [
                    () => {
                        throw new Error('scrub failed: unresolved secret');
                    },
                ],
            }),
        ).toThrow('scrub failed');
        // Rolled back: still submitted, no published event.
        expect(getContribution(db, contribution.id)?.state).toBe('submitted');
        expect(eventTypes(db, contribution.id)).not.toContain('published');
    });

    // --- guards & edge cases ------------------------------------------------

    it('rejects operations on a non-existent contribution with not_found', () => {
        expect(() => submitForReview(db, {contributionId: 'ghost', actorId: DEV})).toThrow(ShowcasePublishError);
        try {
            publishShowcase(db, {contributionId: 'ghost', actorId: DEV});
        } catch (e) {
            expect((e as ShowcasePublishError).code).toBe('not_found');
        }
    });

    it('rejects operating on a non-showcase contribution (best_practice) with not_showcase', () => {
        // A best practice is a contribution with no showcase unit.
        db.prepare(
            `INSERT INTO contributions
             (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
             VALUES ('bp1', 'best_practice', 't', ?, 'org', NULL, 'submitted', 1, 'now', 'now')`,
        ).run(DEV);
        try {
            approveAsDeveloper(db, {contributionId: 'bp1', developerId: DEV, visibilityScope: 'org'});
            throw new Error('expected not_showcase');
        } catch (e) {
            expect(e).toBeInstanceOf(ShowcasePublishError);
            expect((e as ShowcasePublishError).code).toBe('not_showcase');
        }
    });

    it('rejects a draft with a blank curators note (mandatory note gate)', () => {
        expect(() =>
            draftSelfPublish(db, {
                developerId: DEV,
                title: 't',
                conversation: '[]',
                curatorsNote: '   ',
            }),
        ).toThrow(/curators_note is mandatory/);
        // Nothing was created — the unit gate aborts the whole draft transaction.
        const rows = db.prepare("SELECT COUNT(*) AS c FROM contributions WHERE content_type = 'showcase_example'").get() as {
            c: number;
        };
        expect(rows.c).toBe(0);
    });

    it('cannot approve a draft that has not been submitted (out-of-state)', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: '[]',
            curatorsNote: 'n',
        });
        // Skipped submitForReview → still draft.
        expect(() =>
            approveAsDeveloper(db, {contributionId: contribution.id, developerId: DEV, visibilityScope: 'org'}),
        ).toThrow(ContributionStateError);
        // No consent leaked from the rejected approval (transaction rolled back).
        expect(getConsent(db, contribution.id, DEV)).toBeUndefined();
    });

    it('rejects a joint-curation proposal with a blank manager id', () => {
        expect(() =>
            proposeJointCuration(db, {
                developerId: DEV,
                managerId: '   ',
                title: 't',
                conversation: '[]',
                curatorsNote: 'n',
            }),
        ).toThrow(ShowcasePublishError);
    });

    it('drafts persist a showcase unit so the contribution is recognized as a showcase', () => {
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: '[{"t":1}]',
            curatorsNote: 'n',
        });
        expect(getShowcaseUnit(db, contribution.id)?.conversation).toBe('[{"t":1}]');
    });
});
