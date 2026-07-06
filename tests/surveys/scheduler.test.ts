import {describe, it, expect, afterEach} from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {randomUUID} from 'crypto';
import {openDb} from '../../src/storage/db';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../src/registry/developers';
import {setGlobalSetting} from '../../src/settings/store';
import type {TopropeConfig} from '../../src/config/types';
import {runScheduledSurveySweep, startSurveyScheduler} from '../../src/surveys/scheduler';
import {FakeSlackClient} from '../slack/fake-client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

// Minimal config the scheduler actually reads (slack + surveys blocks only).
function cfg(partial: Partial<TopropeConfig>): TopropeConfig {
    return partial as TopropeConfig;
}

describe('startSurveyScheduler gating', () => {
    it('returns no task when surveys are disabled or absent', () => {
        expect(startSurveyScheduler('x.db', cfg({surveys: {enabled: false}}))).toHaveLength(0);
        expect(startSurveyScheduler('x.db', cfg({}))).toHaveLength(0);
    });

    it('schedules one task when enabled', () => {
        const tasks = startSurveyScheduler(
            'x.db',
            cfg({surveys: {enabled: true}, slack: {enabled: false}}),
            {slackClient: new FakeSlackClient()},
        );
        expect(tasks).toHaveLength(1);
        tasks.forEach((t) => t.stop());
    });

    it('falls back to the default time on a malformed sweep_time', () => {
        const tasks = startSurveyScheduler(
            'x.db',
            cfg({surveys: {enabled: true, sweep_time: 'nope'}}),
            {slackClient: new FakeSlackClient()},
        );
        expect(tasks).toHaveLength(1);
        tasks.forEach((t) => t.stop());
    });
});

describe('runScheduledSurveySweep', () => {
    let dbPath = '';
    afterEach(() => {
        if (dbPath) fs.rmSync(dbPath, {force: true});
        dbPath = '';
    });

    it('opens the db, runs a sweep, and returns a summary', async () => {
        dbPath = path.join(os.tmpdir(), `surveys-sched-${randomUUID()}.db`);
        const seed = openDb(dbPath);
        runMigrations(seed, MIGRATIONS_DIR);
        addTeam(seed, 'eng');
        const dev = addDeveloper(seed, 'Alice', 'eng', 'alice@example.com').id;
        linkDeveloper(seed, dev, {slack: 'U_ALICE'});
        setGlobalSetting(seed, 'survey_usage_drop_auto', true);
        seed.prepare(
            `INSERT INTO monthly_aggregates (id, developer_id, month, team, interaction_delta_pct, computed_at)
             VALUES (?, ?, '2026-05', 'eng', -55, ?)`,
        ).run(randomUUID(), dev, new Date().toISOString());
        seed.close();

        const slack = new FakeSlackClient();
        const summary = await runScheduledSurveySweep(
            dbPath,
            cfg({slack: {enabled: false}, surveys: {enabled: true}}),
            {slackClient: slack, log: () => {}},
        );
        expect(summary?.candidates).toBe(1);
        expect(summary?.autoSent).toBe(1);
        expect(slack.postMessageCalls).toHaveLength(1);
    });

    it('never throws — returns null when the db cannot be opened', async () => {
        // Pointing at an existing directory (not a file) makes better-sqlite3
        // fail to open — the failure must be caught and surfaced as null.
        const summary = await runScheduledSurveySweep(
            os.tmpdir(),
            cfg({surveys: {enabled: true}}),
            {log: () => {}},
        );
        expect(summary).toBeNull();
    });
});
