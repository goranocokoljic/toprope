import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cron from 'node-cron';
import {
    parseSyncTimeToCron,
    buildConnectorSchedule,
    createConnectorTick,
    startScheduler,
    type ScheduledConnector,
} from '../../src/scheduler/scheduler';
import type {TopropeConfig} from '../../src/config/types';
import type {ConnectorInterface} from '../../src/connectors/types';
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

/**
 * #283 — the cron tick's in-flight guard.
 *
 * `node-cron` fires on the wall clock and does not care whether the previous firing has
 * returned, so a run that outlasts its period used to overlap the next one. For git that is a
 * DATA-INTEGRITY defect, not a latency one: two overlapping runs read the same forward cursor,
 * fetch non-disjoint windows, and the additive commit merge double-counts them permanently.
 */
describe('createConnectorTick in-flight guard (#283)', () => {
    let dbPath: string;
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toprope-sched-'));
        dbPath = path.join(tmpDir, 'test.db');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    /** A connector whose `sync` blocks until the test releases it. */
    function makeBlockingConnector(): {
        connector: ConnectorInterface;
        syncCalls: () => number;
        release: () => void;
    } {
        let calls = 0;
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const connector: ConnectorInterface = {
            getName: () => 'git',
            // Part of ConnectorInterface. Present rather than omitted even though `runPipeline`
            // never calls it: `tsconfig.json` excludes `tests` and Vitest does not type-check,
            // so an incomplete stub compiles — and a stub that lies about the type is exactly
            // what widening `makeConnector` to `ConnectorInterface` was meant to make honest.
            getLastSyncTime: () => null,
            sync: async () => {
                calls++;
                await gate;
                return {
                    connector: 'git',
                    snapshotsWritten: 0,
                    snapshotsSkipped: 0,
                    errors: [],
                    lastSyncTime: '2026-07-31T03:30:00.000Z',
                };
            },
        };
        return {connector, syncCalls: () => calls, release};
    }

    function entryFor(connector: ConnectorInterface, name = 'git'): ScheduledConnector {
        return {name, enabled: true, syncTime: '03:30', makeConnector: () => connector};
    }

    it('skips a tick that fires while the previous run is still going', async () => {
        const {connector, syncCalls, release} = makeBlockingConnector();
        const tick = createConnectorTick(entryFor(connector), dbPath);

        const first = tick();
        // Let the first tick reach the blocked `sync`.
        await Promise.resolve();
        await Promise.resolve();
        expect(syncCalls()).toBe(1);

        // The cron fires again while the first run is still in flight.
        await tick();
        // SKIPPED, not queued: the skipped tick's work is exactly what the running one is
        // already doing, so queueing would preserve the overlap one period later.
        expect(syncCalls()).toBe(1);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('still in flight'),
        );

        release();
        await first;
    });

    it('guards each connector separately — a long git run does not suppress copilot', async () => {
        // `startScheduler` builds one tick closure PER entry, so the guard is per connector.
        // Hoisting `inFlight` to module scope — the obvious "simplification" — keeps every
        // other test in this block green while a 4-hour git run silently swallows that day's
        // copilot, claude-code, windsurf and cursor ticks.
        const git = makeBlockingConnector();
        const copilot = makeBlockingConnector();
        copilot.release();
        const gitTick = createConnectorTick(entryFor(git.connector, 'git'), dbPath);
        const copilotTick = createConnectorTick(entryFor(copilot.connector, 'copilot'), dbPath);

        const gitRun = gitTick();
        await Promise.resolve();
        await Promise.resolve();
        expect(git.syncCalls()).toBe(1);

        await copilotTick();
        expect(copilot.syncCalls()).toBe(1);
        expect(console.warn).not.toHaveBeenCalled();

        git.release();
        await gitRun;
    });

    it('runs the NEXT tick once the previous one has finished', async () => {
        // Positive control: without it the test above would pass against a guard that latched
        // permanently and silently stopped every future sync.
        const {connector, syncCalls, release} = makeBlockingConnector();
        const tick = createConnectorTick(entryFor(connector), dbPath);

        const first = tick();
        await Promise.resolve();
        release();
        await first;

        await tick();
        expect(syncCalls()).toBe(2);
    });

    it('startScheduler gives each enabled connector its OWN guarded tick', () => {
        // The seam where the guard actually reaches production, and the only place the
        // per-connector property is decided. `createConnectorTick` being per-instance proves
        // nothing if `startScheduler` hoists one closure out of the loop — a 4-hour git run
        // would then swallow that day's copilot/claude-code/windsurf/cursor ticks, invisibly.
        const config = makeConfig();
        config.connectors.git.enabled = true;
        config.connectors.copilot.enabled = true;
        config.connectors.claude_code.enabled = false;
        config.connectors.windsurf.enabled = false;
        config.connectors.cursor.enabled = false;

        const registered: Array<{expr: string; cb: () => Promise<void>; opts: unknown}> = [];
        const scheduleSpy = vi
            .spyOn(cron, 'schedule')
            .mockImplementation(((expr: string, cb: () => Promise<void>, opts: unknown) => {
                registered.push({expr, cb, opts});
                return {stop: (): void => {}} as unknown as ReturnType<typeof cron.schedule>;
            }) as unknown as typeof cron.schedule);

        startScheduler(config, dbPath);

        // Only the two enabled connectors, each at its own time and in UTC.
        expect(scheduleSpy).toHaveBeenCalledTimes(2);
        expect(registered.map((r) => r.expr)).toEqual(['00 02 * * *', '30 03 * * *']);
        expect(registered.every((r) => (r.opts as {timezone: string}).timezone === 'UTC')).toBe(true);
        // DISTINCT closures — the regression this test exists for. Hoisting
        // `createConnectorTick(entry, dbPath)` out of the loop makes these the same function,
        // and one connector's in-flight run then suppresses every other connector's tick.
        // (That the guard is per-closure is proven by the sibling test above; this proves
        // `startScheduler` really hands each connector its own.)
        expect(registered[0].cb).not.toBe(registered[1].cb);
    });

    it('releases the guard when the tick cannot even open the database', async () => {
        // The sharpest wedge case: `openDb` runs before any connector work, so before #283 a
        // failure there escaped the handler entirely. That was harmless when the tick held no
        // state; with a guard it would latch `inFlight` forever and silently stop every future
        // sync, with nothing in the log to say why.
        const {connector, syncCalls, release} = makeBlockingConnector();
        release();
        // A path whose PARENT is a regular file: `openDb` creates missing directories, so a
        // merely-absent one would succeed. This is the shape a misconfigured `db_path` really
        // takes.
        const blocker = path.join(tmpDir, 'not-a-dir');
        fs.writeFileSync(blocker, 'x');
        const badPath = path.join(blocker, 'test.db');
        const tick = createConnectorTick(entryFor(connector), badPath);

        await tick();
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('git unhandled error'),
            expect.anything(),
        );
        // The guard is free again, so a later tick still runs — proven by the connector being
        // reached on the second call, which the first never got to.
        expect(syncCalls()).toBe(0);

        const good = createConnectorTick(entryFor(connector), dbPath);
        await good();
        expect(syncCalls()).toBe(1);
        await tick();
        // Second failing tick STILL ran (and failed again) rather than being skipped.
        expect((console.error as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });
});
