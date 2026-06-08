import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../src/registry/developers';
import {setGlobalSetting, setTeamSetting} from '../../src/settings/store';
import {FakeSlackClient} from '../slack/fake-client';
import type {Emailer, OutboundEmail} from '../../src/surveys/email';
import {
    createManualSurvey,
    createAndDispatch,
    isAutoSend,
    resendStrandedAutoSurveys,
    runTriggerSweep,
    sendSurvey,
    type DispatchDeps,
} from '../../src/surveys/dispatch';
import {getSurveyById, listSurveys} from '../../src/surveys/store';
import type {SurveyTriggerCandidate} from '../../src/surveys/triggers';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

class FakeEmailer implements Emailer {
    sent: OutboundEmail[] = [];
    error: Error | null = null;
    async sendEmail(message: OutboundEmail): Promise<void> {
        this.sent.push(message);
        if (this.error) throw this.error;
    }
}

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    addTeam(db, 'eng');
    return db;
}

function usageDropCandidate(developerId: string): SurveyTriggerCandidate {
    return {
        developerId,
        team: 'eng',
        triggerType: 'usage_drop',
        triggerContext: {tool: 'copilot', drop_pct: -50, period: '2026-05'},
    };
}

function insertMonthlyDrop(db: Database.Database, devId: string): void {
    db.prepare(
        `INSERT INTO monthly_aggregates (id, developer_id, month, team, interaction_delta_pct, computed_at)
         VALUES (?, ?, '2026-05', 'eng', -50, ?)`,
    ).run(randomUUID(), devId, new Date().toISOString());
}

describe('isAutoSend (settings-driven)', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
    });
    afterEach(() => db.close());

    it('defaults to false (manual) for every automated trigger', () => {
        expect(isAutoSend(db, 'usage_drop')).toBe(false);
        expect(isAutoSend(db, 'unused_new_seat')).toBe(false);
        expect(isAutoSend(db, 'plan_change')).toBe(false);
        expect(isAutoSend(db, 'anomaly')).toBe(false);
    });

    it('manual trigger is never auto-sent', () => {
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        expect(isAutoSend(db, 'manual')).toBe(false);
    });

    it('honors the global auto-send flag', () => {
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        expect(isAutoSend(db, 'usage_drop')).toBe(true);
    });

    it('honors a per-team override when the governing flag is on', () => {
        // Global stays false; enable manager overrides, then override for 'eng'.
        setGlobalSetting(db, 'survey_managers_can_override', true);
        setTeamSetting(db, 'eng', 'survey_usage_drop_auto', true);
        expect(isAutoSend(db, 'usage_drop', 'eng')).toBe(true);
        // Global (no team) is still manual.
        expect(isAutoSend(db, 'usage_drop')).toBe(false);
    });

    it('ignores a team override when the governing flag is off', () => {
        setTeamSetting(db, 'eng', 'survey_usage_drop_auto', true); // orphan override
        expect(isAutoSend(db, 'usage_drop', 'eng')).toBe(false);
    });
});

describe('createAndDispatch', () => {
    let db: Database.Database;
    let slack: FakeSlackClient;
    let emailer: FakeEmailer;
    beforeEach(() => {
        db = makeDb();
        slack = new FakeSlackClient();
        emailer = new FakeEmailer();
    });
    afterEach(() => db.close());

    function deps(): DispatchDeps {
        return {db, slackClient: slack, emailer, log: () => {}};
    }

    it('queues a survey when the trigger is manual (auto-send off)', async () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        const result = await createAndDispatch(deps(), usageDropCandidate(dev));
        expect(result.created).toBe(true);
        if (!result.created) return;
        expect(result.dispatched).toBe(false);
        expect(getSurveyById(db, result.survey.id)?.status).toBe('queued');
        expect(slack.postMessageCalls).toHaveLength(0);
    });

    it('auto-sends via Slack when auto-send is on and the dev has a Slack id', async () => {
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        const result = await createAndDispatch(deps(), usageDropCandidate(dev));
        expect(result.created).toBe(true);
        if (!result.created) return;
        expect(result.dispatched).toBe(true);
        expect(result.send?.delivered && result.send.delivery).toBe('slack');
        expect(slack.postMessageCalls).toHaveLength(1);
        expect(slack.postMessageCalls[0].channel).toBe('U_ALICE');
        expect(getSurveyById(db, result.survey.id)?.status).toBe('sent');
    });

    it('falls back to email when the developer has no Slack id', async () => {
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        const dev = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;
        const result = await createAndDispatch(deps(), usageDropCandidate(dev));
        expect(result.created).toBe(true);
        if (!result.created) return;
        expect(result.send?.delivered && result.send.delivery).toBe('email');
        expect(emailer.sent).toHaveLength(1);
        expect(emailer.sent[0].to).toBe('bob@example.com');
        expect(slack.postMessageCalls).toHaveLength(0);
    });

    it('falls back to email when Slack delivery throws', async () => {
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        slack.postMessageError = new Error('slack down');
        const dev = addDeveloper(db, 'Cara', 'eng', 'cara@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_CARA'});
        const result = await createAndDispatch(deps(), usageDropCandidate(dev));
        expect(result.created && result.send?.delivered && result.send.delivery).toBe('email');
        expect(emailer.sent).toHaveLength(1);
    });

    it('leaves the survey queued when it cannot be delivered anywhere', async () => {
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        const dev = addDeveloper(db, 'Dan', 'eng', 'dan@example.com').id;
        // No slack id, and no emailer available.
        const result = await createAndDispatch(
            {db, slackClient: slack, log: () => {}},
            usageDropCandidate(dev),
        );
        expect(result.created).toBe(true);
        if (!result.created) return;
        expect(result.dispatched).toBe(false);
        expect(result.send?.delivered).toBe(false);
        expect(getSurveyById(db, result.survey.id)?.status).toBe('queued');
    });

    it('dedupes a repeated trigger for the same developer', async () => {
        const dev = addDeveloper(db, 'Eve', 'eng', 'eve@example.com').id;
        const first = await createAndDispatch(deps(), usageDropCandidate(dev));
        expect(first.created).toBe(true);
        const second = await createAndDispatch(deps(), usageDropCandidate(dev));
        expect(second.created).toBe(false);
        if (second.created) return;
        expect(second.reason).toBe('duplicate');
    });

    it('does not create a survey for an unknown developer', async () => {
        const result = await createAndDispatch(deps(), usageDropCandidate('ghost'));
        expect(result.created).toBe(false);
        if (result.created) return;
        expect(result.reason).toBe('developer_missing');
    });
});

describe('sendSurvey (manager approval path)', () => {
    let db: Database.Database;
    let slack: FakeSlackClient;
    let emailer: FakeEmailer;
    beforeEach(() => {
        db = makeDb();
        slack = new FakeSlackClient();
        emailer = new FakeEmailer();
    });
    afterEach(() => db.close());

    it('sends a queued manual survey and flips it to sent', async () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        const survey = createManualSurvey(db, {developerId: dev, questionText: 'How is it going?'});
        expect(survey).not.toBeNull();
        const result = await sendSurvey({db, slackClient: slack, emailer}, survey!.id);
        expect(result.delivered).toBe(true);
        expect(getSurveyById(db, survey!.id)?.status).toBe('sent');
    });

    it('refuses to send a survey that is not queued', async () => {
        const dev = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;
        const survey = createManualSurvey(db, {developerId: dev, questionText: 'Q?'});
        await sendSurvey({db, emailer}, survey!.id); // first send → sent
        const again = await sendSurvey({db, emailer}, survey!.id);
        expect(again.delivered).toBe(false);
        if (again.delivered) return;
        expect(again.reason).toBe('not_queued');
    });
});

describe('createManualSurvey', () => {
    it('creates a queued manual survey, or null for an unknown developer', () => {
        const db = makeDb();
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        const ok = createManualSurvey(db, {developerId: dev, questionText: 'Custom question?'});
        expect(ok?.status).toBe('queued');
        expect(ok?.trigger_type).toBe('manual');
        expect(ok?.question_text).toBe('Custom question?');
        expect(createManualSurvey(db, {developerId: 'nope', questionText: 'x'})).toBeNull();
        db.close();
    });
});

describe('runTriggerSweep', () => {
    it('detects, creates, and reports a summary (queued when auto-send off)', async () => {
        const db = makeDb();
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        insertMonthlyDrop(db, dev);
        const summary = await runTriggerSweep({db, emailer: new FakeEmailer()});
        expect(summary.candidates).toBe(1);
        expect(summary.created).toBe(1);
        expect(summary.queued).toBe(1);
        expect(summary.autoSent).toBe(0);
        expect(listSurveys(db, {status: 'queued'})).toHaveLength(1);
        db.close();
    });

    it('auto-sends during a sweep when the setting is on', async () => {
        const db = makeDb();
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        insertMonthlyDrop(db, dev);
        const slack = new FakeSlackClient();
        const summary = await runTriggerSweep({db, slackClient: slack});
        expect(summary.autoSent).toBe(1);
        expect(slack.postMessageCalls).toHaveLength(1);
        db.close();
    });

    it('retries a stranded auto-survey on the next sweep and recovers it', async () => {
        const db = makeDb();
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        insertMonthlyDrop(db, dev);

        // First sweep: Slack down and no emailer → survey stranded queued.
        const slack = new FakeSlackClient();
        slack.postMessageError = new Error('slack down');
        const first = await runTriggerSweep({db, slackClient: slack, log: () => {}});
        expect(first.created).toBe(1);
        expect(first.autoSent).toBe(0);
        expect(first.undeliverable).toBe(1);
        expect(listSurveys(db, {status: 'queued'})).toHaveLength(1);

        // Slack recovers: next sweep retries the stranded survey and sends it.
        slack.postMessageError = null;
        const second = await runTriggerSweep({db, slackClient: slack, log: () => {}});
        expect(second.retried).toBe(1);
        expect(second.recovered).toBe(1);
        // The re-detected candidate is deduped against the now-sent survey.
        expect(second.created).toBe(0);
        expect(listSurveys(db, {status: 'sent'})).toHaveLength(1);
        db.close();
    });

    it('resendStrandedAutoSurveys ignores manual + non-auto queued surveys', async () => {
        const db = makeDb();
        // usage_drop auto OFF (default) → a queued usage_drop survey is NOT a
        // stranded auto-send; a manual survey is never auto-sent either.
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        createManualSurvey(db, {developerId: dev, questionText: 'Q?'});
        const slack = new FakeSlackClient();
        const result = await resendStrandedAutoSurveys({db, slackClient: slack});
        expect(result.retried).toBe(0);
        expect(slack.postMessageCalls).toHaveLength(0);
        db.close();
    });
});
