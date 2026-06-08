import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../src/registry/developers';
import {
    handleSlashCommand,
    handleInteraction,
    UNLINKED_MESSAGE,
} from '../../src/slack/handlers';
import {
    CALLBACK_LOG_SUBMIT,
    ACTION_OPEN_LOG,
    ACTION_DISMISS_PROMPT,
    BLOCK_TOOL,
    ACTION_TOOL,
    BLOCK_MINUTES,
    ACTION_MINUTES,
    BLOCK_TASK,
    ACTION_TASK,
} from '../../src/slack/blocks';
import {FakeSlackClient} from './fake-client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function ensureTeam(db: Database.Database, name = 'eng'): void {
    const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name);
    if (!exists) addTeam(db, name);
}

function seedLinkedDev(db: Database.Database, slackId: string, name = 'Alice'): string {
    ensureTeam(db);
    const dev = addDeveloper(db, name, 'eng', `${name.toLowerCase()}@example.com`);
    linkDeveloper(db, dev.id, {slack: slackId});
    return dev.id;
}

interface SelfReportRow {
    developer_id: string;
    tool: string;
    minutes: number | null;
    task_descriptor: string | null;
    source_interface: string;
    date: string;
}
function selfReports(db: Database.Database): SelfReportRow[] {
    return db.prepare('SELECT * FROM self_reports').all() as SelfReportRow[];
}

function submission(
    slackUserId: string,
    opts: {tool?: string; minutesKey?: string; task?: string; date?: string} = {},
): unknown {
    const values: Record<string, unknown> = {};
    if (opts.tool !== undefined) {
        values[BLOCK_TOOL] = {[ACTION_TOOL]: {selected_option: {value: opts.tool}}};
    }
    if (opts.minutesKey !== undefined) {
        values[BLOCK_MINUTES] = {[ACTION_MINUTES]: {selected_option: {value: opts.minutesKey}}};
    }
    if (opts.task !== undefined) {
        values[BLOCK_TASK] = {[ACTION_TASK]: {value: opts.task}};
    }
    return {
        type: 'view_submission',
        user: {id: slackUserId},
        view: {
            callback_id: CALLBACK_LOG_SUBMIT,
            private_metadata: opts.date ?? '',
            state: {values},
        },
    };
}

describe('handleSlashCommand', () => {
    let db: Database.Database;
    let client: FakeSlackClient;

    beforeEach(() => {
        db = makeDb();
        client = new FakeSlackClient();
    });
    afterEach(() => db.close());

    it('opens the log modal for a linked developer', async () => {
        seedLinkedDev(db, 'U_ALICE');
        const result = await handleSlashCommand(
            {user_id: 'U_ALICE', trigger_id: 'trig-1', command: '/govproxy-log'},
            {db, client},
        );
        expect(result.status).toBe(200);
        expect(client.openViewCalls).toHaveLength(1);
        expect(client.openViewCalls[0].triggerId).toBe('trig-1');
        expect(client.openViewCalls[0].view.callback_id).toBe(CALLBACK_LOG_SUBMIT);
    });

    it('returns the unlinked message and opens no modal for an unmapped Slack user', async () => {
        const result = await handleSlashCommand(
            {user_id: 'U_STRANGER', trigger_id: 'trig-1'},
            {db, client},
        );
        expect(client.openViewCalls).toHaveLength(0);
        expect(result.body).toMatchObject({response_type: 'ephemeral', text: UNLINKED_MESSAGE});
    });

    it('reports an error if the modal fails to open', async () => {
        seedLinkedDev(db, 'U_ALICE');
        client.openViewError = new Error('slack down');
        const result = await handleSlashCommand({user_id: 'U_ALICE', trigger_id: 't'}, {db, client});
        expect(result.body).toMatchObject({response_type: 'ephemeral'});
    });
});

describe('handleInteraction — view submission', () => {
    let db: Database.Database;
    let client: FakeSlackClient;

    beforeEach(() => {
        db = makeDb();
        client = new FakeSlackClient();
    });
    afterEach(() => db.close());

    it('writes a self-report through the core with source_interface "slack"', async () => {
        const devId = seedLinkedDev(db, 'U_ALICE');
        const result = await handleInteraction(
            submission('U_ALICE', {tool: 'cursor', minutesKey: 'about1h', task: 'refactor auth', date: '2024-03-01'}),
            {db, client},
        );
        expect(result.status).toBe(200);
        expect(result.body).toBeUndefined(); // empty 200 closes the modal

        const rows = selfReports(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            developer_id: devId,
            tool: 'cursor',
            minutes: 60,
            task_descriptor: 'refactor auth',
            source_interface: 'slack',
            date: '2024-03-01',
        });

        // Snapshot written + confirmation DM sent to the submitting user.
        const snap = db
            .prepare('SELECT data_source FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?')
            .get(devId, '2024-03-01', 'cursor') as {data_source: string} | undefined;
        expect(snap?.data_source).toBe('self_report');
        expect(client.postMessageCalls).toHaveLength(1);
        expect(client.postMessageCalls[0].channel).toBe('U_ALICE');
    });

    it('logs only for the submitting developer (never the wrong one)', async () => {
        const aliceId = seedLinkedDev(db, 'U_ALICE', 'Alice');
        const bobId = seedLinkedDev(db, 'U_BOB', 'Bob');
        await handleInteraction(submission('U_BOB', {tool: 'copilot', date: '2024-03-02'}), {db, client});

        const rows = selfReports(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].developer_id).toBe(bobId);
        expect(rows[0].developer_id).not.toBe(aliceId);
    });

    it('returns a clear error for an unlinked submitter and writes nothing', async () => {
        const result = await handleInteraction(submission('U_STRANGER', {tool: 'cursor'}), {db, client});
        expect(result.body).toMatchObject({
            response_action: 'errors',
            errors: {[BLOCK_TOOL]: UNLINKED_MESSAGE},
        });
        expect(selfReports(db)).toHaveLength(0);
    });

    it('returns a field error when no tool is selected', async () => {
        seedLinkedDev(db, 'U_ALICE');
        const result = await handleInteraction(submission('U_ALICE', {date: '2024-03-01'}), {db, client});
        expect(result.body).toMatchObject({response_action: 'errors'});
        expect(selfReports(db)).toHaveLength(0);
    });

    it('still succeeds (report committed) even if the confirmation DM fails', async () => {
        const devId = seedLinkedDev(db, 'U_ALICE');
        client.postMessageError = new Error('dm failed');
        const result = await handleInteraction(
            submission('U_ALICE', {tool: 'chatgpt', date: '2024-03-03'}),
            {db, client},
        );
        expect(result.status).toBe(200);
        expect(result.body).toBeUndefined();
        const rows = selfReports(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].developer_id).toBe(devId);
    });

    it('logs with no minutes/task when those optional fields are omitted', async () => {
        seedLinkedDev(db, 'U_ALICE');
        await handleInteraction(submission('U_ALICE', {tool: 'other', date: '2024-03-04'}), {db, client});
        const rows = selfReports(db);
        expect(rows[0].minutes).toBeNull();
        expect(rows[0].task_descriptor).toBeNull();
    });
});

describe('handleInteraction — block actions', () => {
    let db: Database.Database;
    let client: FakeSlackClient;

    beforeEach(() => {
        db = makeDb();
        client = new FakeSlackClient();
    });
    afterEach(() => db.close());

    it('opens the log modal when the prompt button is clicked', async () => {
        const payload = {
            type: 'block_actions',
            user: {id: 'U_ALICE'},
            trigger_id: 'trig-9',
            actions: [{action_id: ACTION_OPEN_LOG}],
        };
        const result = await handleInteraction(payload, {db, client});
        expect(result.status).toBe(200);
        expect(client.openViewCalls).toHaveLength(1);
        expect(client.openViewCalls[0].triggerId).toBe('trig-9');
    });

    it('deletes the original message when dismissed', async () => {
        const payload = {
            type: 'block_actions',
            user: {id: 'U_ALICE'},
            response_url: 'https://hooks.slack.test/abc',
            actions: [{action_id: ACTION_DISMISS_PROMPT}],
        };
        await handleInteraction(payload, {db, client});
        expect(client.respondCalls).toHaveLength(1);
        expect(client.respondCalls[0].responseUrl).toBe('https://hooks.slack.test/abc');
        expect(client.respondCalls[0].body).toMatchObject({delete_original: true});
    });

    it('acknowledges an unknown interaction type without side effects', async () => {
        const result = await handleInteraction({type: 'something_else'}, {db, client});
        expect(result.status).toBe(200);
        expect(client.openViewCalls).toHaveLength(0);
        expect(client.respondCalls).toHaveLength(0);
    });
});
