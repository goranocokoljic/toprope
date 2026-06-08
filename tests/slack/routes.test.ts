import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import Database from 'better-sqlite3';
import path from 'path';
import {createHmac} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../src/registry/developers';
import {registerSlackRoutes} from '../../src/slack/routes';
import {BLOCK_TOOL, ACTION_TOOL} from '../../src/slack/blocks';
import {FakeSlackClient} from './fake-client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const SECRET = 'route-signing-secret';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function signedHeaders(body: string, secret = SECRET, ts = String(Math.floor(Date.now() / 1000))): Record<string, string> {
    const digest = createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
    return {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': `v0=${digest}`,
    };
}

describe('Slack routes', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let client: FakeSlackClient;

    beforeEach(async () => {
        db = makeDb();
        client = new FakeSlackClient();
        app = Fastify({logger: false});
        registerSlackRoutes(
            app,
            db,
            {enabled: true, signing_secret: SECRET, bot_token: 'xoxb-test'},
            {client},
        );
        await app.ready();
    });
    afterEach(async () => {
        await app.close();
        db.close();
    });

    function seedLinked(slackId: string, name = 'Alice'): string {
        addTeam(db, 'eng');
        const dev = addDeveloper(db, name, 'eng', `${name.toLowerCase()}@example.com`);
        linkDeveloper(db, dev.id, {slack: slackId});
        return dev.id;
    }

    it('rejects a request with a bad signature (401)', async () => {
        const body = 'user_id=U_ALICE&trigger_id=t1&command=%2Fgovproxy-log';
        const res = await app.inject({
            method: 'POST',
            url: '/slack/commands',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
                'x-slack-signature': 'v0=deadbeef',
            },
            payload: body,
        });
        expect(res.statusCode).toBe(401);
        expect(client.openViewCalls).toHaveLength(0);
    });

    it('handles a correctly signed slash command and opens a modal', async () => {
        seedLinked('U_ALICE');
        const body = 'user_id=U_ALICE&trigger_id=t1&command=%2Fgovproxy-log';
        const res = await app.inject({
            method: 'POST',
            url: '/slack/commands',
            headers: signedHeaders(body),
            payload: body,
        });
        expect(res.statusCode).toBe(200);
        expect(client.openViewCalls).toHaveLength(1);
    });

    it('returns the unlinked ephemeral message for an unmapped user', async () => {
        const body = 'user_id=U_STRANGER&trigger_id=t1&command=%2Fgovproxy-log';
        const res = await app.inject({
            method: 'POST',
            url: '/slack/commands',
            headers: signedHeaders(body),
            payload: body,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({response_type: 'ephemeral'});
        expect(client.openViewCalls).toHaveLength(0);
    });

    it('handles a signed interactivity submission and writes a self-report', async () => {
        const devId = seedLinked('U_ALICE');
        const payloadObj = {
            type: 'view_submission',
            user: {id: 'U_ALICE'},
            view: {
                private_metadata: '2024-05-01',
                state: {values: {[BLOCK_TOOL]: {[ACTION_TOOL]: {selected_option: {value: 'cursor'}}}}},
            },
        };
        const body = 'payload=' + encodeURIComponent(JSON.stringify(payloadObj));
        const res = await app.inject({
            method: 'POST',
            url: '/slack/interactivity',
            headers: signedHeaders(body),
            payload: body,
        });
        expect(res.statusCode).toBe(200);
        const rows = db.prepare('SELECT * FROM self_reports').all() as {developer_id: string; source_interface: string}[];
        expect(rows).toHaveLength(1);
        expect(rows[0].developer_id).toBe(devId);
        expect(rows[0].source_interface).toBe('slack');
    });

    it('rejects interactivity with an invalid signature (401) and writes nothing', async () => {
        seedLinked('U_ALICE');
        const body = 'payload=' + encodeURIComponent(JSON.stringify({type: 'view_submission', user: {id: 'U_ALICE'}}));
        const res = await app.inject({
            method: 'POST',
            url: '/slack/interactivity',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
                'x-slack-signature': 'v0=bad',
            },
            payload: body,
        });
        expect(res.statusCode).toBe(401);
        expect(db.prepare('SELECT COUNT(*) AS n FROM self_reports').get()).toMatchObject({n: 0});
    });
});
