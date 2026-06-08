import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../src/registry/developers';
import {handleInteraction, type SlackHandlerDeps} from '../../src/slack/handlers';
import {FakeSlackClient} from '../slack/fake-client';
import {createSurvey, getSurveyById, getLatestResponse, markSurveySent} from '../../src/surveys/store';
import {buildSurveyQuestion} from '../../src/surveys/templates';
import {ACTION_SURVEY_ANSWER_PREFIX, ACTION_SURVEY_DECLINE} from '../../src/surveys/delivery';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    addTeam(db, 'eng');
    return db;
}

const Q = buildSurveyQuestion('usage_drop', {tool: 'copilot', drop_pct: -45});

function blockAction(actionId: string, surveyId: string, slackUserId: string): unknown {
    return {
        type: 'block_actions',
        user: {id: slackUserId},
        response_url: 'https://hooks.slack.test/resp',
        actions: [{action_id: actionId, value: surveyId}],
    };
}

function sentSurveyFor(db: Database.Database, devId: string): string {
    const survey = createSurvey(db, {developerId: devId, triggerType: 'usage_drop', question: Q});
    markSurveySent(db, survey.id, 'slack');
    return survey.id;
}

describe('Slack survey interaction', () => {
    let db: Database.Database;
    let client: FakeSlackClient;
    let deps: SlackHandlerDeps;
    beforeEach(() => {
        db = makeDb();
        client = new FakeSlackClient();
        deps = {db, client, log: () => {}};
    });
    afterEach(() => db.close());

    it('records an answer choice from a button click and confirms', async () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        const surveyId = sentSurveyFor(db, dev);
        const choice = Q.choices[0].value;

        const result = await handleInteraction(
            blockAction(`${ACTION_SURVEY_ANSWER_PREFIX}${choice}`, surveyId, 'U_ALICE'),
            deps,
        );
        expect(result.status).toBe(200);
        expect(getSurveyById(db, surveyId)?.status).toBe('answered');
        expect(getLatestResponse(db, surveyId)?.response_choice).toBe(choice);
        // The original message is replaced to retire the buttons.
        expect(client.replaceMessageCalls).toHaveLength(1);
    });

    it('records a decline', async () => {
        const dev = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_BOB'});
        const surveyId = sentSurveyFor(db, dev);

        await handleInteraction(blockAction(ACTION_SURVEY_DECLINE, surveyId, 'U_BOB'), deps);
        expect(getSurveyById(db, surveyId)?.status).toBe('declined');
    });

    it('ignores a click from a developer who does not own the survey', async () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        addDeveloper(db, 'Mallory', 'eng', 'mallory@example.com');
        linkDeveloper(db, alice, {slack: 'U_ALICE'});
        // Mallory is linked to a different slack id and clicks Alice's survey.
        const mallory = addDeveloper(db, 'M2', 'eng', 'm2@example.com').id;
        linkDeveloper(db, mallory, {slack: 'U_MALLORY'});
        const surveyId = sentSurveyFor(db, alice);

        await handleInteraction(
            blockAction(`${ACTION_SURVEY_ANSWER_PREFIX}${Q.choices[0].value}`, surveyId, 'U_MALLORY'),
            deps,
        );
        // Untouched — still sent, no response.
        expect(getSurveyById(db, surveyId)?.status).toBe('sent');
        expect(getLatestResponse(db, surveyId)).toBeNull();
        expect(client.replaceMessageCalls).toHaveLength(0);
    });

    it('ignores a click from an unlinked Slack user', async () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        const surveyId = sentSurveyFor(db, dev);
        await handleInteraction(
            blockAction(`${ACTION_SURVEY_ANSWER_PREFIX}${Q.choices[0].value}`, surveyId, 'U_UNKNOWN'),
            deps,
        );
        expect(getSurveyById(db, surveyId)?.status).toBe('sent');
    });
});
