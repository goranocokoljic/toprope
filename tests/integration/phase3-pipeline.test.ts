/**
 * Phase 3 close-out — integration testing + dogfood verification (Task 3.13 / #82).
 *
 * End-to-end verification of the aggregation + summaries pipeline against a
 * realistic GIT-ONLY dataset shaped like the WMG dogfood: three teams of varying
 * adoption, ~12 months of daily git history, live + idle subscriptions, and NO
 * tool-API connectors (the launch tier — every developer is MEDIUM/git-only). The
 * suite drives the real production code paths — the same rollup jobs, backfill,
 * summary generator, staleness check, and HTTP endpoints the server uses — with
 * only the LLM network call stubbed (a deterministic fake model), so the
 * tier-aware discipline and the pre-computed-read performance are exercised for
 * real rather than mocked.
 *
 * Each `it` maps to one acceptance criterion of the issue:
 *   1. Full aggregation pipeline verified at all four levels with real data
 *   2. Backfill produces correct historical trend depth
 *   3. Weekly/monthly auto-generate; quarterly/yearly generate on demand
 *   4. Generated summaries contain NO fabricated direct-usage language
 *   5. Maturity scores labelled "git-based estimate" everywhere they appear
 *   6. Staleness flagging works end to end
 *   7. Long-range dashboard views are fast (pre-computed)
 *   8. Maturity calibration sanity-check (notes live in docs/MATURITY_CALIBRATION.md)
 *
 * The fixed clock (NOW, a Monday) anchors the "just-completed" weekly/monthly
 * periods the auto-generation jobs target; the seeded dates are absolute so the
 * period keys are exact and the assertions check concrete values.
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {performance} from 'node:perf_hooks';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    makeIntegrationDb,
    createAccount,
    login,
    authHeaders,
    seedTeam,
    seedGitSnapshot,
    seedSubscription,
} from './harness';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerAggregateRoutes} from '../../src/dashboard/api/aggregates';
import {registerMaturityRoutes} from '../../src/dashboard/api/maturity';
import {registerSummaryRoutes} from '../../src/dashboard/api/summaries';
import {runBackfill} from '../../src/aggregation/backfill';
import {runAggregationForPeriod} from '../../src/aggregation/scheduler';
import {
    runSummaryAutoGenerationJob,
    SUMMARY_AUTO_LEVELS,
    type SummaryAutoLogger,
} from '../../src/summaries/scheduler';
import {generateSummary} from '../../src/summaries/generator';
import {buildSummaryInputForTarget} from '../../src/summaries/input-source';
import {buildSummaryPrompt, findFabricatedUsageLanguage} from '../../src/summaries/prompts';
import {isoWeekLabel} from '../../src/aggregation/dates';
import type {SummaryModelClient} from '../../src/summaries/model-client';

// ── fixed clock + period anchors ──────────────────────────────────────────────
// 2026-06-15 is a Monday, so the just-completed week is 2026-06-08 and the
// just-completed month is 2026-05 — both produced by the trailing-12-month
// backfill below, which is what lets the auto-generation gate find aggregate rows.
const NOW = new Date('2026-06-15T05:00:00.000Z');
const BACKFILL_FROM = '2025-06-15';
const BACKFILL_TO = '2026-06-15';
const JUST_COMPLETED_WEEK = '2026-06-08'; // week_start (Monday)
const JUST_COMPLETED_WEEK_LABEL = isoWeekLabel(JUST_COMPLETED_WEEK);
const JUST_COMPLETED_MONTH = '2026-05';
const QUARTER = '2026-Q2';
const YEAR = '2026';

/** The twelve months the backfill spans, oldest first (YYYY-MM). */
const MONTHS: string[] = ((): string[] => {
    const out: string[] = [];
    for (let y = 2025, m = 7; out.length < 12; m++) {
        if (m > 12) {
            m = 1;
            y++;
        }
        out.push(`${y}-${String(m).padStart(2, '0')}`);
    }
    return out;
})();

// ── tier-differentiated, git-only teams ───────────────────────────────────────
// backend = strong adopters (full activity, low churn, steady PRs); frontend =
// moderate; platform = weak (one active dev + one idle seat, high churn). The
// gradient is deliberate so the maturity score's ordering is checkable and the
// calibration sanity-check has something real to assert.
interface DevSpec {
    id: string;
    team: string;
    commits: number;
    prsMerged: number;
    linesAdded: number;
    churn: number;
    aiScore: number;
    /** Idle developer: holds a seat but produces no git activity (an unused seat). */
    idle?: boolean;
}

const DEVELOPERS: DevSpec[] = [
    {id: 'cara', team: 'backend', commits: 8, prsMerged: 3, linesAdded: 320, churn: 0.15, aiScore: 0.72},
    {id: 'dan', team: 'backend', commits: 7, prsMerged: 3, linesAdded: 290, churn: 0.18, aiScore: 0.68},
    {id: 'amy', team: 'frontend', commits: 4, prsMerged: 1, linesAdded: 160, churn: 0.32, aiScore: 0.5},
    {id: 'ben', team: 'frontend', commits: 3, prsMerged: 1, linesAdded: 140, churn: 0.35, aiScore: 0.46},
    {id: 'eve', team: 'platform', commits: 1, prsMerged: 0, linesAdded: 60, churn: 0.52, aiScore: 0.28},
    {id: 'frank', team: 'platform', commits: 0, prsMerged: 0, linesAdded: 0, churn: 0, aiScore: 0, idle: true},
];

/**
 * Days within a month to seed git activity on. The 8th anchors the just-completed
 * week (2026-06-08); a second mid-month day gives churn/signature means more than
 * one sample. June 2026 stops at the 10th so nothing is seeded past NOW.
 */
function activeDaysFor(month: string): string[] {
    if (month === '2026-06') {
        return ['2026-06-08', '2026-06-10'];
    }
    return [`${month}-08`, `${month}-22`];
}

/**
 * Seed the full git-only dataset: three teams, six developers (one idle), a live
 * seat each plus the idle seat, and ~12 months of git snapshots. A gentle upward
 * drift over the months (extra commits/PRs late in the window) gives the deltas
 * real movement to report. No tool_snapshots are seeded at all — this is the
 * git-only launch tier, the exact condition the tier-awareness checks rely on.
 */
function seedGitOnlyOrg(db: Database.Database): void {
    seedTeam(db, 'backend', 'manager@wmg.test');
    seedTeam(db, 'frontend', 'manager@wmg.test');
    seedTeam(db, 'platform', 'manager@wmg.test');

    // Register developers BEFORE the backfill window opens. Team membership for a
    // period is gated on created_at <= period end (team-period.ts), so a developer
    // registered after the window — the harness default of 2026-05-30 — would only
    // count toward the final quarter and flatten the trend. An early registration
    // date is what gives the maturity line its full 12-month depth.
    const REGISTERED_AT = '2025-01-01T00:00:00.000Z';
    for (const dev of DEVELOPERS) {
        db.prepare(
            'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
        ).run(dev.id, dev.id, `${dev.id}@wmg.test`, dev.team, REGISTERED_AT);
        // Every developer holds a seat; frank's is the unused one (no git activity).
        seedSubscription(db, {id: `sub-${dev.id}`, developer: dev.id, tool: 'copilot', cost: 19});
    }

    const insert = db.transaction(() => {
        for (const [monthIndex, month] of MONTHS.entries()) {
            // Late-window drift: +1 commit/+1 PR in the final third of the year.
            const drift = monthIndex >= 8 ? 1 : 0;
            for (const dev of DEVELOPERS) {
                if (dev.idle) {
                    continue;
                }
                for (const date of activeDaysFor(month)) {
                    seedGitSnapshot(db, {
                        developer: dev.id,
                        date,
                        provider: 'bitbucket',
                        commits: dev.commits + drift,
                        linesAdded: dev.linesAdded,
                        linesRemoved: Math.round(dev.linesAdded * 0.3),
                        prsOpened: dev.prsMerged + 1,
                        prsMerged: dev.prsMerged + drift,
                        churn: dev.churn,
                        aiScore: dev.aiScore,
                    });
                }
            }
        }
    });
    insert();
}

// ── fake model (only the LLM network hop is stubbed) ──────────────────────────
/**
 * A deterministic, guard-safe narrative: describes only git-derived signals and
 * states the git basis, so it passes findFabricatedUsageLanguage. Stands in for
 * the local Ollama model the dogfood runs, keeping the suite hermetic.
 */
const CLEAN_NARRATIVE =
    'Based on git activity — direct tool usage is not yet connected — commit throughput held steady ' +
    'this period with healthy merged-PR volume and clean code churn. The estimated AI-assistance signal ' +
    'was stable. These figures are a git-based estimate.';

/** A narrative that fabricates direct-usage metrics the git-only data cannot support. */
const FABRICATED_NARRATIVE =
    'The team posted an acceptance rate of 82% across thousands of interactions, with most suggestions accepted.';

function fakeClient(text: string = CLEAN_NARRATIVE): SummaryModelClient {
    return {
        modelName: 'fake-local-model',
        generate: async () => ({ok: true, text, model: 'fake-local-model'}),
    } as unknown as SummaryModelClient;
}

/** Build the Phase 3 API surface (auth + me + aggregates + maturity + summaries). */
async function buildPhase3App(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    app.get('/health', async () => ({status: 'ok'}));
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerAggregateRoutes(app, db);
    registerMaturityRoutes(app, db);
    registerSummaryRoutes(app, db, undefined, {createClient: () => fakeClient()});
    await app.ready();
    return app;
}

describe('Integration (3.13): Phase 3 aggregation + summaries pipeline, git-only', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let admin: Record<string, string>;
    let developer: Record<string, string>;

    beforeAll(async () => {
        db = makeIntegrationDb();
        seedGitOnlyOrg(db);

        // ── run the real pipeline once: backfill 12 months at all four levels ──
        runBackfill(db, {from: BACKFILL_FROM, to: BACKFILL_TO, now: NOW});

        await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
        await createAccount(db, {email: 'cara@wmg.test', role: 'developer', developerId: 'cara'});
        app = await buildPhase3App(db);
        admin = authHeaders(await login(app, 'manager@wmg.test'));
        developer = authHeaders(await login(app, 'cara@wmg.test'));
    }, 60_000);

    afterAll(async () => {
        await app.close();
        db.close();
    });

    // Re-usable count helper.
    function count(sql: string): number {
        return (db.prepare(sql).get() as {n: number}).n;
    }

    // ── 1. Full aggregation pipeline at all four levels ───────────────────────
    describe('aggregation pipeline (all four levels)', () => {
        it('produced per-developer weekly + monthly and per-team quarterly + yearly rows', () => {
            // Backfill writes exactly one weekly/monthly row per developer per period
            // and one quarterly/yearly per team per period. Assert that one-row-per
            // invariant against the distinct period counts rather than hardcoding the
            // window span, and that the monthly depth covers the full ~12 months.
            const devs = DEVELOPERS.length; // 6
            const teams = 3;
            const months = count('SELECT COUNT(DISTINCT month) AS n FROM monthly_aggregates');
            const years = count('SELECT COUNT(DISTINCT year) AS n FROM yearly_aggregates');

            expect(months).toBeGreaterThanOrEqual(12);
            expect(count('SELECT COUNT(*) AS n FROM weekly_aggregates')).toBeGreaterThan(0);
            expect(count('SELECT COUNT(*) AS n FROM monthly_aggregates')).toBe(months * devs);
            expect(count('SELECT COUNT(*) AS n FROM quarterly_aggregates')).toBeGreaterThan(0);
            expect(count('SELECT COUNT(*) AS n FROM yearly_aggregates')).toBe(years * teams);
        });

        it('sums git metrics correctly for a known developer-month', () => {
            // cara, 2026-05: 2 active days (08, 22) × (commits 8 + drift 1) = 18 commits,
            // and (prsMerged 3 + drift 1) × 2 = 8 PRs. 2026-05 is monthIndex 10 ≥ 8 → drift.
            const row = db
                .prepare(
                    'SELECT total_commits, total_prs_merged, data_quality FROM monthly_aggregates WHERE developer_id = ? AND month = ?',
                )
                .get('cara', '2026-05') as {
                total_commits: number;
                total_prs_merged: number;
                data_quality: string;
            };
            expect(row.total_commits).toBe(18);
            expect(row.total_prs_merged).toBe(8);
            // Git-only launch tier: every developer-period is MEDIUM confidence.
            expect(row.data_quality).toBe('medium');
        });

        it('computes deltas: the first backfilled month is null, later months compare to prior', () => {
            // The backfill range opens before the first seeded month, so the genuine
            // first stored month is the MIN(month) — it has no prior row → null delta.
            const firstMonth = (
                db.prepare('SELECT MIN(month) AS m FROM monthly_aggregates WHERE developer_id = ?').get('cara') as {
                    m: string;
                }
            ).m;
            const first = db
                .prepare('SELECT commit_velocity_delta_pct FROM monthly_aggregates WHERE developer_id = ? AND month = ?')
                .get('cara', firstMonth) as {commit_velocity_delta_pct: number | null};
            expect(first.commit_velocity_delta_pct).toBeNull();

            // The first seeded month (2025-07) has a stored prior month → a real,
            // positive delta. Proof deltas move rather than defaulting to 0.
            const later = db
                .prepare('SELECT commit_velocity_delta_pct FROM monthly_aggregates WHERE developer_id = ? AND month = ?')
                .get('cara', MONTHS[0]) as {commit_velocity_delta_pct: number | null};
            expect(later.commit_velocity_delta_pct).not.toBeNull();
            expect(later.commit_velocity_delta_pct as number).toBeGreaterThan(0);
        });

        it('serves aggregate rows through the API with tools_used parsed', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/aggregates/team:backend/monthly?period=${JUST_COMPLETED_MONTH}`,
                headers: admin,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.data.rows).toHaveLength(2); // cara + dan
            expect(Array.isArray(body.data.rows[0].tools_used)).toBe(true);
        });
    });

    // ── 2. Backfill produces historical trend depth ───────────────────────────
    describe('backfill trend depth', () => {
        it('produced a maturity score for every quarter across the window via the trend API', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/backend/trend?range=lifetime',
                headers: admin,
            });
            expect(res.statusCode).toBe(200);
            const points = res.json().data.points as Array<{period: string; score: number | null; basis: string}>;
            // Points are chronological across the whole window.
            const periods = points.map((p) => p.period);
            expect([...periods].sort()).toEqual(periods);
            // The seeded activity (2025-07 onward) yields a real score for at least
            // the four quarters it spans (2025-Q3, Q4, 2026-Q1, Q2) — the historical
            // trend depth the backfill exists to produce.
            const scored = points.filter((p) => typeof p.score === 'number');
            expect(scored.length).toBeGreaterThanOrEqual(4);
            expect(scored.map((p) => p.period)).toContain(QUARTER);
        });

        it('is idempotent: re-running the backfill does not duplicate rows', () => {
            const before = count('SELECT COUNT(*) AS n FROM monthly_aggregates');
            runBackfill(db, {from: BACKFILL_FROM, to: BACKFILL_TO, now: NOW});
            expect(count('SELECT COUNT(*) AS n FROM monthly_aggregates')).toBe(before);
        });
    });

    // ── 3. Weekly/monthly auto-generate; quarterly/yearly on demand ───────────
    describe('summary generation (auto + on-demand)', () => {
        /** Auto-gen wired to the REAL generator, with only the model call faked. */
        const autoGenerate: typeof generateSummary = (database, summaries, target, options) =>
            generateSummary(database, summaries, target, {...options, createClient: () => fakeClient()});

        it('auto-generates a weekly summary for the org + every team', async () => {
            const result = await runSummaryAutoGenerationJob(db, undefined, 'weekly', {
                now: () => NOW,
                generate: autoGenerate,
                logger: silentAutoLogger(),
            });
            expect(result.aggregateMissing).toBe(false);
            expect(result.outcomes).toHaveLength(4); // org + 3 teams
            expect(result.outcomes.every((o) => o.status === 'generated')).toBe(true);

            const res = await app.inject({method: 'GET', url: '/api/summaries?level=weekly', headers: admin});
            expect(res.statusCode).toBe(200);
            const items = res.json().data as Array<{period_value: string; scope_name: string}>;
            expect(items).toHaveLength(4);
            expect(items.every((i) => i.period_value === JUST_COMPLETED_WEEK_LABEL)).toBe(true);
            expect(items.map((i) => i.scope_name).sort()).toEqual(['backend', 'frontend', 'org', 'platform']);
        });

        it('auto-generates a monthly summary for the org + every team', async () => {
            const result = await runSummaryAutoGenerationJob(db, undefined, 'monthly', {
                now: () => NOW,
                generate: autoGenerate,
                logger: silentAutoLogger(),
            });
            expect(result.aggregateMissing).toBe(false);
            expect(result.outcomes.every((o) => o.status === 'generated')).toBe(true);

            const res = await app.inject({method: 'GET', url: '/api/summaries?level=monthly', headers: admin});
            const items = res.json().data as Array<{period_value: string}>;
            expect(items).toHaveLength(4);
            expect(items.every((i) => i.period_value === JUST_COMPLETED_MONTH)).toBe(true);
        });

        it('generates a quarterly summary on demand via the API', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: admin,
                payload: {level: 'quarterly', period: QUARTER, scope: 'team:backend'},
            });
            expect(res.statusCode).toBe(200);
            const data = res.json().data;
            expect(data.period_type).toBe('quarterly');
            expect(data.period_value).toBe(QUARTER);
            expect(data.summary_text).toBe(CLEAN_NARRATIVE);

            // Persisted: a follow-up read returns it.
            const read = await app.inject({
                method: 'GET',
                url: `/api/summaries/${encodeURIComponent(data.id)}`,
                headers: admin,
            });
            expect(read.statusCode).toBe(200);
        });

        it('generates a yearly org summary on demand via the API', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: admin,
                payload: {level: 'yearly', period: YEAR, scope: 'org'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.period_type).toBe('yearly');
        });

        it('does NOT auto-generate quarterly or yearly (on-demand only by design)', () => {
            // Quarterly/yearly only ever reached the store via the explicit on-demand
            // POSTs above; the auto-generation jobs never produced them. Pin that to
            // the PRODUCTION level set (not a local literal) so adding 'quarterly' to
            // the scheduler's auto levels would fail this test.
            expect([...SUMMARY_AUTO_LEVELS]).toEqual(['weekly', 'monthly']);
            expect(SUMMARY_AUTO_LEVELS).not.toContain('quarterly');
            expect(SUMMARY_AUTO_LEVELS).not.toContain('yearly');
        });
    });

    // ── 4. NO fabricated direct-usage language (tier-awareness) ───────────────
    describe('tier-awareness: no fabricated direct-usage language', () => {
        it('the real git-only payload is git_estimate and its prompt bans direct-usage terms', () => {
            const payload = buildSummaryInputForTarget(db, {
                level: 'monthly',
                period: JUST_COMPLETED_MONTH,
                scope: {type: 'team', name: 'backend'},
            });
            expect(payload.metrics.ai_maturity_basis).toBe('git_estimate');
            expect(payload.data_basis).toBe('git analysis + expense data; no direct tool usage');

            const prompt = buildSummaryPrompt(payload);
            expect(prompt).toContain('Direct tool-usage data is NOT connected');
            expect(prompt).toContain(payload.data_basis);
        });

        // The pure findFabricatedUsageLanguage clean-pass/fabricated-flag behaviour is
        // covered by the unit suite (tests/summaries/prompts.test.ts). Here we verify
        // the same guard END TO END against the real generated payload: the generator
        // rejects fabricated output below, and the stored-scan test confirms every
        // persisted narrative is clean.
        it('the generator REJECTS fabricated model output and stores nothing', async () => {
            const target = {level: 'quarterly' as const, period: QUARTER, scope: {type: 'team' as const, name: 'frontend'}};
            const before = count("SELECT COUNT(*) AS n FROM summaries WHERE scope_name = 'frontend' AND period_value = '2026-Q2'");
            const result = await generateSummary(db, undefined, target, {
                now: () => NOW,
                createClient: () => fakeClient(FABRICATED_NARRATIVE),
            });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toMatch(/fabricated/i);
                expect(result.retryable).toBe(true);
            }
            // No partial row written.
            const after = count("SELECT COUNT(*) AS n FROM summaries WHERE scope_name = 'frontend' AND period_value = '2026-Q2'");
            expect(after).toBe(before);
        });

        it('every stored summary text is clean of fabricated direct-usage language', () => {
            const rows = db.prepare('SELECT summary_text FROM summaries').all() as Array<{summary_text: string}>;
            expect(rows.length).toBeGreaterThan(0);
            // Re-scan each stored narrative against a git_estimate payload's term set.
            const payload = buildSummaryInputForTarget(db, {
                level: 'monthly',
                period: JUST_COMPLETED_MONTH,
                scope: {type: 'org', name: 'org'},
            });
            for (const {summary_text} of rows) {
                expect(findFabricatedUsageLanguage(summary_text, payload)).toEqual([]);
            }
        });
    });

    // ── 5. Maturity labelled "git-based estimate" everywhere ──────────────────
    describe('maturity basis labelling', () => {
        it('every quarterly + yearly aggregate row is git_estimate', () => {
            expect(count("SELECT COUNT(*) AS n FROM quarterly_aggregates WHERE ai_maturity_basis <> 'git_estimate' OR ai_maturity_basis IS NULL")).toBe(0);
            expect(count("SELECT COUNT(*) AS n FROM yearly_aggregates WHERE ai_maturity_basis <> 'git_estimate' OR ai_maturity_basis IS NULL")).toBe(0);
        });

        it('the maturity trend API labels every scored point git_estimate', async () => {
            const res = await app.inject({method: 'GET', url: '/api/maturity/org/trend?range=lifetime', headers: admin});
            expect(res.statusCode).toBe(200);
            // The org fold reports a null basis only for an empty (no-score) quarter;
            // every quarter that actually carries a score is labelled git_estimate.
            const points = res.json().data.points as Array<{score: number | null; basis: string | null}>;
            const scored = points.filter((p) => p.score !== null);
            expect(scored.length).toBeGreaterThan(0);
            expect(scored.every((p) => p.basis === 'git_estimate')).toBe(true);
        });

        it('every stored summary carries the git_estimate basis through the API', async () => {
            const res = await app.inject({method: 'GET', url: '/api/summaries', headers: admin});
            const items = res.json().data as Array<{basis: string; tier: string}>;
            expect(items.length).toBeGreaterThan(0);
            expect(items.every((i) => i.basis === 'git_estimate')).toBe(true);
            expect(items.every((i) => i.tier === 'medium')).toBe(true);
        });
    });

    // ── 6. Staleness flagging end to end ──────────────────────────────────────
    describe('staleness flagging', () => {
        // The id the first test generates, reused by the regenerate test below
        // (these two share the same summary by design) so neither hardcodes the
        // store's id-scheme string.
        let platformQuarterlyId: string;

        it('flags a dependent summary stale when its underlying aggregate changes', async () => {
            // Generate a fresh quarterly summary for platform Q2 (not stale).
            const gen = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: admin,
                payload: {level: 'quarterly', period: QUARTER, scope: 'team:platform'},
            });
            expect(gen.statusCode).toBe(200);
            const id = gen.json().data.id as string;
            platformQuarterlyId = id;
            expect(gen.json().data.is_stale).toBe(0);

            // Late-arriving git data lands inside Q2 for a platform developer, then
            // the quarter is recomputed — the same path a re-sync would take.
            seedGitSnapshot(db, {
                developer: 'eve',
                date: '2026-04-15',
                provider: 'gitlab',
                commits: 9,
                linesAdded: 400,
                prsMerged: 4,
                churn: 0.2,
                aiScore: 0.6,
            });
            runAggregationForPeriod(db, 'quarterly', QUARTER, NOW);

            // The dependent summary is now flagged stale, surfaced through the API.
            const read = await app.inject({
                method: 'GET',
                url: `/api/summaries/${encodeURIComponent(id)}`,
                headers: admin,
            });
            expect(read.statusCode).toBe(200);
            expect(read.json().data.is_stale).toBe(1);
        });

        it('regenerating a stale summary clears the flag', async () => {
            const id = platformQuarterlyId;
            const res = await app.inject({
                method: 'POST',
                url: `/api/summaries/${encodeURIComponent(id)}/regenerate`,
                headers: admin,
                payload: {},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.is_stale).toBe(0);
            expect(res.json().data.regenerated_count).toBeGreaterThanOrEqual(1);
        });
    });

    // ── 7. Long-range dashboard views are fast (pre-computed) ─────────────────
    describe('performance on pre-computed aggregates', () => {
        // Pre-computed reads should be far under the 200ms aggregate-read target
        // from Task 3.11; 200ms leaves headroom for a contended CI runner.
        const FAST_MS = 200;

        async function timed(url: string): Promise<{status: number; ms: number}> {
            const start = performance.now();
            const res = await app.inject({method: 'GET', url, headers: admin});
            return {status: res.statusCode, ms: performance.now() - start};
        }

        it('serves the lifetime maturity trend fast', async () => {
            const {status, ms} = await timed('/api/maturity/org/trend?range=lifetime');
            expect(status).toBe(200);
            expect(ms, `lifetime maturity trend took ${ms.toFixed(0)}ms`).toBeLessThan(FAST_MS);
        });

        it('serves a pre-computed aggregate read fast', async () => {
            const {status, ms} = await timed(`/api/aggregates/org/quarterly?period=${QUARTER}`);
            expect(status).toBe(200);
            expect(ms, `org quarterly read took ${ms.toFixed(0)}ms`).toBeLessThan(FAST_MS);
        });
    });

    // ── 8. Maturity calibration sanity-check ──────────────────────────────────
    describe('maturity calibration sanity-check', () => {
        // Notes recorded in docs/MATURITY_CALIBRATION.md. The seeded gradient
        // (backend strong → frontend moderate → platform weak) must produce a
        // matching score ordering, else the formula's weighting is miscalibrated.
        function quarterScore(team: string): number {
            const row = db
                .prepare('SELECT ai_maturity_score AS s FROM quarterly_aggregates WHERE team = ? AND quarter = ?')
                .get(team, QUARTER) as {s: number | null};
            expect(row?.s).not.toBeNull();
            return row.s as number;
        }

        it('ranks strong adopters above moderate above weak, all in 0..100', () => {
            const backend = quarterScore('backend');
            const frontend = quarterScore('frontend');
            const platform = quarterScore('platform');
            for (const s of [backend, frontend, platform]) {
                expect(s).toBeGreaterThanOrEqual(0);
                expect(s).toBeLessThanOrEqual(100);
            }
            expect(backend).toBeGreaterThan(frontend);
            expect(frontend).toBeGreaterThan(platform);
        });
    });

    // ── role gating spot-check (the developer must not reach admin surfaces) ──
    it('denies the developer role the admin aggregate/summary/maturity endpoints', async () => {
        for (const url of [
            `/api/aggregates/org/quarterly?period=${QUARTER}`,
            '/api/maturity/org/trend?range=lifetime',
            '/api/summaries',
        ]) {
            const res = await app.inject({method: 'GET', url, headers: developer});
            expect(res.statusCode, url).toBe(403);
        }
    });

    it('denies the developer role the admin summary-generation POST routes', async () => {
        // The same admin surfaces the suite drives as the manager must 403 for a
        // developer — completing the privacy claim for every endpoint the diff touches.
        const generate = await app.inject({
            method: 'POST',
            url: '/api/summaries/generate',
            headers: developer,
            payload: {level: 'quarterly', period: QUARTER, scope: 'team:backend'},
        });
        expect(generate.statusCode).toBe(403);

        const regenerate = await app.inject({
            method: 'POST',
            url: `/api/summaries/${encodeURIComponent('summary:team:backend:quarterly:2026-Q2')}/regenerate`,
            headers: developer,
            payload: {},
        });
        expect(regenerate.statusCode).toBe(403);
    });
});

/** A no-op auto-generation logger so the suite's output stays clean. */
function silentAutoLogger(): SummaryAutoLogger {
    return {
        jobStart: (): void => undefined,
        aggregateMissing: (): void => undefined,
        scopeFinished: (): void => undefined,
        jobFailure: (): void => undefined,
        jobComplete: (): void => undefined,
    };
}
