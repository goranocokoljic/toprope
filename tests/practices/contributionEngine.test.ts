import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {createContribution, getContribution, listReviewEvents} from '../../src/contributions/store';
import {ContributionStateError} from '../../src/contributions/stateMachine';
import type {NewContribution} from '../../src/contributions/types';
import {getPracticeDetails, recordFeedback} from '../../src/practices/store';
import {resolveCuratorCapability, setGlobalSetting, setTeamSetting} from '../../src/settings/store';
import {CONTRIBUTION_MODEL_SETTING_KEY, type ContributionModel} from '../../src/practices/contributionModel';
import {
    approvePractice,
    ContributionModelError,
    endorsePractice,
    orderPracticePool,
    publishPractice,
    submitPractice,
} from '../../src/practices/contributionEngine';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';
const T3 = '2026-06-22T00:00:00.000Z';

const TEAM = 'eng';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        TEAM,
        T1,
    );
}

function newContribution(overrides: Partial<NewContribution> = {}): NewContribution {
    return {
        contentType: 'best_practice',
        title: 'Use prepared statements',
        authorId: 'alice',
        scope: 'team',
        scopeTarget: TEAM,
        body: JSON.stringify({markdown: 'Always parameterize queries.'}),
        changeNote: 'initial draft',
        timestamp: T1,
        ...overrides,
    };
}

/** Create a fresh draft and return its id. */
function makeDraft(db: Database.Database, overrides: Partial<NewContribution> = {}): string {
    return createContribution(db, newContribution(overrides)).id;
}

/** Create a contribution already in the published state (for pool-ordering tests). */
function makePublished(db: Database.Database, overrides: Partial<NewContribution> = {}): string {
    return makeDraft(db, {state: 'published', ...overrides});
}

/** Point team `eng` at a specific model (top_down is the default, so omit for it). */
function useModel(db: Database.Database, model: ContributionModel): void {
    setTeamSetting(db, TEAM, CONTRIBUTION_MODEL_SETTING_KEY, model);
}

function eventTypes(db: Database.Database, id: string): string[] {
    return listReviewEvents(db, id).map((e) => e.event);
}

describe('contribution-model engine (Task 6.2.2 / #157)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(TEAM, T1);
        seedDeveloper(db, 'alice'); // author / non-lead
        seedDeveloper(db, 'bob'); // another non-lead developer
        seedDeveloper(db, 'lead'); // a lead/curator
    });

    afterEach(() => {
        db.close();
    });

    // --- top_down ----------------------------------------------------------

    describe('top_down model (default)', () => {
        it('submit stops at submitted behind the required-approval gate', () => {
            const id = makeDraft(db);
            const res = submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            expect(res.model).toBe('top_down');
            expect(res.gate).toBe('required-approval');
            expect(res.contribution.state).toBe('submitted');
            expect(getContribution(db, id)?.state).toBe('submitted');
        });

        it('a non-lead CANNOT publish (rejected on authority before the state machine)', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            // A lead approval exists, so the only thing stopping the non-lead is authority.
            approvePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});

            expect(() =>
                publishPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM}),
            ).toThrow(ContributionModelError);
            try {
                publishPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            } catch (err) {
                expect((err as ContributionModelError).code).toBe('not_authorized');
            }
            // Still submitted — the rejected publish changed nothing.
            expect(getContribution(db, id)?.state).toBe('submitted');
        });

        it('a non-lead cannot approve', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            try {
                approvePractice(db, {contributionId: id, actorId: 'bob', actorIsLead: false, team: TEAM});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionModelError);
                expect((err as ContributionModelError).code).toBe('not_authorized');
            }
        });

        it('a lead approves then publishes — the full top-down path', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM, timestamp: T1});
            approvePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM, timestamp: T2});
            const res = publishPractice(db, {
                contributionId: id,
                actorId: 'lead',
                actorIsLead: true,
                team: TEAM,
                timestamp: T3,
            });
            expect(res.contribution.state).toBe('published');
            expect(getContribution(db, id)?.state).toBe('published');
            expect(eventTypes(db, id)).toEqual(['submitted', 'approved', 'published']);
        });

        it('a lead still cannot publish without a recorded approval (gate cannot be skipped)', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            try {
                publishPractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionStateError);
                expect((err as ContributionStateError).code).toBe('gate_not_satisfied');
            }
        });

        it('endorsement is not applicable under top_down', () => {
            const id = makeDraft(db);
            try {
                endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionModelError);
                expect((err as ContributionModelError).code).toBe('not_applicable');
            }
        });
    });

    // --- bottom_up ---------------------------------------------------------

    describe('bottom_up model', () => {
        beforeEach(() => useModel(db, 'bottom_up'));

        it('anyone (a non-lead) publishes: submit auto-publishes', () => {
            const id = makeDraft(db);
            const res = submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            expect(res.model).toBe('bottom_up');
            expect(res.gate).toBe('auto-publish');
            expect(res.contribution.state).toBe('published');
            expect(getContribution(db, id)?.state).toBe('published');
            expect(eventTypes(db, id)).toEqual(['submitted', 'published']);
        });

        it('approval is not applicable (nothing to approve)', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            try {
                approvePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionModelError);
                expect((err as ContributionModelError).code).toBe('not_applicable');
            }
        });

        it('orders the pool by feedback', () => {
            // three published practices with differing helpful/not-helpful tallies
            const low = makeDraft(db, {title: 'low', timestamp: T1});
            const mid = makeDraft(db, {title: 'mid', timestamp: T2});
            const high = makeDraft(db, {title: 'high', timestamp: T3});
            for (const id of [low, mid, high]) {
                submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            }
            // high: +2 net, mid: +1 net, low: -1 net
            recordFeedback(db, {contributionId: high, developerId: 'alice', signal: 'helpful'});
            recordFeedback(db, {contributionId: high, developerId: 'bob', signal: 'helpful'});
            recordFeedback(db, {contributionId: mid, developerId: 'alice', signal: 'helpful'});
            recordFeedback(db, {contributionId: low, developerId: 'alice', signal: 'not_helpful'});

            const ranked = orderPracticePool(db, 'bottom_up', [low, mid, high]);
            expect(ranked.map((r) => r.contributionId)).toEqual([high, mid, low]);
            expect(ranked.map((r) => r.score)).toEqual([2, 1, -1]);
        });

        it('ranks by helpful-RATIO, not raw net score (6.2.4)', () => {
            // `broad` has the higher NET score (+4) but a worse ratio; `pure` has a
            // lower net (+3) but a perfect ratio with enough votes to be credible.
            // Helpful-ratio ranking must put `pure` first — proving the sort key is the
            // confidence-adjusted ratio, not net (helpful − notHelpful).
            const broad = makeDraft(db, {title: 'broad', timestamp: T1});
            const pure = makeDraft(db, {title: 'pure', timestamp: T2});
            for (const id of [broad, pure]) {
                submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            }
            // broad: 8 helpful / 4 not-helpful (net +4, ratio 0.667)
            // pure:  3 helpful / 0 not-helpful (net +3, ratio 1.0)
            let dev = 0;
            const vote = (id: string, signal: 'helpful' | 'not_helpful'): void => {
                const developerId = `voter-${dev++}`;
                seedDeveloper(db, developerId);
                recordFeedback(db, {contributionId: id, developerId, signal});
            };
            for (let i = 0; i < 8; i++) vote(broad, 'helpful');
            for (let i = 0; i < 4; i++) vote(broad, 'not_helpful');
            for (let i = 0; i < 3; i++) vote(pure, 'helpful');

            const ranked = orderPracticePool(db, 'bottom_up', [broad, pure]);
            expect(ranked.map((r) => r.contributionId)).toEqual([pure, broad]);
            // Net would have ordered them the OTHER way: broad's net (4) beats pure's (3).
            const broadRow = ranked.find((r) => r.contributionId === broad);
            const pureRow = ranked.find((r) => r.contributionId === pure);
            expect(broadRow?.score).toBe(4);
            expect(pureRow?.score).toBe(3);
            // The ratio-based rank score is what flips the order.
            expect(pureRow?.rankScore).toBeGreaterThan(broadRow?.rankScore ?? 0);
            expect(pureRow?.helpfulRatio).toBe(1);
            expect(broadRow?.helpfulRatio).toBeCloseTo(8 / 12, 10);
        });

        it('runs a supplied pre-publish hook on the auto-publish path', () => {
            const id = makeDraft(db);
            let ran = 0;
            let sawId = '';
            submitPractice(db, {
                contributionId: id,
                actorId: 'alice',
                actorIsLead: false,
                team: TEAM,
                prePublishHooks: [
                    (ctx) => {
                        ran += 1;
                        sawId = ctx.contribution.id;
                    },
                ],
            });
            expect(ran).toBe(1);
            expect(sawId).toBe(id);
            expect(getContribution(db, id)?.state).toBe('published');
        });

        it('a throwing pre-publish hook rolls the whole auto-publish back to draft', () => {
            const id = makeDraft(db);
            expect(() =>
                submitPractice(db, {
                    contributionId: id,
                    actorId: 'alice',
                    actorIsLead: false,
                    team: TEAM,
                    prePublishHooks: [
                        () => {
                            throw new Error('scrub failed');
                        },
                    ],
                }),
            ).toThrow('scrub failed');
            // The transaction wrapping submit+auto-publish rolled back entirely.
            expect(getContribution(db, id)?.state).toBe('draft');
            expect(eventTypes(db, id)).toEqual([]);
        });
    });

    // --- hybrid ------------------------------------------------------------

    describe('hybrid model', () => {
        beforeEach(() => useModel(db, 'hybrid'));

        it('anyone (a non-lead) publishes: submit auto-publishes', () => {
            const id = makeDraft(db);
            const res = submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            expect(res.model).toBe('hybrid');
            expect(res.gate).toBe('auto-publish');
            expect(res.contribution.state).toBe('published');
        });

        it('a lead endorsement sets the practice_details flag', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            const res = endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
            expect(res.model).toBe('hybrid');
            expect(getPracticeDetails(db, id)?.endorsed).toBe(true);
        });

        it('a non-lead cannot endorse', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            try {
                endorsePractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionModelError);
                expect((err as ContributionModelError).code).toBe('not_authorized');
            }
            expect(getPracticeDetails(db, id)?.endorsed ?? false).toBe(false);
        });

        it('an endorsement can be withdrawn (endorsed: false)', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM}); // auto-publishes
            endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
            endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM, endorsed: false});
            expect(getPracticeDetails(db, id)?.endorsed).toBe(false);
        });

        it('cannot endorse a practice that is not yet published', () => {
            const id = makeDraft(db); // still a draft — never submitted/published
            try {
                endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionModelError);
                expect((err as ContributionModelError).code).toBe('not_published');
            }
            // No details row written for the rejected endorsement.
            expect(getPracticeDetails(db, id)).toBeUndefined();
        });

        it('endorsing an unknown contribution throws the spine not_found (not a raw FK error)', () => {
            try {
                endorsePractice(db, {contributionId: 'ghost', actorId: 'lead', actorIsLead: true, team: TEAM});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionStateError);
                expect((err as ContributionStateError).code).toBe('not_found');
            }
        });

        it('endorsement ELEVATES a practice above un-endorsed ones, with feedback ordering within each group', () => {
            // un-endorsed but well-liked vs endorsed with weaker feedback: endorsed wins.
            const endorsedWeak = makeDraft(db, {title: 'endorsed-weak', timestamp: T1});
            const popularPlain = makeDraft(db, {title: 'popular-plain', timestamp: T2});
            const plain = makeDraft(db, {title: 'plain', timestamp: T3});
            for (const id of [endorsedWeak, popularPlain, plain]) {
                submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            }
            endorsePractice(db, {contributionId: endorsedWeak, actorId: 'lead', actorIsLead: true, team: TEAM});
            // popularPlain gets +2, endorsedWeak gets +0, plain gets +0
            recordFeedback(db, {contributionId: popularPlain, developerId: 'alice', signal: 'helpful'});
            recordFeedback(db, {contributionId: popularPlain, developerId: 'bob', signal: 'helpful'});

            const ranked = orderPracticePool(db, 'hybrid', [endorsedWeak, popularPlain, plain]);
            // endorsed first (despite weaker feedback), then the rest by feedback.
            expect(ranked.map((r) => r.contributionId)).toEqual([endorsedWeak, popularPlain, plain]);
            expect(ranked[0].endorsed).toBe(true);
        });

        it('orders by feedback WITHIN the endorsed group (two endorsed practices)', () => {
            const endorsedStrong = makeDraft(db, {title: 'endorsed-strong', timestamp: T1});
            const endorsedWeak = makeDraft(db, {title: 'endorsed-weak', timestamp: T2});
            for (const id of [endorsedStrong, endorsedWeak]) {
                submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
                endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
            }
            // both endorsed; endorsedStrong has the better feedback so it sorts first.
            recordFeedback(db, {contributionId: endorsedStrong, developerId: 'alice', signal: 'helpful'});
            recordFeedback(db, {contributionId: endorsedStrong, developerId: 'bob', signal: 'helpful'});

            const ranked = orderPracticePool(db, 'hybrid', [endorsedWeak, endorsedStrong]);
            expect(ranked.map((r) => r.contributionId)).toEqual([endorsedStrong, endorsedWeak]);
            expect(ranked.every((r) => r.endorsed)).toBe(true);
        });

        it('within the endorsed group, ranks by helpful-RATIO not raw net score (6.2.4)', () => {
            // Both endorsed, so endorsement can't separate them — the feedback order
            // within the group must use the ratio. `broad` has the higher net (+4) but a
            // worse ratio; `pure` has a lower net (+3) but a perfect ratio. Net would put
            // broad first; ratio must put `pure` first.
            const broad = makeDraft(db, {title: 'endorsed-broad', timestamp: T1});
            const pure = makeDraft(db, {title: 'endorsed-pure', timestamp: T2});
            for (const id of [broad, pure]) {
                submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
                endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
            }
            let dev = 0;
            const vote = (id: string, signal: 'helpful' | 'not_helpful'): void => {
                const developerId = `hv-${dev++}`;
                seedDeveloper(db, developerId);
                recordFeedback(db, {contributionId: id, developerId, signal});
            };
            for (let i = 0; i < 8; i++) vote(broad, 'helpful');
            for (let i = 0; i < 4; i++) vote(broad, 'not_helpful'); // 8/4, net +4, ratio 0.667
            for (let i = 0; i < 3; i++) vote(pure, 'helpful'); // 3/0, net +3, ratio 1.0

            const ranked = orderPracticePool(db, 'hybrid', [broad, pure]);
            expect(ranked.map((r) => r.contributionId)).toEqual([pure, broad]);
            expect(ranked.find((r) => r.contributionId === broad)?.score).toBe(4); // net would order the other way
            expect(ranked.find((r) => r.contributionId === pure)?.score).toBe(3);
        });
    });

    // --- switching the model at runtime ------------------------------------

    describe('the switch changes the active publish path with no migration', () => {
        it('the same submit goes to submitted under top_down but published under bottom_up', () => {
            // top_down (default): stops at submitted
            const a = makeDraft(db, {title: 'a'});
            expect(
                submitPractice(db, {contributionId: a, actorId: 'alice', actorIsLead: false, team: TEAM}).contribution
                    .state,
            ).toBe('submitted');

            // flip the team to bottom_up — a settings write, no schema change
            useModel(db, 'bottom_up');

            const b = makeDraft(db, {title: 'b'});
            expect(
                submitPractice(db, {contributionId: b, actorId: 'alice', actorIsLead: false, team: TEAM}).contribution
                    .state,
            ).toBe('published');
        });

        it('non-lead publish is blocked under top_down but allowed after switching to bottom_up', () => {
            // Build a top_down submission with an approval present.
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            approvePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM});
            expect(() =>
                publishPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM}),
            ).toThrow(ContributionModelError);

            // Switch to bottom_up: a non-lead may now publish the same submission.
            useModel(db, 'bottom_up');
            const res = publishPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM});
            expect(res.contribution.state).toBe('published');
        });
    });

    // --- orderPracticePool edge cases --------------------------------------

    describe('orderPracticePool', () => {
        it('drops unknown ids rather than returning holes', () => {
            const real = makePublished(db);
            const ranked = orderPracticePool(db, 'bottom_up', ['ghost', real, 'phantom']);
            expect(ranked.map((r) => r.contributionId)).toEqual([real]);
        });

        it('drops practices that are not published (only the live pool is surfaced)', () => {
            const published = makePublished(db, {title: 'live', timestamp: T2});
            const draft = makeDraft(db, {title: 'draft', timestamp: T1});
            const removed = makePublished(db, {title: 'removed', timestamp: T3});
            // soft-remove the published one via a direct state write (governance remove)
            db.prepare("UPDATE contributions SET state = 'removed' WHERE id = ?").run(removed);
            const ranked = orderPracticePool(db, 'bottom_up', [published, draft, removed]);
            expect(ranked.map((r) => r.contributionId)).toEqual([published]);
        });

        it('top_down orders most-recent-first (curated default)', () => {
            const oldId = makePublished(db, {title: 'old', timestamp: T1});
            const newId = makePublished(db, {title: 'new', timestamp: T3});
            const ranked = orderPracticePool(db, 'top_down', [oldId, newId]);
            expect(ranked.map((r) => r.contributionId)).toEqual([newId, oldId]);
        });

        it('returns an empty list for no ids', () => {
            expect(orderPracticePool(db, 'hybrid', [])).toEqual([]);
        });

        it('breaks ties on equal score by total feedback, then recency', () => {
            const oldQuiet = makePublished(db, {title: 'old-quiet', timestamp: T1}); // 0/0, score 0
            const newQuiet = makePublished(db, {title: 'new-quiet', timestamp: T3}); // 0/0, score 0
            const mixed = makePublished(db, {title: 'mixed', timestamp: T2}); // 1/1, score 0 but total 2
            recordFeedback(db, {contributionId: mixed, developerId: 'alice', signal: 'helpful'});
            recordFeedback(db, {contributionId: mixed, developerId: 'bob', signal: 'not_helpful'});

            const ranked = orderPracticePool(db, 'bottom_up', [oldQuiet, newQuiet, mixed]);
            // all score 0: most total feedback first, then newer-first among the quiet two.
            expect(ranked.map((r) => r.contributionId)).toEqual([mixed, newQuiet, oldQuiet]);
        });

        it('breaks an equal-rankScore tie (two all-not-helpful practices) by total feedback', () => {
            // Wilson lower bound is 0 for any all-negative tally, so 0/2 and 0/4 tie on
            // rankScore — the secondary tier (more total feedback first) must separate them.
            const fewer = makePublished(db, {title: 'fewer', timestamp: T2}); // 0/2
            const more = makePublished(db, {title: 'more', timestamp: T2}); // 0/4
            const vote = (id: string, n: number): void => {
                for (let i = 0; i < n; i++) {
                    const developerId = `nh-${id}-${i}`;
                    seedDeveloper(db, developerId);
                    recordFeedback(db, {contributionId: id, developerId, signal: 'not_helpful'});
                }
            };
            vote(fewer, 2);
            vote(more, 4);
            const ranked = orderPracticePool(db, 'bottom_up', [fewer, more]);
            expect(ranked.map((r) => r.rankScore)).toEqual([0, 0]); // equal primary key
            expect(ranked.map((r) => r.contributionId)).toEqual([more, fewer]); // more total first
        });

        it('ranks a no-feedback practice below one with positive feedback', () => {
            const quiet = makePublished(db, {title: 'quiet', timestamp: T3}); // 0/0 → rankScore 0
            const liked = makePublished(db, {title: 'liked', timestamp: T1}); // 1/0 → rankScore > 0
            recordFeedback(db, {contributionId: liked, developerId: 'alice', signal: 'helpful'});
            const ranked = orderPracticePool(db, 'bottom_up', [quiet, liked]);
            expect(ranked.map((r) => r.contributionId)).toEqual([liked, quiet]);
        });

        it('falls back to id as a stable final tiebreak when score, total, and recency are equal', () => {
            const a = makePublished(db, {title: 'a', authorId: 'alice', timestamp: T1});
            const b = makePublished(db, {title: 'b', authorId: 'alice', timestamp: T1});
            const ranked = orderPracticePool(db, 'bottom_up', [a, b]);
            const sortedIds = [a, b].sort();
            expect(ranked.map((r) => r.contributionId)).toEqual(sortedIds);
        });
    });

    // --- Task 6.4 / #173: the bestpractices_enabled master switch gates every -----
    // lifecycle action, and the curator_permission capability drives the lead gate.
    describe('bestpractices_enabled master switch (Task 6.4)', () => {
        it('blocks submit/approve/publish/endorse when disabled for the team', () => {
            setGlobalSetting(db, 'bestpractices_enabled', false);
            const id = makeDraft(db);

            for (const act of [
                () => submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM}),
                () => approvePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM}),
                () => publishPractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM}),
                () => endorsePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM}),
            ]) {
                try {
                    act();
                    throw new Error('expected throw');
                } catch (err) {
                    expect(err).toBeInstanceOf(ContributionModelError);
                    expect((err as ContributionModelError).code).toBe('not_enabled');
                }
            }
            // The draft never advanced — a disabled feature mutated no state.
            expect(getContribution(db, id)?.state).toBe('draft');
        });

        it('is gated PER TEAM: a governed override re-enables just one team', () => {
            setGlobalSetting(db, 'bestpractices_enabled', false);
            setGlobalSetting(db, 'coaching_managers_can_override', true);
            setTeamSetting(db, TEAM, 'bestpractices_enabled', true);

            // The enabled team submits fine…
            const ok = makeDraft(db);
            expect(submitPractice(db, {contributionId: ok, actorId: 'alice', actorIsLead: false, team: TEAM}).contribution.state).toBe(
                'submitted',
            );
            // …while a team still off is refused.
            const blocked = makeDraft(db);
            expect(() =>
                submitPractice(db, {contributionId: blocked, actorId: 'alice', actorIsLead: false, team: 'other-team'}),
            ).toThrow(ContributionModelError);
        });

        it('does NOT gate the read/order path (viewing a pool never errors when off)', () => {
            const pub = makePublished(db, {title: 'p', timestamp: T1});
            setGlobalSetting(db, 'bestpractices_enabled', false);
            // orderPracticePool is a pure read — a toggled-off team still sees its pool.
            expect(orderPracticePool(db, 'bottom_up', [pub]).map((r) => r.contributionId)).toEqual([pub]);
        });
    });

    describe('curator_permission drives the lead/curator capability (Task 6.4)', () => {
        // The engine takes actorIsLead server-derived; resolveCuratorCapability is the
        // canonical derivation from the session role + the team's curator_permission.
        // This proves the setting VALUE actually changes who may publish under top_down.
        it('a developer cannot publish under managers_admins, but can once set to any_member', () => {
            const id = makeDraft(db);
            submitPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: false, team: TEAM, timestamp: T1});

            // Default managers_admins: a developer is not a curator → publish refused.
            const devIsLeadDefault = resolveCuratorCapability(db, 'developer', TEAM);
            expect(devIsLeadDefault).toBe(false);
            // Need an approval on record first so the ONLY thing blocking is authority.
            approvePractice(db, {contributionId: id, actorId: 'lead', actorIsLead: true, team: TEAM, timestamp: T2});
            expect(() =>
                publishPractice(db, {contributionId: id, actorId: 'alice', actorIsLead: devIsLeadDefault, team: TEAM}),
            ).toThrow(ContributionModelError);

            // Widen the policy: now a developer IS a curator and the same publish lands.
            setGlobalSetting(db, 'curator_permission', 'any_member');
            const devIsLeadWide = resolveCuratorCapability(db, 'developer', TEAM);
            expect(devIsLeadWide).toBe(true);
            const res = publishPractice(db, {
                contributionId: id,
                actorId: 'alice',
                actorIsLead: devIsLeadWide,
                team: TEAM,
                timestamp: T3,
            });
            expect(res.contribution.state).toBe('published');
        });
    });
});
