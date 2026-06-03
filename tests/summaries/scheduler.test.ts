import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';
import {
    SUMMARY_AUTO_LEVELS,
    SUMMARY_CRON,
    type SummaryAutoLevel,
    type SummaryAutoLogger,
    type GenerateSummaryFn,
    isAutoGenerationEnabled,
    enabledAutoLevels,
    enumerateScopes,
    aggregateCompleted,
    runSummaryAutoGenerationJob,
    runScheduledSummaryJob,
} from '../../src/summaries/scheduler';
import {generateSummary} from '../../src/summaries/generator';
import {getSummaryByTarget} from '../../src/summaries/store';
import type {SummaryScope} from '../../src/summaries/input-builder';
import type {SummaryModelClient, SummaryModelResult} from '../../src/summaries/model-client';
import {isoWeekLabel} from '../../src/aggregation/dates';
import {runAggregationForPeriod} from '../../src/aggregation/scheduler';
import {openDb} from '../../src/storage/db';
import {runMigrations} from '../../src/storage/migrator';
import {makeDb, addDeveloper, addGitSnapshot, addSubscription} from '../aggregation/helpers';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

// Monday 2026-06-08 04:15 UTC — a representative weekly summary fire. The week that
// just closed is 2026-06-01 … 06-07 (aggregate key = its Monday 2026-06-01; summary
// label = its ISO week).
const WEEKLY_NOW = new Date('2026-06-08T04:15:00.000Z');
const WEEKLY_AGG_KEY = '2026-06-01';
const WEEKLY_LABEL = isoWeekLabel(WEEKLY_AGG_KEY);

// 1st 2026-06-01 04:45 UTC — a representative monthly summary fire. The month that
// just closed is 2026-05 (both the aggregate key and the summary label).
const MONTHLY_NOW = new Date('2026-06-01T04:45:00.000Z');
const MONTHLY_KEY = '2026-05';

/** A fake model client whose generate() always succeeds with a clean narrative. */
function okClient(): SummaryModelClient {
    return {
        generate: async (): Promise<SummaryModelResult> => ({
            ok: true,
            text: 'A clean git-based narrative.',
            model: 'test-model',
        }),
    } as unknown as SummaryModelClient;
}

/**
 * A generator wired to the real generateSummary but with a fake model client, so the
 * job's orchestration exercises the genuine input-build + store path (summaries
 * really land in the DB) without a live model. `failFor` forces a handled failure
 * for one scope to test isolation.
 */
function realGenerateWith(failFor?: (scope: SummaryScope) => boolean): GenerateSummaryFn {
    return (db, summaries, target, opts) => {
        if (failFor && failFor(target.scope)) {
            return Promise.resolve({ok: false, error: 'forced failure', retryable: false});
        }
        return generateSummary(db, summaries, target, {...opts, createClient: () => okClient()});
    };
}

/** A logger that records every lifecycle call for assertions. */
function recordingLogger(): SummaryAutoLogger & {
    starts: Array<{level: SummaryAutoLevel; period: string; scopeCount: number}>;
    missing: Array<{level: SummaryAutoLevel; period: string; aggKey: string}>;
    generated: Array<{scope: SummaryScope; period: string}>;
    failed: Array<{scope: SummaryScope; error: string}>;
    completes: Array<{level: SummaryAutoLevel; generated: number; failed: number}>;
} {
    const starts: Array<{level: SummaryAutoLevel; period: string; scopeCount: number}> = [];
    const missing: Array<{level: SummaryAutoLevel; period: string; aggKey: string}> = [];
    const generated: Array<{scope: SummaryScope; period: string}> = [];
    const failed: Array<{scope: SummaryScope; error: string}> = [];
    const completes: Array<{level: SummaryAutoLevel; generated: number; failed: number}> = [];
    return {
        starts,
        missing,
        generated,
        failed,
        completes,
        jobStart: (level, period, scopeCount) => void starts.push({level, period, scopeCount}),
        aggregateMissing: (level, period, aggKey) => void missing.push({level, period, aggKey}),
        scopeGenerated: (_level, period, scope) => void generated.push({scope, period}),
        scopeFailed: (_level, _period, scope, error) => void failed.push({scope, error}),
        jobComplete: (level, _period, generated_, failed_) =>
            void completes.push({level, generated: generated_, failed: failed_}),
    };
}

/** Two teams, each with one developer active in the target week and month. */
function seedTwoTeams(db: Database.Database): void {
    addDeveloper(db, 'dev-be', 'backend');
    addDeveloper(db, 'dev-fe', 'frontend');
    addSubscription(db, 'dev-be', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
    addSubscription(db, 'dev-fe', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
    // Inside the week 2026-06-01 … 06-07.
    addGitSnapshot(db, 'dev-be', '2026-06-02', {commits: 5, prs_merged: 2, code_churn_rate: 0.3});
    addGitSnapshot(db, 'dev-fe', '2026-06-03', {commits: 3, prs_merged: 1, code_churn_rate: 0.2});
    // Inside the month 2026-05.
    addGitSnapshot(db, 'dev-be', '2026-05-12', {commits: 4, prs_merged: 1, code_churn_rate: 0.25});
    addGitSnapshot(db, 'dev-fe', '2026-05-20', {commits: 2, prs_merged: 1, code_churn_rate: 0.15});
}

describe('schedule wiring', () => {
    it('auto-generates exactly weekly + monthly (quarterly/yearly excluded)', () => {
        expect(SUMMARY_AUTO_LEVELS).toEqual(['weekly', 'monthly']);
        // Quarterly and yearly are on-demand only — they never appear in the auto set.
        expect(SUMMARY_AUTO_LEVELS).not.toContain('quarterly');
        expect(SUMMARY_AUTO_LEVELS).not.toContain('yearly');
    });

    it('uses cron expressions just after the matching aggregation job (UTC)', () => {
        expect(SUMMARY_CRON).toEqual({
            weekly: '15 4 * * 1', // Monday 04:15 (weekly aggregation is 04:00)
            monthly: '45 4 1 * *', // 1st 04:45 (monthly aggregation is 04:30)
        });
        // No cron entry exists for the on-demand levels.
        expect(Object.keys(SUMMARY_CRON).sort()).toEqual(['monthly', 'weekly']);
    });
});

describe('config gating', () => {
    it('enabled by default (opt-out), and respects the master + per-level switches', () => {
        expect(isAutoGenerationEnabled(undefined, 'weekly')).toBe(true);
        expect(isAutoGenerationEnabled({}, 'monthly')).toBe(true);
        // Master switch off → nothing auto-generates.
        expect(isAutoGenerationEnabled({enabled: false}, 'weekly')).toBe(false);
        // Per-level switch off → only that level is suppressed.
        expect(isAutoGenerationEnabled({weekly: {auto_generate: false}}, 'weekly')).toBe(false);
        expect(isAutoGenerationEnabled({weekly: {auto_generate: false}}, 'monthly')).toBe(true);
    });

    it('enabledAutoLevels filters to the enabled levels in order', () => {
        expect(enabledAutoLevels(undefined)).toEqual(['weekly', 'monthly']);
        expect(enabledAutoLevels({enabled: false})).toEqual([]);
        expect(enabledAutoLevels({monthly: {auto_generate: false}})).toEqual(['weekly']);
    });
});

describe('enumerateScopes', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
    });
    afterEach(() => db.close());

    it('covers the org plus every team in registry name order', () => {
        seedTwoTeams(db);
        expect(enumerateScopes(db)).toEqual([
            {type: 'org', name: 'org'},
            {type: 'team', name: 'backend'},
            {type: 'team', name: 'frontend'},
        ]);
    });

    it('is just the org when no teams exist', () => {
        expect(enumerateScopes(db)).toEqual([{type: 'org', name: 'org'}]);
    });
});

describe('aggregateCompleted', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        seedTwoTeams(db);
    });
    afterEach(() => db.close());

    it('is false before aggregation runs, true after', () => {
        expect(aggregateCompleted(db, 'weekly', WEEKLY_AGG_KEY)).toBe(false);
        expect(aggregateCompleted(db, 'monthly', MONTHLY_KEY)).toBe(false);

        runAggregationForPeriod(db, 'weekly', WEEKLY_AGG_KEY, WEEKLY_NOW);
        runAggregationForPeriod(db, 'monthly', MONTHLY_KEY, MONTHLY_NOW);

        expect(aggregateCompleted(db, 'weekly', WEEKLY_AGG_KEY)).toBe(true);
        expect(aggregateCompleted(db, 'monthly', MONTHLY_KEY)).toBe(true);
    });
});

describe('runSummaryAutoGenerationJob — weekly auto path', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        seedTwoTeams(db);
        runAggregationForPeriod(db, 'weekly', WEEKLY_AGG_KEY, WEEKLY_NOW);
    });
    afterEach(() => db.close());

    it('generates a weekly summary for the org and every team after aggregation', async () => {
        const logger = recordingLogger();
        const result = await runSummaryAutoGenerationJob(db, {}, 'weekly', {
            now: () => WEEKLY_NOW,
            logger,
            generate: realGenerateWith(),
        });

        expect(result.aggregateMissing).toBe(false);
        expect(result.period).toBe(WEEKLY_LABEL);
        expect(result.outcomes.map((o) => o.status)).toEqual(['generated', 'generated', 'generated']);

        // Each scope's summary really landed, labelled with the ISO week.
        for (const scope of enumerateScopes(db)) {
            const stored = getSummaryByTarget(db, {level: 'weekly', period: WEEKLY_LABEL, scope});
            expect(stored, `${scope.type}:${scope.name}`).not.toBeNull();
            expect(stored!.period_type).toBe('weekly');
            expect(stored!.period_value).toBe(WEEKLY_LABEL);
        }
        expect(logger.completes).toEqual([{level: 'weekly', generated: 3, failed: 0}]);
        expect(logger.missing).toEqual([]);
    });
});

describe('runSummaryAutoGenerationJob — monthly auto path', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        seedTwoTeams(db);
        runAggregationForPeriod(db, 'monthly', MONTHLY_KEY, MONTHLY_NOW);
    });
    afterEach(() => db.close());

    it('generates a monthly summary for the org and every team after aggregation', async () => {
        const result = await runSummaryAutoGenerationJob(db, {}, 'monthly', {
            now: () => MONTHLY_NOW,
            generate: realGenerateWith(),
        });

        expect(result.aggregateMissing).toBe(false);
        expect(result.period).toBe(MONTHLY_KEY);
        expect(result.outcomes).toHaveLength(3);

        for (const scope of enumerateScopes(db)) {
            const stored = getSummaryByTarget(db, {level: 'monthly', period: MONTHLY_KEY, scope});
            expect(stored, `${scope.type}:${scope.name}`).not.toBeNull();
            expect(stored!.period_value).toBe(MONTHLY_KEY);
        }
    });
});

describe('runSummaryAutoGenerationJob — missing aggregate', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        // Snapshots exist, but aggregation was NOT run for the period.
        seedTwoTeams(db);
    });
    afterEach(() => db.close());

    it('skips generation, logs, and does not crash when the period has no aggregate rows', async () => {
        const logger = recordingLogger();
        let generateCalls = 0;
        const generate: GenerateSummaryFn = (...args) => {
            generateCalls += 1;
            return realGenerateWith()(...args);
        };

        const result = await runSummaryAutoGenerationJob(db, {}, 'weekly', {
            now: () => WEEKLY_NOW,
            logger,
            generate,
        });

        expect(result.aggregateMissing).toBe(true);
        expect(result.outcomes).toEqual([]);
        // Nothing was summarised from the missing data.
        expect(generateCalls).toBe(0);
        expect(getSummaryByTarget(db, {level: 'weekly', period: WEEKLY_LABEL, scope: {type: 'org', name: 'org'}})).toBeNull();
        // The skip was logged with the aggregate key that came up empty.
        expect(logger.missing).toEqual([
            {level: 'weekly', period: WEEKLY_LABEL, aggKey: WEEKLY_AGG_KEY},
        ]);
        expect(logger.completes).toEqual([{level: 'weekly', generated: 0, failed: 0}]);
    });
});

describe('runSummaryAutoGenerationJob — failure isolation', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        seedTwoTeams(db);
        runAggregationForPeriod(db, 'weekly', WEEKLY_AGG_KEY, WEEKLY_NOW);
    });
    afterEach(() => db.close());

    it("one scope's failure does not block the others (handled ok:false)", async () => {
        const logger = recordingLogger();
        const result = await runSummaryAutoGenerationJob(db, {}, 'weekly', {
            now: () => WEEKLY_NOW,
            logger,
            // The backend team fails; org and frontend must still generate.
            generate: realGenerateWith((scope) => scope.type === 'team' && scope.name === 'backend'),
        });

        const byScope = new Map(result.outcomes.map((o) => [`${o.scope.type}:${o.scope.name}`, o.status]));
        expect(byScope.get('org:org')).toBe('generated');
        expect(byScope.get('team:backend')).toBe('failed');
        expect(byScope.get('team:frontend')).toBe('generated');

        // The two healthy scopes really persisted; the failed one did not.
        expect(getSummaryByTarget(db, {level: 'weekly', period: WEEKLY_LABEL, scope: {type: 'org', name: 'org'}})).not.toBeNull();
        expect(getSummaryByTarget(db, {level: 'weekly', period: WEEKLY_LABEL, scope: {type: 'team', name: 'frontend'}})).not.toBeNull();
        expect(getSummaryByTarget(db, {level: 'weekly', period: WEEKLY_LABEL, scope: {type: 'team', name: 'backend'}})).toBeNull();

        expect(logger.completes).toEqual([{level: 'weekly', generated: 2, failed: 1}]);
        expect(logger.failed.map((f) => f.scope.name)).toEqual(['backend']);
    });

    it('an unexpected throw in one scope is caught and the run continues', async () => {
        const result = await runSummaryAutoGenerationJob(db, {}, 'weekly', {
            now: () => WEEKLY_NOW,
            generate: (dbArg, summaries, target, opts) => {
                if (target.scope.type === 'org') {
                    throw new Error('boom');
                }
                return realGenerateWith()(dbArg, summaries, target, opts);
            },
        });

        const byScope = new Map(result.outcomes.map((o) => [`${o.scope.type}:${o.scope.name}`, o.status]));
        expect(byScope.get('org:org')).toBe('failed');
        expect(byScope.get('team:backend')).toBe('generated');
        expect(byScope.get('team:frontend')).toBe('generated');
    });
});

describe('runScheduledSummaryJob — the production cron-fire path', () => {
    let dbPath: string;

    beforeEach(() => {
        dbPath = path.join(os.tmpdir(), `govproxy-sum-sched-${randomUUID()}.db`);
        const seed = openDb(dbPath);
        try {
            runMigrations(seed, MIGRATIONS_DIR);
            seedTwoTeams(seed);
            runAggregationForPeriod(seed, 'weekly', WEEKLY_AGG_KEY, WEEKLY_NOW);
        } finally {
            seed.close();
        }
    });

    afterEach(() => {
        for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${dbPath}${suffix}`, {force: true});
        }
    });

    it('opens, migrates, generates for the just-completed period, and closes', async () => {
        const result = await runScheduledSummaryJob(dbPath, {}, 'weekly', {
            now: () => WEEKLY_NOW,
            migrationsDir: MIGRATIONS_DIR,
            generate: realGenerateWith(),
        });

        expect(result).not.toBeNull();
        expect(result!.aggregateMissing).toBe(false);
        expect(result!.outcomes).toHaveLength(3);

        // The handle was released (we can reopen it) and a summary really landed.
        const check = openDb(dbPath);
        try {
            const stored = getSummaryByTarget(check, {
                level: 'weekly',
                period: WEEKLY_LABEL,
                scope: {type: 'org', name: 'org'},
            });
            expect(stored).not.toBeNull();
        } finally {
            check.close();
        }
    });

    it('returns null and logs when the DB cannot be opened, without throwing', async () => {
        const logger = recordingLogger();
        // A directory path cannot be opened as a SQLite file → openDb throws.
        const result = await runScheduledSummaryJob(os.tmpdir(), {}, 'monthly', {
            now: () => MONTHLY_NOW,
            migrationsDir: MIGRATIONS_DIR,
            logger,
        });

        expect(result).toBeNull();
        expect(logger.failed).toHaveLength(1);
    });
});
