import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {createContribution} from '../../src/contributions/store';
import {ContributionStateError} from '../../src/contributions/stateMachine';
import type {NewContribution} from '../../src/contributions/types';
import {listMetricPins} from '../../src/practices/store';
import {
    MetricOverrideError,
    pinPractice,
    suppressPractice,
    type OverridePracticeInput,
} from '../../src/practices/overrides';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';

const TEAM = 'eng';

function newContribution(overrides: Partial<NewContribution> = {}): NewContribution {
    return {
        contentType: 'best_practice',
        title: 'Review AI suggestions before accepting',
        authorId: 'alice',
        scope: 'org',
        scopeTarget: null,
        state: 'published',
        body: JSON.stringify({markdown: 'Read every diff.'}),
        timestamp: T1,
        ...overrides,
    };
}

/** Create a practice (default: published, org-scoped) and return its id. */
function make(db: Database.Database, overrides: Partial<NewContribution> = {}): string {
    return createContribution(db, newContribution(overrides)).id;
}

/** A lead override input with the given action's required fields, lead-authorized by default. */
function input(contributionId: string, overrides: Partial<OverridePracticeInput> = {}): OverridePracticeInput {
    return {
        contributionId,
        metric: 'churn',
        actorId: 'lead',
        actorIsLead: true,
        ...overrides,
    };
}

describe('manual override engine — pin/suppress (Task 6.2.6 / #161)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(TEAM, T1);
        // The contribution spine FKs author_id → developers; seed the author.
        db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
            'alice',
            'Alice Dev',
            'alice@test.com',
            TEAM,
            T1,
        );
    });

    afterEach(() => {
        db.close();
    });

    // --- Happy path: a lead pins / suppresses -------------------------------

    describe('a lead can pin and suppress', () => {
        it('pinPractice records a `pin` override row a lead can read back', () => {
            const id = make(db);
            const pin = pinPractice(db, input(id, {timestamp: T1}));
            expect(pin.action).toBe('pin');
            expect(pin.contributionId).toBe(id);
            expect(pin.metric).toBe('churn');
            expect(pin.actorId).toBe('lead');
            expect(pin.createdAt).toBe(T1);

            const stored = listMetricPins(db, {contributionId: id});
            expect(stored).toHaveLength(1);
            expect(stored[0].action).toBe('pin');
        });

        it('suppressPractice records a `suppress` override row', () => {
            const id = make(db);
            const sup = suppressPractice(db, input(id));
            expect(sup.action).toBe('suppress');
            expect(listMetricPins(db, {contributionId: id, action: 'suppress'})).toHaveLength(1);
        });

        it('appends append-only rows — a later suppress does not erase the earlier pin', () => {
            const id = make(db);
            pinPractice(db, input(id, {timestamp: T1}));
            suppressPractice(db, input(id, {timestamp: T2}));
            // Both rows persist; the surfacing reduction (6.2.5) takes the latest as current.
            const rows = listMetricPins(db, {contributionId: id});
            expect(rows.map((r) => r.action)).toEqual(['suppress', 'pin']); // newest-first
        });

        it('defaults createdAt to now when no timestamp is given', () => {
            const id = make(db);
            const before = new Date().toISOString();
            const pin = pinPractice(db, input(id));
            const after = new Date().toISOString();
            expect(pin.createdAt >= before && pin.createdAt <= after).toBe(true);
        });
    });

    // --- Permission gating (the headline acceptance criterion) --------------

    describe('permission gating — only leads/curators may pin/suppress', () => {
        it('rejects a non-lead pin with not_authorized and writes nothing', () => {
            const id = make(db);
            expect(() => pinPractice(db, input(id, {actorIsLead: false}))).toThrow(MetricOverrideError);
            try {
                pinPractice(db, input(id, {actorIsLead: false}));
            } catch (err) {
                expect((err as MetricOverrideError).code).toBe('not_authorized');
            }
            expect(listMetricPins(db, {contributionId: id})).toHaveLength(0);
        });

        it('rejects a non-lead suppress with not_authorized and writes nothing', () => {
            const id = make(db);
            expect(() => suppressPractice(db, input(id, {actorIsLead: false}))).toThrow(MetricOverrideError);
            try {
                suppressPractice(db, input(id, {actorIsLead: false}));
            } catch (err) {
                expect((err as MetricOverrideError).code).toBe('not_authorized');
            }
            expect(listMetricPins(db, {contributionId: id})).toHaveLength(0);
        });

        it('authority is checked before existence — a non-lead targeting a missing practice still gets not_authorized', () => {
            // Guard order matters: a non-lead must not be able to probe which ids exist.
            try {
                pinPractice(db, input('does-not-exist', {actorIsLead: false}));
                throw new Error('expected a throw');
            } catch (err) {
                expect(err).toBeInstanceOf(MetricOverrideError);
                expect((err as MetricOverrideError).code).toBe('not_authorized');
            }
        });
    });

    // --- Input + target validation ------------------------------------------

    describe('validation', () => {
        it('rejects a blank metric with invalid_metric', () => {
            const id = make(db);
            for (const metric of ['', '   ']) {
                try {
                    pinPractice(db, input(id, {metric}));
                    throw new Error('expected a throw');
                } catch (err) {
                    expect(err).toBeInstanceOf(MetricOverrideError);
                    expect((err as MetricOverrideError).code).toBe('invalid_metric');
                }
            }
            expect(listMetricPins(db, {contributionId: id})).toHaveLength(0);
        });

        it('rejects an override on a non-existent contribution with a not_found state error', () => {
            try {
                suppressPractice(db, input('missing-id'));
                throw new Error('expected a throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ContributionStateError);
                expect((err as ContributionStateError).code).toBe('not_found');
            }
        });

        it('allows pinning a not-yet-published practice (intent recorded; surfacing enforces published)', () => {
            const draft = make(db, {state: 'draft'});
            const pin = pinPractice(db, input(draft));
            expect(pin.action).toBe('pin');
            expect(listMetricPins(db, {contributionId: draft})).toHaveLength(1);
        });
    });
});
