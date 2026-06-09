import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {notifyNewAnomalies} from '../../src/anomaly/notify';
import {upsertAnomaly, getAnomalyById, listAnomalies, type UpsertAnomalyInput} from '../../src/anomaly/store';
import {setGlobalSetting} from '../../src/settings/store';
import type {SlackClient} from '../../src/slack/client';
import type {SlackBlock, SlackView} from '../../src/slack/blocks';

interface PostedMessage {
    channel: string;
    text: string;
    blocks?: SlackBlock[];
}

function fakeSlack(): {client: SlackClient; posts: PostedMessage[]; fail: () => void} {
    const posts: PostedMessage[] = [];
    let shouldFail = false;
    const client: SlackClient = {
        async openView(_t: string, _v: SlackView): Promise<void> {},
        async postMessage(channel, text, blocks): Promise<void> {
            if (shouldFail) throw new Error('slack down');
            posts.push({channel, text, blocks});
        },
        async deleteMessage(): Promise<void> {},
        async replaceMessage(): Promise<void> {},
    };
    return {client, posts, fail: () => (shouldFail = true)};
}

const teamAnomaly = (overrides: Partial<UpsertAnomalyInput> = {}): UpsertAnomalyInput => ({
    scope: 'team',
    scopeId: 'frontend',
    metric: 'commits',
    period: '2026-05-04',
    method: 'statistical',
    observedValue: 4,
    expectedValue: 10,
    deviation: -3.1,
    severity: 'high',
    basis: 'git_estimate',
    ...overrides,
});

describe('notifyNewAnomalies', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
    });
    afterEach(() => {
        db.close();
    });

    it('posts notable/high team anomalies when alerts enabled, then marks them notified', async () => {
        setGlobalSetting(db, 'anomaly_alerts_enabled', true);
        upsertAnomaly(db, teamAnomaly({metric: 'commits', severity: 'high'}));
        upsertAnomaly(db, teamAnomaly({metric: 'cost', severity: 'notable', method: 'percentage_change'}));

        const {client, posts} = fakeSlack();
        const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

        expect(result.notified).toBe(2);
        expect(posts).toHaveLength(2);
        // Both rows are stamped notified.
        for (const a of listAnomalies(db)) {
            expect(a.notified_at).not.toBeNull();
        }

        // A second run re-detects nothing new — idempotent, no re-spam.
        const second = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});
        expect(second.candidates).toBe(0);
        expect(second.notified).toBe(0);
        expect(posts).toHaveLength(2);
    });

    it('does not surface info-severity anomalies (no noise)', async () => {
        setGlobalSetting(db, 'anomaly_alerts_enabled', true);
        upsertAnomaly(db, teamAnomaly({severity: 'info'}));

        const {client, posts} = fakeSlack();
        const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

        expect(result.candidates).toBe(0);
        expect(posts).toHaveLength(0);
    });

    it('respects the alert setting: off → not posted and left unnotified', async () => {
        // anomaly_alerts_enabled defaults to false.
        upsertAnomaly(db, teamAnomaly());
        const before = listAnomalies(db)[0];

        const {client, posts} = fakeSlack();
        const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

        expect(result.skippedSettings).toBe(1);
        expect(result.notified).toBe(0);
        expect(posts).toHaveLength(0);
        expect(getAnomalyById(db, before.id)?.notified_at).toBeNull();
    });

    it('never pushes a developer-scope anomaly (privacy: individual data)', async () => {
        setGlobalSetting(db, 'anomaly_alerts_enabled', true);
        upsertAnomaly(db, teamAnomaly({scope: 'developer', scopeId: 'dev-1'}));

        const {client, posts} = fakeSlack();
        const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

        expect(result.candidates).toBe(0);
        expect(posts).toHaveLength(0);
    });

    it('leaves anomalies unnotified when undeliverable (no client/channels)', async () => {
        setGlobalSetting(db, 'anomaly_alerts_enabled', true);
        upsertAnomaly(db, teamAnomaly());

        const result = await notifyNewAnomalies({db, channels: []});
        expect(result.skippedUndeliverable).toBe(1);
        expect(result.notified).toBe(0);
        expect(listAnomalies(db)[0].notified_at).toBeNull();
    });

    it('posts to every configured channel', async () => {
        setGlobalSetting(db, 'anomaly_alerts_enabled', true);
        upsertAnomaly(db, teamAnomaly());

        const {client, posts} = fakeSlack();
        await notifyNewAnomalies({db, slackClient: client, channels: ['C1', 'C2']});

        expect(posts.map((p) => p.channel).sort()).toEqual(['C1', 'C2']);
    });

    it('on total delivery failure leaves the anomaly unnotified for retry', async () => {
        setGlobalSetting(db, 'anomaly_alerts_enabled', true);
        upsertAnomaly(db, teamAnomaly());

        const {client, fail} = fakeSlack();
        fail();
        const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

        expect(result.notified).toBe(0);
        expect(result.skippedUndeliverable).toBe(1);
        expect(listAnomalies(db)[0].notified_at).toBeNull();
    });

    // Task 4.12: anomaly_alert_min_severity raises the floor. 'high' suppresses
    // notable anomalies (left unnotified), while 'notable' lets both through.
    describe('anomaly_alert_min_severity floor', () => {
        it("'high' suppresses notable but still posts high", async () => {
            setGlobalSetting(db, 'anomaly_alerts_enabled', true);
            setGlobalSetting(db, 'anomaly_alert_min_severity', 'high');
            upsertAnomaly(db, teamAnomaly({metric: 'commits', severity: 'high'}));
            upsertAnomaly(db, teamAnomaly({metric: 'cost', severity: 'notable', method: 'percentage_change'}));

            const {client, posts} = fakeSlack();
            const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

            expect(result.notified).toBe(1);
            expect(result.skippedSeverity).toBe(1);
            expect(posts).toHaveLength(1);
            // The suppressed notable one stays unnotified so lowering the floor
            // later still announces it.
            const notable = listAnomalies(db).find((a) => a.severity === 'notable');
            expect(notable?.notified_at).toBeNull();
        });

        it("default 'notable' posts both notable and high", async () => {
            setGlobalSetting(db, 'anomaly_alerts_enabled', true);
            upsertAnomaly(db, teamAnomaly({metric: 'commits', severity: 'high'}));
            upsertAnomaly(db, teamAnomaly({metric: 'cost', severity: 'notable', method: 'percentage_change'}));

            const {client, posts} = fakeSlack();
            const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

            expect(result.notified).toBe(2);
            expect(result.skippedSeverity).toBe(0);
            expect(posts).toHaveLength(2);
        });

        it('honors a per-team severity floor when the override flag is on', async () => {
            setGlobalSetting(db, 'anomaly_alerts_enabled', true);
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
            // Team raises its own floor to high; a notable anomaly is suppressed.
            db.prepare(
                "INSERT INTO settings (scope, scope_name, key, value, updated_at) VALUES ('team','frontend','anomaly_alert_min_severity',?, '2026-01-01T00:00:00.000Z')",
            ).run(JSON.stringify('high'));
            upsertAnomaly(db, teamAnomaly({metric: 'cost', severity: 'notable', method: 'percentage_change'}));

            const {client, posts} = fakeSlack();
            const result = await notifyNewAnomalies({db, slackClient: client, channels: ['C1']});

            expect(result.skippedSeverity).toBe(1);
            expect(posts).toHaveLength(0);
        });
    });
});
