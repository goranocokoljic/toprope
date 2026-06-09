/**
 * Phase 4 close-out — integration testing + dogfood verification (Task 4.13 / #108).
 *
 * End-to-end verification of every Phase 4 addition against a realistic GIT-ONLY
 * dogfood shape (the WMG launch tier: developers are MEDIUM/git-only until a tool
 * connector lights up). The suite drives the REAL production code paths — the
 * self-report core, the Cursor connector sync, the richer expense import +
 * reconciliation, the anomaly scan, the survey trigger sweep + dispatch, and the
 * comparison / journey HTTP endpoints — with only the outbound network hops
 * stubbed (a fake `fetch` for Cursor, a recording Slack client + emailer for
 * surveys). Nothing is mocked between the route handler and the data layer.
 *
 * Each `it` maps to one deliverable / acceptance criterion of the issue:
 *   1. Self-reporting (CLI + Slack) → self_report/medium; API-wins rule holds
 *   2. Cursor connector sync → tool_snapshots (fixture-driven fetch)
 *   3. Richer expense import + reconciliation → mismatches flagged, resolvable,
 *      total spend trustworthy
 *   4. Anomaly detection → correct method/severity/basis; minimum-baseline guard
 *      suppresses early-weeks noise
 *   5. Surveys → trigger → auto/manual per settings → Slack delivery → response
 *      captured and shown to the manager as context
 *   6. Comparison → rich (≤4) + sortable all-teams, tier labeling correct
 *   7. Journey → developer + manager views, transitions plotted, scoping correct
 *   8. Tier-awareness → anomaly text in summaries carries NO fabricated usage
 *      language (reuses the Phase 3 forbidden-terms catalogue)
 *   9. Performance → the new dashboard views answer well under the 2s budget
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {performance} from 'node:perf_hooks';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';

import {makeIntegrationDb, createAccount, login, authHeaders} from './harness';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerDeveloperRoutes} from '../../src/dashboard/api/developers';
import {registerCompareRoutes} from '../../src/dashboard/api/compare';
import {registerCompareTableRoutes} from '../../src/dashboard/api/compare-table';
import {registerAnomalyRoutes} from '../../src/dashboard/api/anomalies';
import {registerSurveyRoutes} from '../../src/dashboard/api/surveys';

import {addTeam} from '../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../src/registry/developers';
import {createSelfReport} from '../../src/selfreport/core';
import {CursorSync} from '../../src/connectors/cursor/sync';
import type {CursorUserMetrics, CursorUsageResponse} from '../../src/connectors/cursor/client';
import {
    reconcilePeriod,
    listReconciliationResults,
    resolveReconciliationResult,
} from '../../src/expenses/reconcile';
import {isoWeekStart, priorWeekStart} from '../../src/aggregation/dates';
import {runAnomalyScanForPeriod} from '../../src/anomaly/scan';
import {listAnomalies} from '../../src/anomaly/store';
import {setGlobalSetting} from '../../src/settings/store';
import {runTriggerSweep} from '../../src/surveys/dispatch';
import {listSurveys} from '../../src/surveys/store';
import {buildSummaryInput, formatSummaryInput} from '../../src/summaries/input-builder';
import {
    buildSummaryPrompt,
    findFabricatedUsageLanguage,
    FABRICATED_USAGE_TERMS,
} from '../../src/summaries/prompts';
import type {AggregateMetrics} from '../../src/summaries/input-builder';
import type {AnomalyRecord} from '../../src/anomaly/types';
import type {Emailer, OutboundEmail} from '../../src/surveys/email';
import {FakeSlackClient} from '../slack/fake-client';

// ── shared helpers ────────────────────────────────────────────────────────────

class FakeEmailer implements Emailer {
    sent: OutboundEmail[] = [];
    async sendEmail(message: OutboundEmail): Promise<void> {
        this.sent.push(message);
    }
}

interface CursorEntryOverrides {
    date?: string;
}

function cursorEntry(email: string, overrides: CursorEntryOverrides = {}): CursorUserMetrics {
    return {
        user_id: 'cur-user-1',
        email,
        date: overrides.date ?? '2026-05-12',
        autocomplete_shown: 100,
        autocomplete_accepted: 45,
        composer_requests: 8,
        chat_requests: 15,
        models_used: {'gpt-4o': 18},
        estimated_cost: 3.25,
    };
}

function cursorOkResponse(entries: CursorUserMetrics[]): {
    ok: true;
    status: number;
    headers: {get: () => null};
    json: () => Promise<CursorUsageResponse>;
} {
    const body: CursorUsageResponse = {users: entries, has_more: false, next_cursor: null};
    return {ok: true, status: 200, headers: {get: () => null}, json: async () => body};
}

// ── 1. Self-reporting (CLI + Slack) ───────────────────────────────────────────

describe('Phase 4 E2E (4.13): self-reporting', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeIntegrationDb();
        addTeam(db, 'eng');
    });
    afterEach(() => db.close());

    it('a CLI self-report lands as a self_report/medium snapshot (no fabricated counts)', () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@wmg.test').id;
        const result = createSelfReport(db, {
            developerId: dev,
            tool: 'cursor',
            minutes: 90,
            taskDescriptor: 'refactor auth',
            date: '2026-05-04',
            sourceInterface: 'cli',
        });
        expect(result.snapshot).toBe('created');

        const snap = db
            .prepare('SELECT * FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?')
            .get(dev, '2026-05-04', 'cursor') as Record<string, unknown>;
        expect(snap.data_source).toBe('self_report');
        expect(snap.data_quality).toBe('medium');
        expect(snap.is_active).toBe(1);
        // A time estimate never manufactures measured interaction counts.
        expect(snap.interaction_count).toBeNull();
        // The private task descriptor never bleeds into the aggregated snapshot.
        expect(JSON.stringify(snap)).not.toContain('refactor auth');
    });

    it('a Slack self-report is attributed to its source interface', () => {
        const dev = addDeveloper(db, 'Bob', 'eng', 'bob@wmg.test').id;
        const result = createSelfReport(db, {
            developerId: dev,
            tool: 'chatgpt',
            date: '2026-05-05',
            sourceInterface: 'slack',
        });
        expect(result.snapshot).toBe('created');
        const stored = db
            .prepare('SELECT source_interface, tool FROM self_reports WHERE id = ?')
            .get(result.report.id) as {source_interface: string; tool: string};
        expect(stored.source_interface).toBe('slack');
        expect(stored.tool).toBe('chatgpt');
    });

    it('API-WINS: a self-report never overrides a measured API snapshot for the same day', () => {
        const dev = addDeveloper(db, 'Cara', 'eng', 'cara@wmg.test').id;
        // Measured API data already exists for cursor on this date.
        db.prepare(
            `INSERT INTO tool_snapshots
               (id, developer_id, date, tool, data_source, data_quality, is_active,
                interaction_count, acceptance_count, acceptance_rate)
             VALUES (?, ?, ?, 'cursor', 'api', 'high', 1, 120, 60, 0.5)`,
        ).run(randomUUID(), dev, '2026-05-06');

        const result = createSelfReport(db, {
            developerId: dev,
            tool: 'cursor',
            minutes: 30,
            date: '2026-05-06',
            sourceInterface: 'cli',
        });
        expect(result.snapshot).toBe('api_wins');

        // The measured snapshot is untouched; no duplicate row was created.
        const snap = db
            .prepare('SELECT data_source, data_quality, interaction_count FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?')
            .get(dev, '2026-05-06', 'cursor') as {data_source: string; data_quality: string; interaction_count: number};
        expect(snap.data_source).toBe('api');
        expect(snap.data_quality).toBe('high');
        expect(snap.interaction_count).toBe(120);
        const count = db
            .prepare('SELECT COUNT(*) AS n FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?')
            .get(dev, '2026-05-06', 'cursor') as {n: number};
        expect(count.n).toBe(1);
    });
});

// ── 2. Cursor connector ────────────────────────────────────────────────────────

describe('Phase 4 E2E (4.13): Cursor connector sync', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeIntegrationDb();
        vi.restoreAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.close();
    });

    it('syncs Cursor usage into a measured (api/high) tool_snapshot', async () => {
        addTeam(db, 'eng');
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@wmg.test');
        linkDeveloper(db, dev.id, {cursor: 'alice@wmg.test'});

        vi.stubGlobal('fetch', vi.fn(async () => cursorOkResponse([cursorEntry('alice@wmg.test')])));
        const result = await new CursorSync({enabled: true, service_key: 'k'}).sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(1);

        const snap = db
            .prepare('SELECT tool, data_source, data_quality, interaction_count FROM tool_snapshots WHERE developer_id = ?')
            .get(dev.id) as {tool: string; data_source: string; data_quality: string; interaction_count: number};
        expect(snap.tool).toBe('cursor');
        expect(snap.data_source).toBe('api');
        expect(snap.data_quality).toBe('high');
    });

    it('API data wins over a prior self-report for the same dev/date/tool', async () => {
        addTeam(db, 'eng');
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@wmg.test');
        linkDeveloper(db, dev.id, {cursor: 'alice@wmg.test'});
        createSelfReport(db, {developerId: dev.id, tool: 'cursor', date: '2026-05-12', minutes: 30, sourceInterface: 'cli'});

        vi.stubGlobal('fetch', vi.fn(async () => cursorOkResponse([cursorEntry('alice@wmg.test', {date: '2026-05-12'})])));
        const result = await new CursorSync({enabled: true, service_key: 'k'}).sync(db);

        expect(result.snapshotsWritten).toBe(1);
        // Exactly one row, now measured — the self_report placeholder was replaced.
        const rows = db
            .prepare('SELECT data_source, data_quality FROM tool_snapshots WHERE developer_id = ?')
            .all(dev.id) as {data_source: string; data_quality: string}[];
        expect(rows).toHaveLength(1);
        expect(rows[0].data_source).toBe('api');
        expect(rows[0].data_quality).toBe('high');
        // The raw self-report stays on record.
        const reports = db.prepare('SELECT COUNT(*) AS n FROM self_reports WHERE developer_id = ?').get(dev.id) as {n: number};
        expect(reports.n).toBe(1);
    });
});

// ── 3. Richer expense import + reconciliation ──────────────────────────────────

describe('Phase 4 E2E (4.13): richer expense import + reconciliation', () => {
    const PERIOD = '2026-06';
    let db: Database.Database;
    let alice: string;
    let bob: string;

    function insertCharge(opts: {developerId: string | null; tool: string; monthlyCost: number | null}): string {
        const id = randomUUID();
        db.prepare(
            `INSERT INTO expense_charges
               (id, dedup_key, developer_id, tool, plan, amount, period, charge_type,
                monthly_cost, billing_model, match_status, source_profile, created_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, 'recurring_monthly', ?, 'reimbursed', ?, 'standard', ?)`,
        ).run(
            id, id, opts.developerId, opts.tool, opts.monthlyCost, PERIOD, opts.monthlyCost,
            opts.developerId ? 'matched' : 'unmatched', '2026-06-15T00:00:00.000Z',
        );
        return id;
    }

    function insertSub(opts: {developerId: string; tool: string; monthlyCost: number | null}): void {
        db.prepare(
            `INSERT INTO subscriptions
               (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, seat_revoked_at, data_source)
             VALUES (?, ?, ?, NULL, 'reimbursed', ?, '2026-06-01T00:00:00.000Z', NULL, 'csv')`,
        ).run(randomUUID(), opts.developerId, opts.tool, opts.monthlyCost);
    }

    beforeEach(() => {
        db = makeIntegrationDb();
        addTeam(db, 'eng');
        alice = addDeveloper(db, 'Alice', 'eng', 'alice@wmg.test').id;
        bob = addDeveloper(db, 'Bob', 'eng', 'bob@wmg.test').id;
    });
    afterEach(() => db.close());

    it('flags every mismatch type and leaves a matched seat clean (trustworthy spend)', () => {
        // A correctly-matched seat ($19 charge ↔ $19 seat) → no flag: the spend
        // numbers behind it are trustworthy.
        insertSub({developerId: alice, tool: 'copilot', monthlyCost: 19});
        insertCharge({developerId: alice, tool: 'copilot', monthlyCost: 19});
        // A reimbursed seat with no matching expense.
        insertSub({developerId: bob, tool: 'windsurf', monthlyCost: 15});
        // An expense with no matching subscription.
        insertCharge({developerId: bob, tool: 'cursor', monthlyCost: 20});

        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.subscription_no_expense).toBe(1);
        expect(summary.byType.expense_no_subscription).toBe(1);
        expect(summary.byType.cost_discrepancy).toBe(0);

        const open = listReconciliationResults(db, {status: 'open'});
        expect(open).toHaveLength(2);
    });

    it('surfaces a cost discrepancy and lets a manager resolve it', () => {
        insertSub({developerId: alice, tool: 'copilot', monthlyCost: 20});
        insertCharge({developerId: alice, tool: 'copilot', monthlyCost: 40});

        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.cost_discrepancy).toBe(1);
        const [result] = listReconciliationResults(db, {status: 'open'});
        expect(result.expense_amount).toBe(40);
        expect(result.registry_amount).toBe(20);

        const resolved = resolveReconciliationResult(db, result.id, 'corrected the seat cost in the registry');
        expect(resolved.status).toBe('resolved');
        // The open queue is now clear — the spend picture is trustworthy again.
        expect(listReconciliationResults(db, {status: 'open'})).toHaveLength(0);
    });

    it('is idempotent — a re-run does not duplicate the open mismatch', () => {
        insertCharge({developerId: alice, tool: 'cursor', monthlyCost: 20});
        expect(reconcilePeriod(db, PERIOD).created).toBe(1);
        const second = reconcilePeriod(db, PERIOD);
        expect(second.created).toBe(0);
        expect(second.skipped).toBe(1);
        expect(listReconciliationResults(db, {status: 'open'})).toHaveLength(1);
    });
});

// ── 4. Anomaly detection + minimum-baseline guard ──────────────────────────────

describe('Phase 4 E2E (4.13): anomaly detection', () => {
    // Six consecutive ISO weeks ending at a chosen Monday (oldest → newest).
    const BASE = isoWeekStart('2026-05-04');
    const WEEKS: string[] = ((): string[] => {
        const desc = [BASE];
        for (let i = 0; i < 5; i++) desc.push(priorWeekStart(desc[desc.length - 1]));
        return desc.reverse();
    })();
    const OBSERVED = WEEKS[WEEKS.length - 1];

    let db: Database.Database;

    function insertDeveloper(id: string, team: string): void {
        db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
            id, id, `${id}@wmg.test`, team, '2026-01-01T00:00:00.000Z',
        );
    }

    function insertWeekly(devId: string, team: string, week: string, commits: number): void {
        db.prepare(
            `INSERT INTO weekly_aggregates
               (id, developer_id, week_start, team, total_commits, total_prs_merged,
                total_interactions, avg_code_churn, subscription_cost, computed_at)
             VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?)`,
        ).run(`${devId}-${week}`, devId, week, team, commits, '2026-05-10T00:00:00.000Z');
    }

    beforeEach(() => {
        db = makeIntegrationDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(
            'backend', '2026-01-01T00:00:00.000Z',
        );
    });
    afterEach(() => db.close());

    it('flags a git commit spike with the correct method/severity/basis', () => {
        insertDeveloper('cara', 'backend');
        // A stable baseline, then a sharp spike in the observed week.
        const series = [8, 12, 9, 11, 10, 40];
        WEEKS.forEach((week, i) => insertWeekly('cara', 'backend', week, series[i]));

        const result = runAnomalyScanForPeriod(db, OBSERVED);
        expect(result.flagged).toBeGreaterThanOrEqual(1);

        const anomaly = listAnomalies(db, {scope: 'developer'}).find(
            (a) => a.scope_id === 'cara' && a.metric === 'commits',
        );
        expect(anomaly).toBeDefined();
        expect(anomaly?.method).toBe('statistical');
        expect(anomaly?.observed_value).toBe(40);
        expect(anomaly?.basis).toBe('git_estimate');
        expect(anomaly?.severity).toBe('high');
    });

    it('MINIMUM-BASELINE GUARD: fires nothing while a new developer is still building baseline', () => {
        insertDeveloper('newbie', 'backend');
        // Only 3 weeks (2 priors) — below the default minimum — even with a wild spike.
        const last3 = WEEKS.slice(-3);
        const series = [10, 10, 500];
        last3.forEach((week, i) => insertWeekly('newbie', 'backend', week, series[i]));

        const result = runAnomalyScanForPeriod(db, OBSERVED);
        expect(result.buildingBaseline).toBeGreaterThanOrEqual(1);
        expect(listAnomalies(db, {scope: 'developer', scopeId: 'newbie'})).toHaveLength(0);
    });
});

// ── 5. Surveys: trigger → dispatch → response → context ────────────────────────

describe('Phase 4 E2E (4.13): data-prompted surveys', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let slack: FakeSlackClient;
    let emailer: FakeEmailer;
    let admin: Record<string, string>;

    function insertMonthlyDrop(devId: string): void {
        db.prepare(
            `INSERT INTO monthly_aggregates (id, developer_id, month, team, interaction_delta_pct, computed_at)
             VALUES (?, ?, '2026-05', 'eng', -50, ?)`,
        ).run(randomUUID(), devId, new Date().toISOString());
    }

    beforeEach(async () => {
        db = makeIntegrationDb();
        addTeam(db, 'eng');
        slack = new FakeSlackClient();
        emailer = new FakeEmailer();
        app = Fastify({logger: false});
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerMeRoutes(app, db);
        registerSurveyRoutes(app, db, {slackClient: slack, emailer, log: () => {}});
        await app.ready();
        await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
        admin = authHeaders(await login(app, 'manager@wmg.test'));
    });
    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('MANUAL by default: a usage-drop trigger queues a survey (not auto-sent)', async () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@wmg.test').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        insertMonthlyDrop(dev);

        const summary = await runTriggerSweep({db, slackClient: slack, emailer, log: () => {}});
        expect(summary.candidates).toBe(1);
        expect(summary.queued).toBe(1);
        expect(summary.autoSent).toBe(0);
        expect(slack.postMessageCalls).toHaveLength(0);
    });

    it('AUTO per settings: the same trigger auto-sends via Slack, response is captured + shown to the manager', async () => {
        setGlobalSetting(db, 'survey_usage_drop_auto', true);
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@wmg.test').id;
        linkDeveloper(db, dev, {slack: 'U_ALICE'});
        // The developer needs an account to answer through the API.
        await createAccount(db, {email: 'alice@wmg.test', role: 'developer', developerId: dev});
        insertMonthlyDrop(dev);

        const summary = await runTriggerSweep({db, slackClient: slack, emailer, log: () => {}});
        expect(summary.autoSent).toBe(1);
        expect(slack.postMessageCalls).toHaveLength(1);
        expect(slack.postMessageCalls[0].channel).toBe('U_ALICE');

        // The developer answers through their own surface…
        const alice = authHeaders(await login(app, 'alice@wmg.test'));
        const mine = await app.inject({method: 'GET', url: '/api/me/surveys', headers: alice});
        const surveyId = (mine.json() as {data: {id: string}[]}).data[0].id;
        const respond = await app.inject({
            method: 'POST',
            url: `/api/me/surveys/${surveyId}/respond`,
            headers: alice,
            payload: {text: 'moved to a personal Cursor account'},
        });
        expect(respond.statusCode).toBe(200);

        // …and the manager sees that response as context next to the trigger.
        const detail = await app.inject({method: 'GET', url: `/api/surveys/${surveyId}`, headers: admin});
        expect(detail.statusCode).toBe(200);
        const data = (detail.json() as {data: {status: string; trigger_type: string; response: {response_text: string} | null}}).data;
        expect(data.trigger_type).toBe('usage_drop');
        expect(data.response?.response_text).toBe('moved to a personal Cursor account');

        // The manager's answered queue carries the response too.
        const answered = listSurveys(db, {status: 'answered'});
        expect(answered).toHaveLength(1);
        expect(answered[0].response?.response_text).toBe('moved to a personal Cursor account');
    });
});

// ── 6 + 7 + 9. Comparison, journey, performance (HTTP, git-only org) ───────────

describe('Phase 4 E2E (4.13): comparison + journey + performance', () => {
    const CREATED = '2026-01-01T00:00:00.000Z';
    let db: Database.Database;
    let app: FastifyInstance;
    let admin: Record<string, string>;
    let dev: Record<string, string>;

    function seedTeam(name: string): void {
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)').run(
            name, 'engineering', `${name}-mgr@wmg.test`, CREATED,
        );
    }
    function seedDeveloper(id: string, team: string): void {
        db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
            id, id, `${id}@wmg.test`, team, CREATED,
        );
    }
    function seedGit(devId: string, date: string, opts: {commits: number; prs: number; churn: number; ai?: number}): void {
        db.prepare(
            `INSERT INTO git_snapshots (id, developer_id, date, commits, lines_added, lines_removed, prs_merged, code_churn_rate, ai_signature_score, data_source)
             VALUES (?, ?, ?, ?, 100, 20, ?, ?, ?, 'git')`,
        ).run(`git:${devId}:${date}`, devId, date, opts.commits, opts.prs, opts.churn, opts.ai ?? 0.6);
    }
    function seedTool(devId: string, date: string, tool: string): void {
        db.prepare(
            `INSERT INTO tool_snapshots
               (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count, acceptance_rate)
             VALUES (?, ?, ?, ?, 'api', 'high', 1, 40, 30, 0.75)`,
        ).run(`tool:${devId}:${tool}:${date}`, devId, date, tool);
    }
    function seedSubscription(devId: string, tool: string, cost: number): void {
        db.prepare(
            `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, data_source)
             VALUES (?, ?, ?, 'business', 'company_managed', ?, ?, 'csv')`,
        ).run(`sub:${devId}:${tool}`, devId, tool, cost, CREATED);
    }
    function seedQuarterly(team: string, quarter: string, score: number): void {
        db.prepare(
            `INSERT INTO quarterly_aggregates (id, team, quarter, developer_count, ai_maturity_score, ai_maturity_basis, computed_at)
             VALUES (?, ?, ?, 2, ?, 'git_estimate', ?)`,
        ).run(`q:${team}:${quarter}`, team, quarter, score, CREATED);
    }
    function seedPlanChange(opts: {id: string; developer: string; tool: string; oldPlan: string; newPlan: string; changedAt: string}): void {
        db.prepare(
            `INSERT INTO plan_change_events
               (id, developer_id, tool, old_tool, old_plan, new_plan, old_monthly_cost, new_monthly_cost, changed_at)
             VALUES (?, ?, ?, NULL, ?, ?, 20, 200, ?)`,
        ).run(opts.id, opts.developer, opts.tool, opts.oldPlan, opts.newPlan, opts.changedAt);
    }

    beforeEach(async () => {
        db = makeIntegrationDb();

        // alpha: fully connected (API + git + sub) → tier high.
        seedTeam('alpha');
        seedDeveloper('a1', 'alpha');
        seedDeveloper('a2', 'alpha');
        seedGit('a1', '2026-05-10', {commits: 5, prs: 2, churn: 0.2});
        seedGit('a2', '2026-05-11', {commits: 3, prs: 1, churn: 0.4});
        seedTool('a1', '2026-05-10', 'copilot');
        seedTool('a2', '2026-05-11', 'claude_code');
        seedSubscription('a1', 'copilot', 19);
        seedQuarterly('alpha', '2026-Q2', 80);

        // beta: git-only → tier medium, no tool mix.
        seedTeam('beta');
        seedDeveloper('b1', 'beta');
        seedGit('b1', '2026-05-12', {commits: 4, prs: 1, churn: 0.1});
        seedQuarterly('beta', '2026-Q2', 60);

        // gamma: expense-only → tier low.
        seedTeam('gamma');
        seedDeveloper('g1', 'gamma');
        seedSubscription('g1', 'cursor', 20);

        // delta: a registered developer with no data at all → tier none.
        seedTeam('delta');
        seedDeveloper('d1', 'delta');

        // A journey developer: a tool transition (plan change) over time.
        seedTool('a1', '2026-03-01', 'claude_code');
        seedPlanChange({id: 'pc1', developer: 'a1', tool: 'claude_code', oldPlan: 'pro', newPlan: 'max', changedAt: '2026-04-01T12:00:00.000Z'});

        app = Fastify({logger: false});
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerMeRoutes(app, db);
        registerDeveloperRoutes(app, db);
        registerCompareRoutes(app, db);
        registerCompareTableRoutes(app, db);
        registerAnomalyRoutes(app, db);
        await app.ready();

        await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
        await createAccount(db, {email: 'a1@wmg.test', role: 'developer', developerId: 'a1'});
        admin = authHeaders(await login(app, 'manager@wmg.test'));
        dev = authHeaders(await login(app, 'a1@wmg.test'));
    });
    afterEach(async () => {
        await app.close();
        db.close();
    });

    // ── comparison: rich side-by-side (≤4) ───────────────────────────────────
    it('rich comparison labels each team with its data-quality tier', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta,gamma,delta&range=lifetime',
            headers: admin,
        });
        expect(res.statusCode).toBe(200);
        const teams = (res.json() as {data: {teams: {name: string; tier: string; metrics: {ai_maturity_basis: string | null}}[]}}).data.teams;
        const tierOf = (name: string): string => teams.find((t) => t.name === name)!.tier;
        expect(tierOf('alpha')).toBe('high');
        expect(tierOf('beta')).toBe('medium');
        expect(tierOf('gamma')).toBe('low');
        expect(tierOf('delta')).toBe('none');
        // Maturity carries the honest git_estimate basis (never a fabricated label).
        expect(teams.find((t) => t.name === 'alpha')!.metrics.ai_maturity_basis).toBe('git_estimate');
    });

    it('rich comparison enforces the ≤4 / ≥2 team bounds', async () => {
        const tooMany = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta,gamma,delta,gamma2&range=lifetime',
            headers: admin,
        });
        expect(tooMany.statusCode).toBe(400);
        const tooFew = await app.inject({method: 'GET', url: '/api/compare?teams=alpha&range=lifetime', headers: admin});
        expect(tooFew.statusCode).toBe(400);
    });

    // ── comparison: sortable all-teams table ─────────────────────────────────
    it('the all-teams table lists every team for the period with its tier', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q2',
            headers: admin,
        });
        expect(res.statusCode).toBe(200);
        const rows = (res.json() as {data: {teams: {name: string; tier: string}[]}}).data.teams;
        const names = rows.map((t) => t.name).sort();
        expect(names).toEqual(['alpha', 'beta', 'delta', 'gamma']);
        expect(rows.find((t) => t.name === 'alpha')!.tier).toBe('high');
        expect(rows.find((t) => t.name === 'beta')!.tier).toBe('medium');
    });

    // ── journey: developer + manager views ───────────────────────────────────
    it('serves a developer their own journey with bounds, trajectory and tier', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/journey', headers: dev});
        expect(res.statusCode).toBe(200);
        const data = (res.json() as {data: {bounds: {first_activity: string | null}; trajectory: unknown[]; tier: string; events: {type: string}[]}}).data;
        expect(data.bounds.first_activity).not.toBeNull();
        expect(data.trajectory.length).toBeGreaterThan(0);
        expect(data.tier).toBe('high');
        // The plan-change transition is plotted on the journey.
        expect(data.events.some((e) => e.type === 'plan_change')).toBe(true);
    });

    it('serves a manager any developer journey, and scopes the developer to their own', async () => {
        // Manager can read a1's journey through the manager route.
        const mgr = await app.inject({method: 'GET', url: '/api/developers/a1/journey', headers: admin});
        expect(mgr.statusCode).toBe(200);
        // The developer role is confined to /api/me — the manager route is forbidden.
        const forbidden = await app.inject({method: 'GET', url: '/api/developers/a1/journey', headers: dev});
        expect(forbidden.statusCode).toBe(403);
    });

    // ── performance: every new view answers well under the 2s budget ─────────
    // A smoke check at the dogfood-shape seed above (a handful of teams/developers),
    // not a scale benchmark: it guards against an endpoint that hangs, 500s, or does
    // unbounded blocking work, and pins the issue's "< 2s on real data" acceptance
    // criterion. Large-N query-shape regressions are the remit of
    // tests/integration/performance.test.ts, not this close-out check.
    it('answers the new dashboard views well under the 2s budget', async () => {
        async function timed(url: string, headers: Record<string, string>): Promise<{status: number; ms: number}> {
            const start = performance.now();
            const res = await app.inject({method: 'GET', url, headers});
            return {status: res.statusCode, ms: performance.now() - start};
        }
        const views: Array<[string, Record<string, string>]> = [
            ['/api/compare?teams=alpha,beta,gamma,delta&range=lifetime', admin],
            ['/api/teams/compare-table?period=2026-Q2', admin],
            ['/api/anomalies', admin],
            ['/api/me/journey', dev],
        ];
        for (const [url, headers] of views) {
            const {status, ms} = await timed(url, headers);
            expect(status).toBe(200);
            expect(ms, `${url} took ${ms.toFixed(0)}ms`).toBeLessThan(2000);
        }
    });
});

// ── 8. Tier-awareness: no fabricated usage language in anomaly summaries ────────

describe('Phase 4 E2E (4.13): tier-awareness — anomaly summaries carry no fabricated usage', () => {
    const gitMetrics: AggregateMetrics = {
        developer_count: 5,
        active_developer_count: 4,
        total_commits: 120,
        total_prs_merged: 30,
        avg_code_churn: 0.3,
        avg_ai_signature_score: 0.5,
        subscription_cost: 400,
        cost_per_pr: 13.33,
        ai_maturity_score: 62,
        ai_maturity_basis: 'git_estimate',
        data_quality: 'medium',
    };

    const anomaly = (overrides: Partial<AnomalyRecord>): AnomalyRecord => ({
        id: 'a1',
        scope: 'team',
        scope_id: 'backend',
        metric: 'commits',
        period: '2026-05-04',
        method: 'statistical',
        observed_value: 4,
        expected_value: 10,
        deviation: -3.1,
        severity: 'high',
        basis: 'git_estimate',
        status: 'open',
        detected_at: '2026-05-11T00:00:00.000Z',
        notified_at: null,
        ...overrides,
    });

    it('folds git-only anomalies into a summary payload whose text contains NO fabricated tool-usage terms', () => {
        const payload = buildSummaryInput({
            level: 'weekly',
            periodLabel: '2026-W19',
            start: '2026-05-04',
            end: '2026-05-10',
            scope: {type: 'team', name: 'backend'},
            current: gitMetrics,
            prior: null,
            anomalies: [
                anomaly({metric: 'commits', severity: 'high'}),
                anomaly({id: 'a2', metric: 'prs_merged', severity: 'notable', observed_value: 2, expected_value: 30}),
                anomaly({id: 'a3', metric: 'churn', severity: 'notable', observed_value: 0.8, expected_value: 0.3}),
                anomaly({id: 'a4', metric: 'cost', severity: 'high', method: 'percentage_change', observed_value: 900, expected_value: 400}),
            ],
        });

        // Render the input block — the data the model narrates — once, then check it
        // two complementary ways. The explicit term loop is the literal "reuse the
        // Phase 3 forbidden-terms catalogue" the issue calls for (mirrors
        // anomaly-integration.test.ts), with a clear per-term failure message; the
        // production guard (findFabricatedUsageLanguage) is the stronger end-to-end
        // assertion over the same rendered text.
        const rendered = formatSummaryInput(payload);
        const block = rendered.toLowerCase();
        for (const term of FABRICATED_USAGE_TERMS) {
            expect(block, `forbidden term leaked: ${term}`).not.toContain(term);
        }
        expect(findFabricatedUsageLanguage(rendered, payload)).toEqual([]);
        // Sanity: the honest git wording IS present.
        expect(block).toContain('commit activity dropped');
        // The prompt builds without throwing the numbers-only / privacy guard.
        expect(buildSummaryPrompt(payload)).toContain(payload.data_basis);
    });
});
