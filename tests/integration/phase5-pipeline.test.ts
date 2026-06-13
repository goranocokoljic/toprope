/**
 * Phase 5 close-out — integration testing + privacy verification + dogfood
 * (Task 5.12 / #133).
 *
 * Phase 5 is the privacy-critical phase: a single leak of an individual's
 * coaching data would break the trust the whole product depends on. So beyond the
 * functional end-to-end flows, this suite runs a dedicated PRIVACY VERIFICATION
 * pass — every item in the issue's privacy checklist is its own assertion, driven
 * through the REAL production code paths (the PR/review metrics engine, the
 * available-data signal generator, the client-side capture encryption + blind
 * store, the key-recovery wrap/unwrap, the local real-time coach, the
 * local/cloud retrospective generator, and the showcase promote/redact/publish +
 * governance flow) against a realistic WMG-shaped dataset. Nothing is mocked
 * between the HTTP route handlers and the data layer; only the cloud retrospective
 * analyser is a recording fake (no external model is called).
 *
 * Each top-level describe maps to one deliverable / acceptance criterion:
 *   1. Pillar 2 E2E — PR/review metrics → developer-private surface + manager
 *      aggregate, across GitHub/Bitbucket/GitLab data
 *   2. Pillar 1 E2E — available-data coaching for a git-only developer
 *   3. Pillar 3 E2E — opt-in → capture (both mechanisms) → local loop/nudges →
 *      local-model retrospective → cloud opt-in path → key recovery flow
 *   4. Showcase E2E — promote → mandatory redact → publish → browse → unpublish →
 *      lead-remove
 *   5. Privacy verification — every checklist item, the gate for the phase
 *   6. Dogfood — Pillar 2 signals on the WMG-shaped data are sane
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';

import {
    makeIntegrationDb,
    createAccount,
    login,
    authHeaders,
    seedTeam,
    seedDeveloper,
    seedGitSnapshot,
    seedToolSnapshot,
    daysAgo,
} from './harness';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerCoachingRoutes} from '../../src/dashboard/api/coaching';
import {registerManagerCoachingRoutes} from '../../src/dashboard/api/manager-coaching';
import {registerCaptureRoutes} from '../../src/dashboard/api/captures';
import {registerKeyRoutes} from '../../src/dashboard/api/keys';
import {registerRealtimeCoachingRoutes} from '../../src/dashboard/api/realtime-coaching';
import {registerRetrospectiveRoutes} from '../../src/dashboard/api/retrospectives';
import {registerShowcaseRoutes} from '../../src/dashboard/api/showcase';
import {registerShowcaseAdminRoutes} from '../../src/dashboard/api/showcase-admin';

import {setGlobalSetting, setDeveloperPreference} from '../../src/settings/store';
import {getActiveUserByEmail} from '../../src/auth/users';
import {computePRReviewMetricsForPeriod} from '../../src/coaching/pr-review/compute';
import {generateCoachingSignalsForPeriod} from '../../src/coaching/available/generator';
import {buildCapturePayload, type CaptureWirePayload} from '../../src/capture/client';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {wrapCaptureKey, unwrapCaptureKey, type RecoveryMeta} from '../../src/capture/key-recovery';
import {RealtimeCoach} from '../../src/coaching/realtime/coach';
import {
    LocalHeuristicAnalyzer,
    type AnalysisResult,
    type RetrospectiveAnalyzer,
    type SessionAnalysisInput,
} from '../../src/coaching/retrospective/analyzer';
import {monthOf, priorMonth} from '../../src/aggregation/dates';
import type {RetrospectiveAnalyzers} from '../../src/coaching/retrospective/generator';

// ── response shapes (only the fields these tests assert on) ───────────────────

interface TrajPoint {
    period: string;
    prs_total: number;
    suppressed: boolean;
    developers: number | null;
    review_rejection_rate: number | null;
    avg_churn: number | null;
    combined_signal: string;
}
interface Variant {
    basis: string;
    scope_variant: string;
    points: TrajPoint[];
}
interface PRCoaching {
    enabled: boolean;
    all_pr?: Variant;
    ai_assisted?: Variant;
}
interface Signal {
    signal_type: string;
    basis: string;
    observation?: string;
}
interface AvailableCoaching {
    enabled: boolean;
    signals: Signal[];
}
interface RecoveryInitiate {
    recovery_blob: string;
    recovery_meta: RecoveryMeta;
}
/** The standard `{data}` envelope, generic over the payload. */
interface Envelope<T> {
    data: T;
    /** Present on a typed error body (e.g. capture/cloud gates). */
    code?: string;
}

/**
 * Render DB rows to a single searchable string, decoding BLOB columns to text.
 * `JSON.stringify` alone serialises a better-sqlite3 Buffer (a BLOB column like
 * `ciphertext` / `recovery_blob`) as `{"type":"Buffer","data":[…]}` — bytes as
 * integers — so a marker that leaked INTO a blob (e.g. encryption silently
 * bypassed) would be invisible to a substring scan. Decoding each Buffer to
 * latin1 makes those columns part of the search, so the no-plaintext / no-key
 * assertions defend the blob columns, not just the text ones.
 */
function rowsToSearchableText(rows: Array<Record<string, unknown>>): string {
    return rows
        .map((row) =>
            Object.values(row)
                .map((v) => (Buffer.isBuffer(v) ? v.toString('latin1') : JSON.stringify(v)))
                .join('|'),
        )
        .join('\n');
}

/** Find the window point for a period, asserting it exists (keeps callers null-free). */
function periodPoint(variant: Variant, period: string): TrajPoint {
    const point = variant.points.find((p) => p.period === period);
    if (!point) {
        throw new Error(`no trajectory point for period ${period}`);
    }
    return point;
}

// ── the world ───────────────────────────────────────────────────────────────

// A marker that must never appear in any server-side store or log: it is the
// "plaintext" stand-in for a developer's private prompt content.
const SECRET = 'SUPERSECRETMARKER refactor the billing code in src/billing.ts';

// The period (YYYY-MM) every seeded signal/metric lands in. Anchored ~15 days
// back so it is the current or immediately-prior month — always inside the
// monthly read window (6 months) regardless of when the suite runs — and so the
// day-of-month references below (-05 … -20) are unambiguously inside it.
const PERIOD = monthOf(daysAgo(15));
const day = (dd: string): string => `${PERIOD}-${dd}`;

interface World {
    /** developer-id → its user id (for setting developer preferences). */
    userIds: Record<string, string>;
}

/**
 * Insert one merged pr_records row. Only `changesRequested` (drives the rework /
 * rejection rate) and the in-period `created_at` day are asserted on; the other
 * per-PR columns are fixed at sensible constants the suite never varies.
 */
function seedPR(
    db: Database.Database,
    opts: {developer: string; provider: string; prId: string; createdDay: string; changesRequested: number},
): void {
    db.prepare(
        `INSERT INTO pr_records
         (id, developer_id, provider, repo, pr_id, state, created_at, merged_at, closed_at,
          review_comment_count, review_rounds, changes_requested_count, time_to_merge_hours, synced_at)
         VALUES (?, ?, ?, 'repo-a', ?, 'merged', ?, ?, ?, 2, 1, ?, 10, ?)`,
    ).run(
        randomUUID(),
        opts.developer,
        opts.provider,
        opts.prId,
        `${opts.createdDay}T08:00:00.000Z`,
        `${opts.createdDay}T18:00:00.000Z`,
        `${opts.createdDay}T18:00:00.000Z`,
        opts.changesRequested,
        '2026-06-01T00:00:00.000Z',
    );
}

/**
 * Insert a tool snapshot that DOES carry `acceptance_rate` — the column the
 * Pillar-1 generator reads for the acceptance-trend signal (the harness
 * `seedToolSnapshot` leaves it null). Used to give one developer real acceptance
 * data so git-only gilbert's honest *absence* of that signal is a true contrast.
 */
function seedAcceptanceSnapshot(db: Database.Database, developer: string, date: string, rate: number): void {
    db.prepare(
        `INSERT INTO tool_snapshots
           (id, developer_id, date, tool, data_source, data_quality, is_active,
            interaction_count, acceptance_count, acceptance_rate)
         VALUES (?, ?, ?, 'copilot', 'api', 'high', 1, 30, ?, ?)`,
    ).run(`${developer}-${date}-copilot`, developer, date, Math.round(30 * rate), rate);
}

/** Seed a month of git activity (churn + AI signature) for a developer. */
function seedGitMonth(
    db: Database.Database,
    developer: string,
    provider: string,
    opts: {churn?: number; aiScore?: number} = {},
): void {
    for (let d = 1; d <= 20; d++) {
        const dd = String(d).padStart(2, '0');
        seedGitSnapshot(db, {
            developer,
            date: day(dd),
            provider,
            commits: 2,
            linesAdded: 120,
            linesRemoved: 40,
            churn: opts.churn ?? 0.3,
            aiScore: opts.aiScore ?? 0.8,
        });
    }
}

/** Seed four PRs for a developer: two come back for changes (rework rate 0.5). */
function seedPRSet(db: Database.Database, developer: string, provider: string): void {
    seedPR(db, {developer, provider, prId: `${developer}-1`, createdDay: day('05'), changesRequested: 1});
    seedPR(db, {developer, provider, prId: `${developer}-2`, createdDay: day('07'), changesRequested: 2});
    seedPR(db, {developer, provider, prId: `${developer}-3`, createdDay: day('09'), changesRequested: 0});
    seedPR(db, {developer, provider, prId: `${developer}-4`, createdDay: day('11'), changesRequested: 0});
}

/**
 * Seed the full Phase 5 world: a frontend team large enough to clear the
 * k-anonymity floor (three PR contributors across GitHub/Bitbucket/GitLab), a
 * git-only developer for Pillar 1, a thin backend team that must stay suppressed,
 * and the auth accounts. Then run the two real engines (PR/review metrics +
 * available-data signals) for the period so the read surfaces have data.
 */
async function seedWorld(db: Database.Database): Promise<World> {
    seedTeam(db, 'frontend', 'manager@wmg.test');
    seedTeam(db, 'backend', 'manager@wmg.test');

    // Frontend: three PR contributors on three different git providers + a viewer.
    seedDeveloper(db, {id: 'amelia', team: 'frontend', email: 'amelia@wmg.test'});
    seedDeveloper(db, {id: 'bianca', team: 'frontend', email: 'bianca@wmg.test'});
    seedDeveloper(db, {id: 'cyrus', team: 'frontend', email: 'cyrus@wmg.test'});
    seedDeveloper(db, {id: 'vera', team: 'frontend', email: 'vera@wmg.test'});
    // Backend: a git-only developer (Pillar 1) and a single PR contributor (must
    // keep the backend PR aggregate below the cohort floor).
    seedDeveloper(db, {id: 'gilbert', team: 'backend', email: 'gilbert@wmg.test'});
    seedDeveloper(db, {id: 'bob', team: 'backend', email: 'bob@wmg.test'});

    // Git + tool activity. amelia/bianca/cyrus on the three providers; high churn
    // + AI signature so both PR variants populate and the combined signal is real.
    seedGitMonth(db, 'amelia', 'github');
    seedGitMonth(db, 'bianca', 'bitbucket');
    seedGitMonth(db, 'cyrus', 'gitlab');
    seedGitMonth(db, 'bob', 'github');
    // gilbert is GIT-ONLY: git activity, deliberately no tool_snapshots.
    seedGitMonth(db, 'gilbert', 'gitlab');

    for (const dev of ['amelia', 'bianca', 'cyrus'] as const) {
        for (let d = 1; d <= 20; d++) {
            seedToolSnapshot(db, {
                developer: dev,
                date: day(String(d).padStart(2, '0')),
                tool: 'claude_code',
                interactions: 30,
                acceptances: 18,
                quality: 'high',
            });
        }
    }

    // amelia additionally has measured acceptance_rate this period AND the prior
    // month (the baseline the trend compares against), so her Pillar-1 surface
    // carries a real `acceptance_trend` — the positive control that makes
    // git-only gilbert's absence of that signal a true contrast, not a universal
    // null. 0.5 → 0.6 is a rising trend (delta ≥ the 0.05 threshold).
    const priorM = priorMonth(PERIOD);
    for (let d = 1; d <= 20; d++) {
        const dd = String(d).padStart(2, '0');
        seedAcceptanceSnapshot(db, 'amelia', `${PERIOD}-${dd}`, 0.6);
        seedAcceptanceSnapshot(db, 'amelia', `${priorM}-${dd}`, 0.5);
    }

    // PRs: three frontend contributors (clears floor of 3) + one backend (bob).
    seedPRSet(db, 'amelia', 'github');
    seedPRSet(db, 'bianca', 'bitbucket');
    seedPRSet(db, 'cyrus', 'gitlab');
    seedPRSet(db, 'bob', 'github');

    // Auth accounts: a manager (admin, no developer link) + developer accounts.
    await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
    await createAccount(db, {email: 'amelia@wmg.test', role: 'developer', developerId: 'amelia'});
    await createAccount(db, {email: 'gilbert@wmg.test', role: 'developer', developerId: 'gilbert'});
    await createAccount(db, {email: 'vera@wmg.test', role: 'developer', developerId: 'vera'});
    await createAccount(db, {email: 'bob@wmg.test', role: 'developer', developerId: 'bob'});

    // Run the real engines for the period.
    computePRReviewMetricsForPeriod(db, 'monthly', PERIOD);
    generateCoachingSignalsForPeriod(db, 'monthly', PERIOD);

    const userIds: Record<string, string> = {};
    for (const dev of ['amelia', 'gilbert', 'vera', 'bob'] as const) {
        userIds[dev] = getActiveUserByEmail(db, `${dev}@wmg.test`)!.id;
    }
    return {userIds};
}

// ── a recording cloud analyser (no external model is ever called) ─────────────

class FakeCloudAnalyzer implements RetrospectiveAnalyzer {
    location = 'cloud' as const;
    model = 'cloud-test-model';
    called = false;
    lastPlaintext = '';
    analyze(input: SessionAnalysisInput): AnalysisResult {
        this.called = true;
        this.lastPlaintext = input.plaintext;
        return {retrospectiveText: 'cloud narrative', highlights: {worked: ['w'], improve: ['i']}};
    }
    followUp(): string {
        return 'cloud follow-up answer';
    }
}

function buildAnalyzers(): {analyzers: RetrospectiveAnalyzers; cloud: FakeCloudAnalyzer} {
    const cloud = new FakeCloudAnalyzer();
    return {analyzers: {local: new LocalHeuristicAnalyzer(), cloud}, cloud};
}

/** Mount the full Phase 5 API surface, wiring the recording cloud analyser. */
async function buildPhase5App(
    db: Database.Database,
    analyzers: RetrospectiveAnalyzers,
): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    app.get('/health', async () => ({status: 'ok'}));
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerCoachingRoutes(app, db);
    registerManagerCoachingRoutes(app, db);
    registerCaptureRoutes(app, db);
    registerKeyRoutes(app, db);
    registerRealtimeCoachingRoutes(app, db);
    registerRetrospectiveRoutes(app, db, analyzers);
    registerShowcaseRoutes(app, db);
    registerShowcaseAdminRoutes(app, db);
    await app.ready();
    return app;
}

// Opt a developer into prompt capture: the org must permit it AND the developer
// must turn it on (the double condition the capture gate resolves live).
function optIntoCapture(db: Database.Database, userId: string): void {
    setGlobalSetting(db, 'coaching_capture_permitted', true);
    setDeveloperPreference(db, userId, 'capture_opt_in', true);
}

// ── shared fixtures ───────────────────────────────────────────────────────────

let db: Database.Database;
let app: FastifyInstance;
let world: World;
let cloud: FakeCloudAnalyzer;

beforeEach(async () => {
    db = makeIntegrationDb();
    world = await seedWorld(db);
    const built = buildAnalyzers();
    cloud = built.cloud;
    app = await buildPhase5App(db, built.analyzers);
});

afterEach(async () => {
    await app.close();
    db.close();
});

/** GET a route as `token`, parsing the JSON body into the caller-declared shape `T`. */
async function get<T>(url: string, token: string): Promise<{status: number; body: T}> {
    const res = await app.inject({method: 'GET', url, headers: authHeaders(token)});
    return {status: res.statusCode, body: JSON.parse(res.body) as T};
}

/** POST `payload` to a route as `token`; returns the status, parsed body, and raw text. */
async function post<T>(
    url: string,
    token: string,
    payload: unknown,
): Promise<{status: number; body: T; raw: string}> {
    const res = await app.inject({method: 'POST', url, headers: authHeaders(token), payload});
    return {status: res.statusCode, body: JSON.parse(res.body) as T, raw: res.body};
}

// ── 1. Pillar 2 E2E — PR/review across GitHub/Bitbucket/GitLab ─────────────────

describe('Phase 5 E2E (5.12): Pillar 2 — PR/review outcome coaching', () => {
    it('serves a developer their own private trajectory, both variants kept separate', async () => {
        const token = await login(app, 'amelia@wmg.test');
        const {status, body} = await get<Envelope<PRCoaching>>('/api/me/pr-coaching', token);
        expect(status).toBe(200);
        expect(body.data.enabled).toBe(true);
        // Both scope variants are present as separate trajectories (the factual /
        // inferred labelling itself is asserted once, in the privacy-gate test).
        expect(body.data.all_pr).toBeDefined();
        expect(body.data.ai_assisted).toBeDefined();
        // The current period carries this developer's four PRs.
        expect(periodPoint(body.data.all_pr!, PERIOD).prs_total).toBe(4);
    });

    it('pools a manager team aggregate that clears the k-anonymity floor — and exposes no individual', async () => {
        const token = await login(app, 'manager@wmg.test');
        const {status, body} = await get<Envelope<PRCoaching>>('/api/coaching/pr-review/team/frontend', token);
        expect(status).toBe(200);
        expect(body.data.enabled).toBe(true);
        const point = periodPoint(body.data.all_pr!, PERIOD);
        // Three contributors pooled → not suppressed, pooled PR total = 12.
        expect(point.suppressed).toBe(false);
        expect(point.developers).toBe(3);
        expect(point.prs_total).toBe(12);
        // STRUCTURAL guard: a point carries exactly the pooled team fields — the
        // contributor COUNT (`developers`) but no per-developer collection. If a
        // future change added an individual breakdown (the real leak vector), the
        // key set would change and this fails. Stronger than an id-substring scan,
        // which can only catch a leak that happens to embed the id string.
        expect(Object.keys(point as Record<string, unknown>).sort()).toEqual([
            'avg_churn', 'avg_comment_density', 'avg_review_rounds', 'avg_time_to_merge_hours',
            'combined_signal', 'developers', 'period', 'prs_total', 'review_rejection_rate',
            'rework_rate', 'suppressed',
        ]);
        // And no individual developer id appears anywhere in the payload.
        const raw = JSON.stringify(body);
        for (const id of ['amelia', 'bianca', 'cyrus']) {
            expect(raw).not.toContain(id);
        }
    });

    it('covers all three git providers in the org aggregate', async () => {
        // amelia=github, bianca=bitbucket, cyrus=gitlab all flow into the same
        // pooled org metric, proving provider-agnostic ingestion end to end.
        const providers = db
            .prepare('SELECT DISTINCT provider FROM pr_records ORDER BY provider')
            .all() as Array<{provider: string}>;
        expect(providers.map((p) => p.provider)).toEqual(['bitbucket', 'github', 'gitlab']);

        const token = await login(app, 'manager@wmg.test');
        const {status, body} = await get<Envelope<PRCoaching>>('/api/coaching/pr-review/org', token);
        expect(status).toBe(200);
        const point = periodPoint(body.data.all_pr!, PERIOD);
        expect(point.suppressed).toBe(false);
        expect(point.developers).toBe(4); // amelia, bianca, cyrus, bob
    });
});

// ── 2. Pillar 1 E2E — available-data coaching for a git-only developer ─────────

describe('Phase 5 E2E (5.12): Pillar 1 — available-data coaching (git-only)', () => {
    it('gives a git-only developer useful private coaching with no faked tool signals', async () => {
        const token = await login(app, 'gilbert@wmg.test');
        const {status, body} = await get<Envelope<AvailableCoaching>>('/api/me/coaching', token);
        expect(status).toBe(200);
        expect(body.data.enabled).toBe(true);
        const signals = body.data.signals;
        expect(signals.length).toBeGreaterThan(0);
        // A git-only developer gets a personal insight grounded in git activity…
        const insight = signals.find((s) => s.signal_type === 'personal_insight');
        expect(insight).toBeDefined();
        expect(insight!.basis).toBe('git_estimate');
        // …and NO acceptance trend is faked (that signal needs tool data, honestly absent).
        expect(signals.some((s) => s.signal_type === 'acceptance_trend')).toBe(false);
    });

    it('DOES surface a measured acceptance trend for a developer who has tool data (positive control)', async () => {
        // The contrast that makes the git-only absence above meaningful: amelia has
        // measured acceptance_rate this period + a prior baseline, so her surface
        // carries a real `acceptance_trend` (basis `measured`). If this signal could
        // never fire for anyone, the git-only "honestly absent" assertion would be
        // vacuous — this proves the signal CAN fire, so gilbert's null is a true
        // tier-aware contrast, not a universal blank.
        const token = await login(app, 'amelia@wmg.test');
        const {body} = await get<Envelope<AvailableCoaching>>('/api/me/coaching', token);
        const acceptance = body.data.signals.find((s) => s.signal_type === 'acceptance_trend');
        expect(acceptance).toBeDefined();
        expect(acceptance!.basis).toBe('measured');
    });

    it('exposes the available-data team aggregate to a manager without any observation text', async () => {
        const token = await login(app, 'manager@wmg.test');
        const {status, body} = await get<Envelope<unknown>>('/api/coaching/available/team/frontend', token);
        expect(status).toBe(200);
        // The aggregate is counts + categories only — never the private sentence.
        // These markers are FRAGMENTS OF THE REAL observation text the frontend
        // developers' own signals carry (high-tier personal insight "...you were
        // active on N day(s)...", the rising acceptance-trend sentence) — so the
        // assertion would actually fail if the read layer ever started selecting
        // the `observation` column into the manager aggregate.
        const raw = JSON.stringify(body);
        expect(raw).not.toContain('you were active');
        expect(raw).not.toContain('acceptance rate has climbed');
        expect(raw).not.toContain('estimated from your git activity');
    });
});

// ── 3. Pillar 3 E2E — opt-in capture → loop/nudge → retrospective → recovery ───

describe('Phase 5 E2E (5.12): Pillar 3 — opt-in prompt capture pipeline', () => {
    let key: Buffer;
    let token: string;

    beforeEach(async () => {
        key = generateDeveloperKey();
        optIntoCapture(db, world.userIds.amelia);
        token = await login(app, 'amelia@wmg.test');
    });

    function payload(mechanism: 'local_agent' | 'editor_extension', sessionId = 'sess-amelia'): CaptureWirePayload {
        return buildCapturePayload(
            {key, keyId: 'k1', mechanism},
            {sessionId, plaintext: `prompt: ${SECRET}`, capturedAt: new Date().toISOString(), tool: 'claude_code', promptCount: 1},
        );
    }

    it('captures via BOTH mechanisms once opted in, and refuses capture when not opted in', async () => {
        const agent = await post<Envelope<unknown>>('/api/me/captures', token, payload('local_agent'));
        expect(agent.status).toBe(201);
        const ext = await post<Envelope<unknown>>('/api/me/captures', token, payload('editor_extension'));
        expect(ext.status).toBe(201);

        // A developer who never opted in is inert (403) — capture is strict opt-in.
        const gilbertToken = await login(app, 'gilbert@wmg.test');
        const blocked = await post<Envelope<unknown>>('/api/me/captures', gilbertToken, payload('local_agent', 'sess-gil'));
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('capture_not_enabled');
    });

    it('rejects any body carrying apparent plaintext (encryption is the client’s job)', async () => {
        const bad = {...payload('local_agent'), plaintext: 'leaking content'};
        const res = await post<Envelope<unknown>>('/api/me/captures', token, bad);
        expect(res.status).toBe(400);
    });

    it('runs the local real-time coach and stores loop/nudge METADATA only', async () => {
        // Drive the REAL local coach: three identical prompts → a loop + a nudge.
        const coach = new RealtimeCoach({
            settings: {enabled: true, frequency: 'high', dismissible: true},
            sessionId: 'sess-amelia',
            loop: {similarityThreshold: 0.6, minSimilar: 3, windowSize: 10},
        });
        coach.observePrompt(SECRET);
        coach.observePrompt(SECRET);
        const result = coach.observePrompt(SECRET);
        expect(result!.loopEvent!.similarPromptCount).toBe(3);

        const loop = await post<Envelope<unknown>>('/api/me/coaching/loop-events', token, {
            session_id: 'sess-amelia',
            similar_prompt_count: result!.loopEvent!.similarPromptCount,
        });
        expect(loop.status).toBe(201);
        const nudge = await post<Envelope<unknown>>('/api/me/coaching/nudge-events', token, {
            session_id: 'sess-amelia',
            nudge_type: 'repeated_prompt',
        });
        expect(nudge.status).toBe(201);

        // Read back: metadata present, prompt text nowhere on the wire.
        const loops = await get<Envelope<Array<{similarPromptCount: number}>>>('/api/me/coaching/loop-events', token);
        expect(loops.body.data[0].similarPromptCount).toBe(3);
        expect(JSON.stringify(loops.body)).not.toContain('SUPERSECRETMARKER');
    });

    it('generates a LOCAL-default retrospective; cloud requires the second opt-in', async () => {
        await post<Envelope<unknown>>('/api/me/captures', token, payload('local_agent'));

        // Default location: local model, prompts never leave org infrastructure.
        const local = await post<Envelope<{analysisLocation: string; analysisModel: string}>>(
            '/api/me/retrospectives', token, {session_id: 'sess-amelia', key: key.toString('base64')},
        );
        expect(local.status).toBe(201);
        expect(local.body.data.analysisLocation).toBe('local');
        expect(local.body.data.analysisModel).toBe('local-default');

        // Cloud requested but the developer has NOT taken opt-in #2 → blocked, and
        // the cloud analyser is never invoked (no plaintext leaves for a forbidden run).
        const blocked = await post<Envelope<unknown>>('/api/me/retrospectives', token, {
            session_id: 'sess-amelia',
            key: key.toString('base64'),
            analysis_location: 'cloud',
        });
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('cloud_not_allowed');
        expect(cloud.called).toBe(false);

        // Take BOTH opt-in #2 conditions: org permits cloud AND developer opts in.
        setGlobalSetting(db, 'coaching_cloud_analysis_permitted', true);
        setDeveloperPreference(db, world.userIds.amelia, 'cloud_analysis_opt_in', true);
        const allowed = await post<Envelope<{analysisLocation: string}>>('/api/me/retrospectives', token, {
            session_id: 'sess-amelia',
            key: key.toString('base64'),
            analysis_location: 'cloud',
        });
        expect(allowed.status).toBe(201);
        expect(allowed.body.data.analysisLocation).toBe('cloud');
        expect(cloud.called).toBe(true);
    });

    it('runs the key-recovery flow and logs every recovery event visibly to the developer', async () => {
        const secret = 'amelia-recovery-secret-phrase';
        const wrapped = wrapCaptureKey(key, secret);
        // Register a recovery_path key (the server stores only the wrapped blob).
        const setup = await post<Envelope<unknown>>('/api/me/capture-key', token, {
            key_id: 'k1',
            recovery_choice: 'recovery_path',
            recovery_blob: wrapped.recovery_blob.toString('base64'),
            recovery_meta: wrapped.meta,
        });
        expect(setup.status).toBe(201);

        // Initiate recovery: the server hands back the opaque blob (logged), and the
        // client can unwrap it locally to get the real key back — the server never could.
        const initiate = await post<Envelope<RecoveryInitiate>>('/api/me/capture-key/recovery/initiate', token, {});
        expect(initiate.status).toBe(200);
        const recovered = unwrapCaptureKey(
            Buffer.from(initiate.body.data.recovery_blob, 'base64'),
            initiate.body.data.recovery_meta,
            secret,
        );
        expect(recovered.equals(key)).toBe(true);

        // Report the outcome, then read the developer-visible audit log.
        const complete = await post<Envelope<unknown>>('/api/me/capture-key/recovery/complete', token, {outcome: 'completed'});
        expect(complete.status).toBe(200);
        const log = await get<Envelope<Array<{event: string}>>>('/api/me/capture-key/recovery-log', token);
        const events = log.body.data.map((e) => e.event);
        expect(events).toContain('recovery_initiated');
        expect(events).toContain('recovery_completed');
    });
});

// ── 4. Showcase E2E — promote → redact → publish → browse → unpublish → remove ─

describe('Phase 5 E2E (5.12): Showcase — deliberate promote/redact/publish', () => {
    let key: Buffer;
    let token: string;
    let retroId: string;

    beforeEach(async () => {
        key = generateDeveloperKey();
        optIntoCapture(db, world.userIds.amelia);
        setGlobalSetting(db, 'showcase_enabled', true);
        token = await login(app, 'amelia@wmg.test');
        // A captured session + a retrospective to promote from.
        await post<Envelope<unknown>>('/api/me/captures', token, buildCapturePayload(
            {key, keyId: 'k1', mechanism: 'local_agent'},
            {sessionId: 'sess-amelia', plaintext: `prompt: ${SECRET}`, capturedAt: new Date().toISOString(), tool: 'claude_code', promptCount: 1},
        ));
        const retro = await post<Envelope<{id: string}>>('/api/me/retrospectives', token, {session_id: 'sess-amelia', key: key.toString('base64')});
        retroId = retro.body.data.id;
    });

    it('promotes (transient decrypt) → publishes redacted → others browse; the private capture is untouched', async () => {
        const captureCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM prompt_captures').get() as {n: number}).n;
        const before = captureCount();

        // Promote: transiently decrypt the owner's own session into an editable draft.
        const draft = await post<Envelope<{draft: string}>>('/api/me/showcase/draft', token, {retrospective_id: retroId, key: key.toString('base64')});
        expect(draft.status).toBe(200);
        expect(draft.body.data.draft).toContain('SUPERSECRETMARKER'); // owner sees their plaintext to redact

        // Publish requires the redaction acknowledgement — without it, refused.
        const noAck = await post<Envelope<unknown>>('/api/me/showcase', token, {
            retrospective_id: retroId, scope: 'team', title: 'Nice refactor', content: '[redacted] a clean refactor',
        });
        expect(noAck.status).toBe(400);

        // Publish the OWNER-redacted content (no secret) to the team showcase.
        const published = await post<Envelope<{id: string}>>('/api/me/showcase', token, {
            retrospective_id: retroId,
            scope: 'team',
            title: 'Nice refactor',
            content: '[redacted] a clean refactor with good iterative prompting',
            redaction_acknowledged: true,
        });
        expect(published.status).toBe(201);

        // The private capture store is untouched by publishing — nothing auto-harvested.
        expect(captureCount()).toBe(before);

        // A teammate browses the showcase and sees the redacted content (no secret).
        const veraToken = await login(app, 'vera@wmg.test');
        const browse = await get<Envelope<unknown[]>>('/api/me/showcase/browse', veraToken);
        expect(browse.body.data.length).toBe(1);
        expect(JSON.stringify(browse.body)).not.toContain('SUPERSECRETMARKER');
    });

    it('lets the owner unpublish, and a lead remove (with author notice) — but a lead can never publish', async () => {
        const publish = (title: string): Promise<{status: number; body: Envelope<{id: string}>; raw: string}> =>
            post<Envelope<{id: string}>>('/api/me/showcase', token, {
                retrospective_id: retroId, scope: 'team', title, content: `[redacted] ${title}`, redaction_acknowledged: true,
            });
        const a = await publish('Example A');
        const b = await publish('Example B');

        // Owner unpublishes A — gone from browse.
        const unpub = await post<Envelope<unknown>>(`/api/me/showcase/${a.body.data.id}/unpublish`, token, {});
        expect(unpub.status).toBe(200);

        // A lead removes B from the team showcase (remove is the only admin verb).
        const managerToken = await login(app, 'manager@wmg.test');
        const removed = await post<Envelope<unknown>>(`/api/admin/showcase/${b.body.data.id}/remove`, managerToken, {team: 'frontend', reason: 'off topic'});
        expect(removed.status).toBe(200);

        // The author is notified of the lead removal via their own notice feed.
        const notices = await get<Envelope<unknown[]>>('/api/me/showcase/removals', token);
        expect(notices.body.data.length).toBe(1);

        // After unpublish + remove, browse is empty for a teammate.
        const veraToken = await login(app, 'vera@wmg.test');
        const browse = await get<Envelope<unknown[]>>('/api/me/showcase/browse', veraToken);
        expect(browse.body.data.length).toBe(0);
    });
});

// ── 5. PRIVACY VERIFICATION — the gate ─────────────────────────────────────────

describe('Phase 5 privacy verification (5.12): the gate', () => {
    it('NO individual coaching signal is reachable by a manager/admin anywhere', async () => {
        const managerToken = await login(app, 'manager@wmg.test');
        // The only individual coaching paths are /api/me/*; a manager has no
        // developer profile, so every one of them is 404 — never a leak.
        for (const url of ['/api/me/pr-coaching', '/api/me/coaching', '/api/me/retrospectives', '/api/me/captures', '/api/me/coaching/loop-events']) {
            const {status} = await get<Envelope<unknown>>(url, managerToken);
            expect(status).toBe(404);
        }
        // And a developer cannot reach the manager aggregate surfaces — the session
        // middleware confines the developer role to /api/me (403 elsewhere).
        const ameliaToken = await login(app, 'amelia@wmg.test');
        for (const url of ['/api/coaching/pr-review/org', '/api/coaching/available/org', '/api/coaching/manager/org', '/api/admin/showcase']) {
            const {status} = await get<Envelope<unknown>>(url, ameliaToken);
            expect(status).toBe(403);
        }
    });

    it('capture plaintext is never persisted or logged server-side', async () => {
        const key = generateDeveloperKey();
        optIntoCapture(db, world.userIds.amelia);
        const token = await login(app, 'amelia@wmg.test');
        await post<Envelope<unknown>>('/api/me/captures', token, buildCapturePayload(
            {key, keyId: 'k1', mechanism: 'local_agent'},
            {sessionId: 'sess-amelia', plaintext: `prompt: ${SECRET}`, capturedAt: new Date().toISOString(), tool: 'claude_code'},
        ));
        // A full dump of every capture-bearing table — with BLOB columns decoded —
        // contains no plaintext marker. Decoding the ciphertext blob is what makes
        // this catch an "encryption bypassed, plaintext stored in the blob" regression.
        const dump = rowsToSearchableText([
            ...(db.prepare('SELECT * FROM prompt_captures').all() as Array<Record<string, unknown>>),
            ...(db.prepare('SELECT * FROM loop_events').all() as Array<Record<string, unknown>>),
            ...(db.prepare('SELECT * FROM nudge_events').all() as Array<Record<string, unknown>>),
        ]);
        expect(dump).not.toContain('SUPERSECRETMARKER');
    });

    it('the server cannot decrypt captures on its own — no key material is ever stored', async () => {
        const key = generateDeveloperKey();
        optIntoCapture(db, world.userIds.amelia);
        const token = await login(app, 'amelia@wmg.test');
        await post<Envelope<unknown>>('/api/me/captures', token, buildCapturePayload(
            {key, keyId: 'k1', mechanism: 'local_agent'},
            {sessionId: 'sess-amelia', plaintext: `prompt: ${SECRET}`, capturedAt: new Date().toISOString()},
        ));
        // Register a recovery key, then verify NO table holds the raw capture key.
        const wrapped = wrapCaptureKey(key, 'a recovery secret');
        await post<Envelope<unknown>>('/api/me/capture-key', token, {
            key_id: 'k1', recovery_choice: 'recovery_path',
            recovery_blob: wrapped.recovery_blob.toString('base64'), recovery_meta: wrapped.meta,
        });
        // Decode the BLOB columns (ciphertext, recovery_blob) too: the raw key must
        // be absent even as raw bytes, so a regression that stored the unwrapped key
        // in recovery_blob would be caught — not hidden behind Buffer JSON encoding.
        const dump = rowsToSearchableText([
            ...(db.prepare('SELECT * FROM prompt_captures').all() as Array<Record<string, unknown>>),
            ...(db.prepare('SELECT * FROM capture_keys').all() as Array<Record<string, unknown>>),
        ]);
        expect(dump).not.toContain(key.toString('base64'));
        expect(dump).not.toContain(key.toString('hex'));
        expect(dump).not.toContain(key.toString('latin1'));
    });

    it('enforces the min-group-size guard on a thin team aggregate', async () => {
        const managerToken = await login(app, 'manager@wmg.test');
        // backend has a single PR contributor (bob) → below the cohort floor of 3.
        const {body} = await get<Envelope<PRCoaching>>('/api/coaching/pr-review/team/backend', managerToken);
        const point = periodPoint(body.data.all_pr!, PERIOD);
        expect(point.suppressed).toBe(true);
        expect(point.developers).toBeNull();
        // Crucially, bob's own number never leaks through the suppressed point.
        expect(JSON.stringify(body)).not.toContain('bob');
    });

    it('keeps all-PR (factual) and AI-assisted (inferred) variants clearly separated and labelled', async () => {
        const token = await login(app, 'amelia@wmg.test');
        const {body} = await get<Envelope<PRCoaching>>('/api/me/pr-coaching', token);
        // Distinct keys, distinct bases — the inferred view is never presented as fact.
        expect(body.data.all_pr!.scope_variant).toBe('all_pr');
        expect(body.data.all_pr!.basis).toBe('factual');
        expect(body.data.ai_assisted!.scope_variant).toBe('ai_assisted_pr');
        expect(body.data.ai_assisted!.basis).toBe('inferred');
    });

    it('disabling a coaching pillar org-wide hides it on the developer surface', async () => {
        setGlobalSetting(db, 'coaching_pillar2_enabled', false);
        const token = await login(app, 'amelia@wmg.test');
        const {body} = await get<Envelope<PRCoaching>>('/api/me/pr-coaching', token);
        expect(body.data.enabled).toBe(false);
        expect(body.data.all_pr).toBeUndefined();
    });
});

// ── 6. Dogfood — Pillar 2 signals on the WMG-shaped data are sane ──────────────

describe('Phase 5 dogfood (5.12): Pillar 2 signals are sane on git-only WMG data', () => {
    it('reads a developer struggling with AI output as high churn + high rejection', async () => {
        // amelia's seeded shape: high churn (0.3 ≥ 0.2) + rework on 2 of 4 PRs
        // (rejection 0.5 ≥ 0.3) → the engine's "struggling" combined signal, the
        // exact coaching opportunity the pillar exists to surface. A sanity check
        // that the numbers a developer would see match the work that produced them.
        const token = await login(app, 'amelia@wmg.test');
        const {body} = await get<Envelope<PRCoaching>>('/api/me/pr-coaching', token);
        const point = periodPoint(body.data.all_pr!, PERIOD);
        expect(point.review_rejection_rate).toBeCloseTo(0.5, 5);
        expect(point.avg_churn).toBeCloseTo(0.3, 5);
        expect(point.combined_signal).toBe('struggling');
        // The AI-assisted variant also has all four PRs (AI signature 0.8 ≥ 0.5),
        // so the inferred view is populated and separately labelled.
        expect(periodPoint(body.data.ai_assisted!, PERIOD).prs_total).toBe(4);
    });
});
