/**
 * Summary auto-generation scheduling (Task 3.10 / #79).
 *
 * Auto-generates weekly and monthly summaries on schedule so a manager opens the
 * dashboard to a narrative that is already waiting. There are exactly two scheduled
 * jobs, each firing just after the corresponding aggregation job has run (design
 * §7.1), and each generating the period that just completed for every scope (the
 * org plus every team in the registry):
 *
 *   Weekly:  Monday 04:15 UTC — after weekly aggregation at 04:00
 *   Monthly: 1st    04:45 UTC — after monthly aggregation at 04:30
 *
 * Quarterly and yearly are deliberately NOT scheduled. They are on-demand only — a
 * manager generates them via the CLI/API when needed and typically reviews/tweaks
 * before sharing upward (design §7.1, resolved decision 1). The auto level set is a
 * closed two-element list (`SUMMARY_AUTO_LEVELS`); the other two never appear here.
 *
 * Three properties the acceptance criteria hinge on, and how they hold:
 *
 *   - Don't summarise from missing data. Each fire first checks that the period's
 *     aggregation actually produced rows (aggregateCompleted). If the aggregation
 *     job didn't run or wrote nothing — a missed/failed upstream fire — the whole
 *     summary job is skipped and logged rather than narrating a half-built period.
 *
 *   - Per-scope failure isolation. Each scope's generation runs inside its own
 *     try/catch; a scope that fails (model down, a bad team, an unexpected throw)
 *     is logged and recorded as failed, and the loop moves on — one team's failure
 *     never blocks the org or the other teams.
 *
 *   - Model config is honoured. Generation funnels through generateSummary, which
 *     resolves the configured model (default local) per level, so auto-generation
 *     uses exactly the model an on-demand run would.
 */

import cron from 'node-cron';
import path from 'path';
import type Database from 'better-sqlite3';
import type {SummariesConfig} from '../config/types';
import {openDb} from '../storage/db';
import {runMigrations} from '../storage/migrator';
import {isoWeekLabel} from '../aggregation/dates';
import {listTeams} from '../aggregation/team-period';
import {justCompletedPeriod, type AggregationPeriod} from '../aggregation/scheduler';
import {generateSummary} from './generator';
import type {SummaryScope} from './input-builder';
import type {SummaryTarget} from './target';

/**
 * The levels that auto-generate on schedule. Quarterly/yearly are excluded by design,
 * so this is the weekly/monthly subset of the aggregation engine's period set —
 * derived from it (rather than re-spelled) so the two can't drift if a level is renamed.
 */
export type SummaryAutoLevel = Extract<AggregationPeriod, 'weekly' | 'monthly'>;

/** The two auto-generated levels, in coarsening order — the iteration order for a full run. */
export const SUMMARY_AUTO_LEVELS: readonly SummaryAutoLevel[] = ['weekly', 'monthly'] as const;

/**
 * Cron expressions (UTC) for each auto level, sitting just after the matching
 * aggregation job (weekly 04:00, monthly 04:30 — see aggregation/scheduler.ts) so
 * the aggregate rows the gate checks for are already written. Minute, hour,
 * day-of-month, month, day-of-week.
 *
 * The 15-minute margin is the only slack between aggregation finishing and this
 * fire. It is deliberately a hard dependency, not a soft one: if the upstream
 * aggregation runs long or fails, the gate (aggregateCompleted) finds no rows and
 * the period is skipped+logged rather than narrated from missing data — and because
 * the next fire targets the *next* just-completed period, a skipped period is not
 * auto-retried. That is the intended "don't summarise from missing data" behaviour;
 * recovering a skipped period is an on-demand `generate` (CLI/API), by design.
 */
export const SUMMARY_CRON: Record<SummaryAutoLevel, string> = {
    weekly: '15 4 * * 1', // Monday 04:15
    monthly: '45 4 1 * *', // 1st of the month 04:45
};

/**
 * Whether auto-generation is enabled for `level`. Opt-out, not opt-in: the whole
 * point of the scheduler is summaries waiting on schedule, so generation runs
 * unless explicitly disabled — `summaries.enabled === false` turns everything off,
 * and a per-level `auto_generate === false` turns off just that level.
 */
export function isAutoGenerationEnabled(
    summaries: SummariesConfig | undefined,
    level: SummaryAutoLevel,
): boolean {
    if (summaries?.enabled === false) return false;
    if (summaries?.[level]?.auto_generate === false) return false;
    return true;
}

/**
 * The scopes a full run covers: the whole org, then every team in the registry, in
 * the registry's name order. Mirrors the input-source fold (org = all teams' members
 * pooled, each team on its own), so what auto-generates matches what an on-demand
 * `generate` for the same scope would produce.
 */
export function enumerateScopes(db: Database.Database): SummaryScope[] {
    const teams = listTeams(db).map((name): SummaryScope => ({type: 'team', name}));
    return [{type: 'org', name: 'org'}, ...teams];
}

/**
 * The summary period label for `level`'s just-completed period — the canonical key
 * the summary target/store use. Kept distinct from the aggregate-table key
 * (`justCompletedPeriod`) on purpose: the aggregate table keys weeks by their Monday
 * `week_start` (YYYY-MM-DD), but the summary layer keys weeks by the ISO week label
 * (`YYYY-Wnn`), so weekly is converted here. Monthly is `YYYY-MM` in both, so it
 * passes straight through. Conflating the two would either miss the aggregate rows or
 * mislabel the summary.
 */
function summaryPeriodLabel(level: SummaryAutoLevel, now: Date): string {
    const aggKey = justCompletedPeriod(level, now);
    return level === 'weekly' ? isoWeekLabel(aggKey) : aggKey;
}

/**
 * Whether the period's aggregation actually produced rows — the "don't summarise
 * from missing data" gate. Weekly checks weekly_aggregates for the week_start,
 * monthly checks monthly_aggregates for the month. Zero rows means the upstream
 * aggregation job didn't run or wrote nothing, so the summary job is skipped.
 *
 * Note this is a *proxy*: the summary input is folded directly from the immutable
 * daily snapshots (see input-source.ts), not from these aggregate rows. Aggregate
 * presence stands in for "the period's daily pipeline ran", which is sound for the
 * scheduled case — the period closed days ago, well inside any daily retention
 * window, and aggregation reads the same snapshots generation will. The one way the
 * two could diverge is daily snapshots being pruned while aggregate rows persist; at
 * the launch retention horizon a just-closed period is never that old, so the proxy
 * holds. A deployment with aggressive retention should gate (or additionally check)
 * on snapshot presence instead.
 */
export function aggregateCompleted(
    db: Database.Database,
    level: SummaryAutoLevel,
    aggKey: string,
): boolean {
    const row =
        level === 'weekly'
            ? db
                  .prepare('SELECT 1 FROM weekly_aggregates WHERE week_start = ? LIMIT 1')
                  .get(aggKey)
            : db.prepare('SELECT 1 FROM monthly_aggregates WHERE month = ? LIMIT 1').get(aggKey);
    return Boolean(row);
}

/** The status of one scope's generation within an auto-generation run. */
export type ScopeStatus = 'generated' | 'failed';

/** What happened for one scope in a run — the per-scope record the result carries. */
export interface ScopeOutcome {
    scope: SummaryScope;
    status: ScopeStatus;
    /** Failure message when `status` is 'failed'; absent on success. */
    detail?: string;
}

/** The outcome of one auto-generation job fire across all scopes for one level. */
export interface SummaryAutoJobResult {
    level: SummaryAutoLevel;
    /** Summary period label (YYYY-Wnn / YYYY-MM) the run targeted. */
    period: string;
    /**
     * True when the run was skipped because the period's aggregation hadn't produced
     * rows — no scopes were attempted, `outcomes` is empty.
     */
    aggregateMissing: boolean;
    /** Per-scope results, in scope-enumeration order; empty when aggregateMissing. */
    outcomes: ScopeOutcome[];
}

/**
 * Lifecycle logging for an auto-generation run — start, the missing-aggregate skip,
 * each scope's success/failure, and completion. Injectable so tests can assert what
 * was logged and the server can route it through its own logger; the default writes
 * structured lines to the console.
 */
export interface SummaryAutoLogger {
    jobStart(level: SummaryAutoLevel, period: string, scopeCount: number): void;
    aggregateMissing(level: SummaryAutoLevel, period: string, aggKey: string): void;
    /**
     * One scope finished — generated or failed, carried in the {@link ScopeOutcome}.
     * A single per-scope channel (rather than separate generated/failed methods) since
     * the outcome already discriminates the two and is the shape the result returns.
     */
    scopeFinished(level: SummaryAutoLevel, period: string, outcome: ScopeOutcome): void;
    /**
     * A whole-job infrastructure failure — the run never reached any scope (DB
     * couldn't be opened, migrations threw). Distinct from a scope outcome so a job
     * that never started isn't misread as one scope's generation failing.
     */
    jobFailure(level: SummaryAutoLevel, period: string, error: string): void;
    jobComplete(
        level: SummaryAutoLevel,
        period: string,
        generated: number,
        failed: number,
    ): void;
}

/** A readable scope label for logs (`org` or `team:<name>`). */
function scopeLabel(scope: SummaryScope): string {
    return scope.type === 'org' ? 'org' : `team:${scope.name}`;
}

export const consoleSummaryAutoLogger: SummaryAutoLogger = {
    jobStart(level, period, scopeCount) {
        console.log(
            `[summary:${level}] start — period ${period}, ${scopeCount} scope(s) (${new Date().toISOString()})`,
        );
    },
    aggregateMissing(level, period, aggKey) {
        console.warn(
            `[summary:${level}] skip — no aggregate rows for ${aggKey}; aggregation did not complete, not summarising ${period}`,
        );
    },
    scopeFinished(level, period, outcome) {
        if (outcome.status === 'generated') {
            console.log(`[summary:${level}] done — ${period} ${scopeLabel(outcome.scope)}`);
        } else {
            console.error(
                `[summary:${level}] FAILED — ${period} ${scopeLabel(outcome.scope)}: ${outcome.detail}`,
            );
        }
    },
    jobFailure(level, period, error) {
        console.error(`[summary:${level}] JOB FAILED — period ${period}: ${error}`);
    },
    jobComplete(level, period, generated, failed) {
        console.log(
            `[summary:${level}] complete — period ${period}: ${generated} generated, ${failed} failed`,
        );
    },
};

/** Injectable generate function (tests drive the success/failure branches). */
export type GenerateSummaryFn = typeof generateSummary;

export interface SummaryAutoJobOptions {
    /** Lifecycle logger; defaults to the console logger. */
    logger?: SummaryAutoLogger;
    /** Injectable clock for resolving the just-completed period; defaults to wall clock. */
    now?: () => Date;
    /** Injectable generator (tests drive branches without a live model); defaults to the real one. */
    generate?: GenerateSummaryFn;
}

/**
 * Run one level's auto-generation against an open DB: resolve the just-completed
 * period, gate on aggregation completion, then generate the summary for every scope
 * with per-scope isolation. Never throws — every scope failure is caught, logged,
 * and recorded so one bad scope can't stop the others or escape into node-cron.
 *
 * Async because generation calls the model; the caller awaits it.
 */
export async function runSummaryAutoGenerationJob(
    db: Database.Database,
    summaries: SummariesConfig | undefined,
    level: SummaryAutoLevel,
    options: SummaryAutoJobOptions = {},
): Promise<SummaryAutoJobResult> {
    const logger = options.logger ?? consoleSummaryAutoLogger;
    const now = (options.now ?? ((): Date => new Date()))();
    const generate = options.generate ?? generateSummary;

    const aggKey = justCompletedPeriod(level, now);
    const period = summaryPeriodLabel(level, now);
    const scopes = enumerateScopes(db);

    logger.jobStart(level, period, scopes.length);

    // Gate: don't narrate a period whose aggregation never produced rows.
    if (!aggregateCompleted(db, level, aggKey)) {
        logger.aggregateMissing(level, period, aggKey);
        logger.jobComplete(level, period, 0, 0);
        return {level, period, aggregateMissing: true, outcomes: []};
    }

    const outcomes: ScopeOutcome[] = [];
    let generated = 0;
    let failed = 0;

    for (const scope of scopes) {
        const target: SummaryTarget = {level, period, scope};
        let outcome: ScopeOutcome;
        try {
            const result = await generate(db, summaries, target, {now: () => now});
            outcome = result.ok
                ? {scope, status: 'generated'}
                : // generateSummary signals a handled failure (model down, no
                  // developers, rejected output) without throwing — isolate it the
                  // same as a throw so the remaining scopes still run.
                  {scope, status: 'failed', detail: result.error};
        } catch (err) {
            // Defensive: generateSummary is designed not to throw, but an unexpected
            // error (a DB fault mid-loop) must still not blow up the whole run.
            outcome = {scope, status: 'failed', detail: err instanceof Error ? err.message : String(err)};
        }
        if (outcome.status === 'generated') generated += 1;
        else failed += 1;
        outcomes.push(outcome);
        logger.scopeFinished(level, period, outcome);
    }

    logger.jobComplete(level, period, generated, failed);
    return {level, period, aggregateMissing: false, outcomes};
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../storage/migrations');

export interface SummarySchedulerOptions extends SummaryAutoJobOptions {
    /** Migrations directory applied on each fire; defaults to src/storage/migrations. */
    migrationsDir?: string;
}

/**
 * Run one auto level end-to-end against `dbPath`: open a short-lived DB handle,
 * apply migrations, run the isolated job, and close. This is the exact body each
 * cron fire executes, factored out so the production lifecycle — including the
 * failure branches and the guaranteed close — is directly testable without waiting
 * on the wall clock.
 *
 * Never throws. Returns the job's result, or `null` if the DB could not be opened or
 * migrations failed (the failure is logged either way). Isolation means one level's
 * bad fire never escapes into node-cron or touches the other level's task.
 */
export async function runScheduledSummaryJob(
    dbPath: string,
    summaries: SummariesConfig | undefined,
    level: SummaryAutoLevel,
    options: SummarySchedulerOptions = {},
): Promise<SummaryAutoJobResult | null> {
    const logger = options.logger ?? consoleSummaryAutoLogger;
    const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    const now = (options.now ?? ((): Date => new Date()))();

    let db: Database.Database;
    try {
        db = openDb(dbPath);
    } catch (err) {
        // Couldn't even open the DB — the run never reached any scope, so log it as a
        // whole-job failure (not a per-scope one) and bail; the other level's task is
        // untouched.
        const message = err instanceof Error ? err.message : String(err);
        logger.jobFailure(level, summaryPeriodLabel(level, now), message);
        return null;
    }
    try {
        runMigrations(db, migrationsDir);
        return await runSummaryAutoGenerationJob(db, summaries, level, {
            logger: options.logger,
            now: () => now,
            generate: options.generate,
        });
    } catch (err) {
        // Guards the migration step (the one call here that can throw) so a migration
        // error still logs rather than escaping into node-cron. Again a whole-job
        // failure: no scope was attempted.
        const message = err instanceof Error ? err.message : String(err);
        logger.jobFailure(level, summaryPeriodLabel(level, now), message);
        return null;
    } finally {
        db.close();
    }
}

/**
 * Register the auto-generation cron jobs (weekly + monthly) against `dbPath` and
 * return the node-cron tasks so the caller can stop them on shutdown. Only levels
 * enabled by config are registered — a disabled level (or summaries disabled wholesale)
 * gets no task at all. Each fire delegates to the self-isolating runScheduledSummaryJob,
 * so a transient failure on one level can never tear the scheduler down or affect the other.
 */
export function startSummaryScheduler(
    dbPath: string,
    summaries: SummariesConfig | undefined,
    options: SummarySchedulerOptions = {},
): Array<ReturnType<typeof cron.schedule>> {
    return SUMMARY_AUTO_LEVELS.filter((level) => isAutoGenerationEnabled(summaries, level)).map(
        (level) =>
            cron.schedule(
                SUMMARY_CRON[level],
                () => void runScheduledSummaryJob(dbPath, summaries, level, options),
                {timezone: 'UTC'},
            ),
    );
}
