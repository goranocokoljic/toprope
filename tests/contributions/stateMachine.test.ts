import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {createContribution, getContribution, listReviewEvents, updateContributionState} from '../../src/contributions/store';
import {
    approve,
    ContributionStateError,
    isLegalTransition,
    LEGAL_TRANSITIONS,
    publish,
    remove,
    submit,
    unpublish,
    type PrePublishHook,
} from '../../src/contributions/stateMachine';
import type {ContributionState, NewContribution} from '../../src/contributions/types';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';
const T3 = '2026-06-22T00:00:00.000Z';
const T4 = '2026-06-23T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        T1,
    );
}

function newContribution(overrides: Partial<NewContribution> = {}): NewContribution {
    return {
        contentType: 'best_practice',
        title: 'Use prepared statements',
        authorId: 'alice',
        scope: 'team',
        scopeTarget: 'eng',
        body: JSON.stringify({markdown: 'Always parameterize queries.'}),
        changeNote: 'initial draft',
        timestamp: T1,
        ...overrides,
    };
}

/** Create a fresh draft contribution and return its id. */
function makeDraft(db: Database.Database, overrides: Partial<NewContribution> = {}): string {
    return createContribution(db, newContribution(overrides)).id;
}

/** The chronological list of audit event types for a contribution. */
function eventTypes(db: Database.Database, id: string): string[] {
    return listReviewEvents(db, id).map((e) => e.event);
}

describe('contribution state machine (Task 6.1.2)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', T1);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'lead', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    describe('LEGAL_TRANSITIONS / isLegalTransition', () => {
        it('encodes exactly the documented lifecycle graph', () => {
            expect(LEGAL_TRANSITIONS.draft).toEqual(['submitted']);
            expect(LEGAL_TRANSITIONS.submitted).toEqual(['published']);
            expect(LEGAL_TRANSITIONS.published).toEqual(['unpublished', 'removed']);
            expect(LEGAL_TRANSITIONS.unpublished).toEqual(['removed']);
            expect(LEGAL_TRANSITIONS.removed).toEqual([]);
        });

        it('accepts legal moves and rejects everything else', () => {
            expect(isLegalTransition('draft', 'submitted')).toBe(true);
            expect(isLegalTransition('submitted', 'published')).toBe(true);
            expect(isLegalTransition('published', 'removed')).toBe(true);
            // Illegal: skipping submitted, regressing, leaving a terminal state.
            expect(isLegalTransition('draft', 'published')).toBe(false);
            expect(isLegalTransition('submitted', 'draft')).toBe(false);
            expect(isLegalTransition('unpublished', 'published')).toBe(false);
            expect(isLegalTransition('removed', 'draft')).toBe(false);
        });
    });

    describe('submit', () => {
        it('moves draft → submitted and records a submitted event with actor + timestamp', () => {
            const id = makeDraft(db);
            const result = submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T2, note: 'please review'});

            expect(result.state).toBe('submitted');
            expect(getContribution(db, id)?.state).toBe('submitted');
            const events = listReviewEvents(db, id);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({event: 'submitted', actorId: 'alice', occurredAt: T2, note: 'please review'});
        });

        it('with an auto-publish gate carries straight through to published in one call', () => {
            const id = makeDraft(db);
            const result = submit(db, {contributionId: id, gate: 'auto-publish', actorId: 'alice', timestamp: T2});

            expect(result.state).toBe('published');
            expect(getContribution(db, id)?.state).toBe('published');
            // Both transitions are audited: submitted then published. No approval needed.
            expect(eventTypes(db, id)).toEqual(['submitted', 'published']);
        });

        it('runs pre-publish hooks when auto-publishing', () => {
            const id = makeDraft(db);
            const seen: string[] = [];
            const hook: PrePublishHook = (ctx) => {
                seen.push(`${ctx.contribution.id}:${ctx.contribution.state}:${ctx.actorId}:${ctx.timestamp}`);
            };
            submit(db, {contributionId: id, gate: 'auto-publish', actorId: 'alice', timestamp: T2, prePublishHooks: [hook]});
            expect(seen).toEqual([`${id}:submitted:alice:${T2}`]);
        });

        it('rejects submitting a non-draft as an illegal transition', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T2});
            expect(() => submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T3})).toThrow(
                ContributionStateError,
            );
            try {
                submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T3});
            } catch (e) {
                expect((e as ContributionStateError).code).toBe('illegal_transition');
            }
        });

        it('throws not_found for a missing contribution', () => {
            try {
                submit(db, {contributionId: 'nope', gate: 'auto-publish', actorId: 'alice'});
                throw new Error('expected throw');
            } catch (e) {
                expect(e).toBeInstanceOf(ContributionStateError);
                expect((e as ContributionStateError).code).toBe('not_found');
            }
        });
    });

    describe('required-approval gate', () => {
        it('cannot be bypassed: publishing a submitted contribution without approval is refused', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T2});

            let err: ContributionStateError | undefined;
            try {
                publish(db, {contributionId: id, gate: 'required-approval', actorId: 'lead', timestamp: T3});
            } catch (e) {
                err = e as ContributionStateError;
            }
            expect(err).toBeInstanceOf(ContributionStateError);
            expect(err?.code).toBe('gate_not_satisfied');
            // State unchanged and nothing published-related recorded.
            expect(getContribution(db, id)?.state).toBe('submitted');
            expect(eventTypes(db, id)).toEqual(['submitted']);
        });

        it('reaches published after an approval is recorded', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T2});
            approve(db, {contributionId: id, actorId: 'lead', timestamp: T3, note: 'looks good'});
            const result = publish(db, {contributionId: id, gate: 'required-approval', actorId: 'lead', timestamp: T4});

            expect(result.state).toBe('published');
            expect(getContribution(db, id)?.state).toBe('published');
            expect(eventTypes(db, id)).toEqual(['submitted', 'approved', 'published']);
        });

        it('approve throws not_found for a missing contribution', () => {
            try {
                approve(db, {contributionId: 'nope', actorId: 'lead', timestamp: T2});
                throw new Error('expected throw');
            } catch (e) {
                expect(e).toBeInstanceOf(ContributionStateError);
                expect((e as ContributionStateError).code).toBe('not_found');
            }
        });

        it('approve refuses any state other than submitted', () => {
            const id = makeDraft(db);
            // draft → cannot approve
            try {
                approve(db, {contributionId: id, actorId: 'lead', timestamp: T2});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ContributionStateError).code).toBe('illegal_transition');
            }
            expect(eventTypes(db, id)).toEqual([]);
        });
    });

    describe('publish (pre-publish hooks)', () => {
        it('fires hooks in order before the publish, with the pre-publish contribution', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T2});
            approve(db, {contributionId: id, actorId: 'lead', timestamp: T3});

            const order: string[] = [];
            const states: ContributionState[] = [];
            const hookA: PrePublishHook = (ctx) => {
                order.push('a');
                states.push(ctx.contribution.state);
            };
            const hookB: PrePublishHook = () => {
                order.push('b');
            };
            publish(db, {contributionId: id, gate: 'required-approval', actorId: 'lead', timestamp: T4, prePublishHooks: [hookA, hookB]});

            expect(order).toEqual(['a', 'b']);
            // The hook sees the contribution as it stands before the flip to published.
            expect(states).toEqual(['submitted']);
            expect(getContribution(db, id)?.state).toBe('published');
        });

        it('a throwing pre-publish hook aborts the publish and rolls back (atomic)', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'auto-publish', actorId: 'alice', timestamp: T2});
            // Reset to a submitted draft via a fresh contribution for a clean publish attempt.
            const id2 = makeDraft(db, {title: 'Second'});
            submit(db, {contributionId: id2, gate: 'required-approval', actorId: 'alice', timestamp: T2});
            approve(db, {contributionId: id2, actorId: 'lead', timestamp: T3});

            const failing: PrePublishHook = () => {
                throw new Error('scrub failed');
            };
            expect(() =>
                publish(db, {contributionId: id2, gate: 'required-approval', actorId: 'lead', timestamp: T4, prePublishHooks: [failing]}),
            ).toThrow('scrub failed');

            // Nothing changed: still submitted, no published event written.
            expect(getContribution(db, id2)?.state).toBe('submitted');
            expect(eventTypes(db, id2)).toEqual(['submitted', 'approved']);
        });

        it('auto-publish gate publishes without an approval even via publish()', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T2});
            // Feature later resolves the model to auto-publish; publish must not demand approval.
            const result = publish(db, {contributionId: id, gate: 'auto-publish', actorId: 'lead', timestamp: T3});
            expect(result.state).toBe('published');
            expect(eventTypes(db, id)).toEqual(['submitted', 'published']);
        });

        it('rejects publishing from a non-submitted state', () => {
            const id = makeDraft(db);
            // draft → published is illegal (must be submitted first).
            try {
                publish(db, {contributionId: id, gate: 'auto-publish', actorId: 'lead', timestamp: T2});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ContributionStateError).code).toBe('illegal_transition');
            }
        });
    });

    describe('unpublish', () => {
        it('moves published → unpublished and audits it', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'auto-publish', actorId: 'alice', timestamp: T2});
            const result = unpublish(db, {contributionId: id, actorId: 'lead', timestamp: T3, note: 'stale'});

            expect(result.state).toBe('unpublished');
            expect(getContribution(db, id)?.state).toBe('unpublished');
            expect(eventTypes(db, id)).toEqual(['submitted', 'published', 'unpublished']);
            expect(listReviewEvents(db, id).at(-1)).toMatchObject({event: 'unpublished', actorId: 'lead', occurredAt: T3, note: 'stale'});
        });

        it('rejects unpublishing something not published', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T2});
            try {
                unpublish(db, {contributionId: id, actorId: 'lead', timestamp: T3});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ContributionStateError).code).toBe('illegal_transition');
            }
        });
    });

    describe('remove', () => {
        it('removes a published contribution and audits it', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'auto-publish', actorId: 'alice', timestamp: T2});
            const result = remove(db, {contributionId: id, actorId: 'lead', timestamp: T3, note: 'policy'});

            expect(result.state).toBe('removed');
            expect(eventTypes(db, id)).toEqual(['submitted', 'published', 'removed']);
        });

        it('removes an unpublished contribution', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'auto-publish', actorId: 'alice', timestamp: T2});
            unpublish(db, {contributionId: id, actorId: 'lead', timestamp: T3});
            const result = remove(db, {contributionId: id, actorId: 'lead', timestamp: T4});
            expect(result.state).toBe('removed');
            expect(eventTypes(db, id)).toEqual(['submitted', 'published', 'unpublished', 'removed']);
        });

        it('cannot remove a draft (illegal) and removed is terminal', () => {
            const id = makeDraft(db);
            try {
                remove(db, {contributionId: id, actorId: 'lead', timestamp: T2});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ContributionStateError).code).toBe('illegal_transition');
            }
            // Drive to removed, then confirm nothing escapes the terminal state.
            submit(db, {contributionId: id, gate: 'auto-publish', actorId: 'alice', timestamp: T2});
            remove(db, {contributionId: id, actorId: 'lead', timestamp: T3});
            try {
                unpublish(db, {contributionId: id, actorId: 'lead', timestamp: T4});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ContributionStateError).code).toBe('illegal_transition');
            }
        });
    });

    describe('full lifecycle audit trail', () => {
        it('records every transition with actor + timestamp end to end', () => {
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T1});
            approve(db, {contributionId: id, actorId: 'lead', timestamp: T2});
            publish(db, {contributionId: id, gate: 'required-approval', actorId: 'lead', timestamp: T3});
            unpublish(db, {contributionId: id, actorId: 'lead', timestamp: T4});

            const events = listReviewEvents(db, id);
            expect(events.map((e) => e.event)).toEqual(['submitted', 'approved', 'published', 'unpublished']);
            // Every event names an actor and a timestamp — no anonymous transition.
            for (const e of events) {
                expect(e.actorId).toBeTruthy();
                expect(e.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            }
        });
    });

    describe('approval scoping (defensive)', () => {
        it('ignores an approval recorded before the current submission', () => {
            // Construct a trail where an approval predates the submission by writing the
            // contribution into the submitted state directly, then recording a late
            // approval — the supported path always approves after submit, but the guard
            // must hold even if events arrive oddly.
            const id = makeDraft(db);
            submit(db, {contributionId: id, gate: 'required-approval', actorId: 'alice', timestamp: T3});
            // approval timestamp BEFORE the submission timestamp -> does not satisfy the gate
            approve(db, {contributionId: id, actorId: 'lead', timestamp: T1});
            // Re-read to confirm still submitted, then publishing must be refused.
            expect(getContribution(db, id)?.state).toBe('submitted');
            try {
                publish(db, {contributionId: id, gate: 'required-approval', actorId: 'lead', timestamp: T4});
                throw new Error('expected throw');
            } catch (e) {
                expect((e as ContributionStateError).code).toBe('gate_not_satisfied');
            }
        });
    });

    // Referenced to keep the import meaningful if the direct-write helper is needed.
    it('store updateContributionState remains the mechanical primitive (no legality)', () => {
        const id = makeDraft(db);
        // The store itself does not police legality; the state machine does. This asserts
        // the layering: a raw store write can set any valid state, bypassing the graph.
        const updated = updateContributionState(db, id, 'published', T2);
        expect(updated?.state).toBe('published');
    });
});
