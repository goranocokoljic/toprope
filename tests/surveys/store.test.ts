import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {
    createSurvey,
    declineSurvey,
    dismissSurvey,
    getLatestResponse,
    getSurveyById,
    hasRecentOpenSurvey,
    listSurveys,
    listSurveysForDeveloper,
    markSurveySent,
    respondToSurvey,
} from '../../src/surveys/store';
import {buildSurveyQuestion} from '../../src/surveys/templates';
import type {SurveyQuestion} from '../../src/surveys/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedDev(db: Database.Database, name = 'Alice'): string {
    addTeam(db, 'eng');
    return addDeveloper(db, name, 'eng', `${name.toLowerCase()}@example.com`).id;
}

const Q: SurveyQuestion = buildSurveyQuestion('usage_drop', {tool: 'copilot', drop_pct: -45});

describe('survey store', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
    });
    afterEach(() => {
        db.close();
    });

    it('creates a queued survey with persisted choices and context', () => {
        const dev = seedDev(db);
        const survey = createSurvey(db, {
            developerId: dev,
            triggerType: 'usage_drop',
            triggerContext: {drop_pct: -45, tool: 'copilot'},
            question: Q,
        });
        expect(survey.status).toBe('queued');
        const fetched = getSurveyById(db, survey.id);
        expect(fetched?.choices.length).toBe(Q.choices.length);
        expect(fetched?.trigger_context).toMatchObject({tool: 'copilot'});
    });

    it('markSurveySent transitions queued → sent once, and is idempotent', () => {
        const dev = seedDev(db);
        const survey = createSurvey(db, {developerId: dev, triggerType: 'manual', question: Q});
        expect(markSurveySent(db, survey.id, 'slack')).toBe(true);
        // Second send is a no-op (already sent).
        expect(markSurveySent(db, survey.id, 'email')).toBe(false);
        const after = getSurveyById(db, survey.id);
        expect(after?.status).toBe('sent');
        expect(after?.delivery).toBe('slack');
        expect(after?.sent_at).toBeTruthy();
    });

    it('records a response (choice) and flips status to answered', () => {
        const dev = seedDev(db);
        const survey = createSurvey(db, {developerId: dev, triggerType: 'usage_drop', question: Q});
        markSurveySent(db, survey.id, 'slack');
        const outcome = respondToSurvey(db, survey.id, dev, {responseChoice: Q.choices[0].value});
        expect(outcome).toBe('ok');
        expect(getSurveyById(db, survey.id)?.status).toBe('answered');
        const resp = getLatestResponse(db, survey.id);
        expect(resp?.response_choice).toBe(Q.choices[0].value);
    });

    it('ignores an unknown choice value but accepts free text', () => {
        const dev = seedDev(db);
        const survey = createSurvey(db, {developerId: dev, triggerType: 'usage_drop', question: Q});
        markSurveySent(db, survey.id, 'slack');
        const outcome = respondToSurvey(db, survey.id, dev, {
            responseChoice: 'not_a_real_option',
            responseText: 'switched to Cursor',
        });
        expect(outcome).toBe('ok');
        const resp = getLatestResponse(db, survey.id);
        expect(resp?.response_choice).toBeNull();
        expect(resp?.response_text).toBe('switched to Cursor');
    });

    it('rejects an empty response (no choice, no text)', () => {
        const dev = seedDev(db);
        const survey = createSurvey(db, {developerId: dev, triggerType: 'usage_drop', question: Q});
        markSurveySent(db, survey.id, 'slack');
        expect(respondToSurvey(db, survey.id, dev, {})).toBe('invalid_status');
        expect(getSurveyById(db, survey.id)?.status).toBe('sent');
    });

    it('a developer cannot answer another developer’s survey', () => {
        const alice = seedDev(db, 'Alice');
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;
        const survey = createSurvey(db, {developerId: alice, triggerType: 'usage_drop', question: Q});
        markSurveySent(db, survey.id, 'slack');
        // Bob tries to answer Alice's survey.
        expect(respondToSurvey(db, survey.id, bob, {responseChoice: Q.choices[0].value})).toBe(
            'forbidden',
        );
        // Untouched.
        expect(getSurveyById(db, survey.id)?.status).toBe('sent');
    });

    it('decline records status=declined, scoped to the owner', () => {
        const alice = seedDev(db, 'Alice');
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;
        const survey = createSurvey(db, {developerId: alice, triggerType: 'usage_drop', question: Q});
        markSurveySent(db, survey.id, 'slack');
        expect(declineSurvey(db, survey.id, bob)).toBe('forbidden');
        expect(declineSurvey(db, survey.id, alice)).toBe('ok');
        expect(getSurveyById(db, survey.id)?.status).toBe('declined');
    });

    it('cannot respond to a survey that was never sent', () => {
        const dev = seedDev(db);
        const survey = createSurvey(db, {developerId: dev, triggerType: 'usage_drop', question: Q});
        expect(respondToSurvey(db, survey.id, dev, {responseChoice: Q.choices[0].value})).toBe(
            'invalid_status',
        );
    });

    it('dismiss only affects queued surveys', () => {
        const dev = seedDev(db);
        const survey = createSurvey(db, {developerId: dev, triggerType: 'manual', question: Q});
        expect(dismissSurvey(db, survey.id)).toBe(true);
        expect(getSurveyById(db, survey.id)?.status).toBe('dismissed');
        // Re-dismiss is a no-op.
        expect(dismissSurvey(db, survey.id)).toBe(false);
    });

    it('listSurveysForDeveloper excludes queued (undelivered) surveys', () => {
        const dev = seedDev(db);
        const queued = createSurvey(db, {developerId: dev, triggerType: 'manual', question: Q});
        const sent = createSurvey(db, {developerId: dev, triggerType: 'usage_drop', question: Q});
        markSurveySent(db, sent.id, 'slack');
        const mine = listSurveysForDeveloper(db, dev);
        expect(mine.map((s) => s.id)).toContain(sent.id);
        expect(mine.map((s) => s.id)).not.toContain(queued.id);
    });

    it('listSurveys enriches with developer identity and filters by status', () => {
        const dev = seedDev(db, 'Alice');
        createSurvey(db, {developerId: dev, triggerType: 'manual', question: Q});
        const rows = listSurveys(db, {status: 'queued'});
        expect(rows).toHaveLength(1);
        expect(rows[0].developer_name).toBe('Alice');
        expect(rows[0].team).toBe('eng');
    });

    it('hasRecentOpenSurvey detects an existing open survey within the window', () => {
        const dev = seedDev(db);
        createSurvey(db, {developerId: dev, triggerType: 'usage_drop', question: Q});
        const since = new Date(Date.now() - 60_000).toISOString();
        expect(hasRecentOpenSurvey(db, dev, 'usage_drop', since)).toBe(true);
        expect(hasRecentOpenSurvey(db, dev, 'plan_change', since)).toBe(false);
    });
});
