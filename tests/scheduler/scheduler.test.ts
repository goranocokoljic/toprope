import {describe, it, expect} from 'vitest';
import {parseSyncTimeToCron, buildConnectorSchedule} from '../../src/scheduler/scheduler';
import type {TopropeConfig} from '../../src/config/types';
import {defaultConfig} from '../../src/config/defaults';

function makeConfig(overrides: Partial<TopropeConfig> = {}): TopropeConfig {
    return {...defaultConfig, ...overrides};
}

describe('parseSyncTimeToCron', () => {
    it('converts HH:MM to cron expression', () => {
        expect(parseSyncTimeToCron('02:00')).toBe('00 02 * * *');
        expect(parseSyncTimeToCron('02:30')).toBe('30 02 * * *');
        expect(parseSyncTimeToCron('03:00')).toBe('00 03 * * *');
        expect(parseSyncTimeToCron('03:30')).toBe('30 03 * * *');
    });

    it('handles midnight', () => {
        expect(parseSyncTimeToCron('00:00')).toBe('00 00 * * *');
    });
});

describe('buildConnectorSchedule', () => {
    it('returns five connectors', () => {
        const schedule = buildConnectorSchedule(makeConfig());
        expect(schedule).toHaveLength(5);
        expect(schedule.map((s) => s.name)).toEqual([
            'copilot',
            'claude_code',
            'windsurf',
            'cursor',
            'git',
        ]);
    });

    it('uses connector sync_time from config', () => {
        const config = makeConfig();
        config.connectors.copilot.sync_time = '05:15';
        const schedule = buildConnectorSchedule(config);
        expect(schedule[0].syncTime).toBe('05:15');
    });

    it('falls back to default sync times when not configured', () => {
        const config = makeConfig();
        delete config.connectors.copilot.sync_time;
        delete config.connectors.claude_code.sync_time;
        delete config.connectors.windsurf.sync_time;
        delete config.connectors.cursor.sync_time;
        delete config.connectors.git.sync_time;

        const schedule = buildConnectorSchedule(config);
        expect(schedule[0].syncTime).toBe('02:00');
        expect(schedule[1].syncTime).toBe('02:30');
        expect(schedule[2].syncTime).toBe('03:00');
        expect(schedule[3].syncTime).toBe('03:15');
        expect(schedule[4].syncTime).toBe('03:30');
    });

    it('reflects enabled state from config', () => {
        const config = makeConfig();
        config.connectors.copilot.enabled = true;
        config.connectors.claude_code.enabled = false;

        const schedule = buildConnectorSchedule(config);
        expect(schedule[0].enabled).toBe(true);
        expect(schedule[1].enabled).toBe(false);
    });

    it('makeConnector returns a connector for each entry', () => {
        const schedule = buildConnectorSchedule(makeConfig());
        for (const entry of schedule) {
            const connector = entry.makeConnector();
            expect(connector.getName()).toBeTruthy();
        }
    });
});
