import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerShowcaseAuthoringRoutes} from '../../src/dashboard/api/showcase-authoring';
import {registerShowcaseBrowseRoutes} from '../../src/dashboard/api/showcase-browse';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {getContribution} from '../../src/contributions/store';
import {getShowcaseUnit} from '../../src/showcase/unitsStore';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-07-01T00:00:00.000Z';
const CONVERSATION = '[{"id":"t0","role":"user","text":"how do I refactor?"},{"id":"t1","role":"assistant","text":"write a failing test first"}]';

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(name, NOW);
}

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        NOW,
    );
}

function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return match ? decodeURIComponent(match[1]) : '';
}

function auth(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

describe('Showcase authoring/publish API (#189)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string; // developer, team eng, the author throughout
    let bobToken: string; // developer, team data, a non-owner
    let adminToken: string; // admin (no developer profile)

    async function boot(): Promise<void> {
        app = Fastify();
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerShowcaseAuthoringRoutes(app, db);
        registerShowcaseBrowseRoutes(app, db);
        await app.ready();
        const login = async (email: string): Promise<string> =>
            cookieToken(await app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password: PASSWORD}}));
        aliceToken = await login('alice@test.com');
        bobToken = await login('bob@test.com');
        adminToken = await login('admin@test.com');
    }

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        seedTeam(db, 'eng');
        seedTeam(db, 'data');
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'data');
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin', developerId: null});
        await boot();
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // --- helpers ---------------------------------------------------------------

    async function draft(token: string, over: Record<string, unknown> = {}): Promise<{statusCode: number; id: string; json: () => Record<string, unknown>}> {
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/showcase-units',
            headers: auth(token),
            payload: {title: 'Refactor', conversation: CONVERSATION, curators_note: 'take away this', scope: 'org', ...over},
        });
        return {statusCode: res.statusCode, id: res.json()?.data?.contribution?.id, json: () => res.json()};
    }

    // Drive the whole pipeline for `alice` and return the published showcase id.
    async function publishFullPipeline(): Promise<string> {
        const d = await draft(aliceToken, {outcome_link: 'https://example.com/pr/42'});
        expect(d.statusCode).toBe(201);
        const id = d.id;

        const annotate = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/annotations`,
            headers: auth(aliceToken),
            payload: {turn_ref: 't1', body: 'gave it the failing test first on purpose'},
        });
        expect(annotate.statusCode).toBe(201);

        const scrub = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/scrub`, headers: auth(aliceToken)});
        expect(scrub.statusCode).toBe(200);

        const submit = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/submit`, headers: auth(aliceToken)});
        expect(submit.statusCode).toBe(200);
        expect(submit.json().data.state).toBe('submitted');

        const approve = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/approve`,
            headers: auth(aliceToken),
            payload: {visibility_scope: 'org'},
        });
        expect(approve.statusCode).toBe(200);

        const confirm = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/confirm-review`,
            headers: auth(aliceToken),
            payload: {note: 'looks clean'},
        });
        expect(confirm.statusCode).toBe(200);

        const publish = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/publish`, headers: auth(aliceToken)});
        expect(publish.statusCode).toBe(200);
        expect(publish.json().data.state).toBe('published');
        return id;
    }

    // --- full happy path -------------------------------------------------------

    it('drives the whole pipeline through the routes and the result is browseable', async () => {
        const id = await publishFullPipeline();

        // Read it back THROUGH the browse API (real DTO round-trip, not a fixture).
        const detail = await app.inject({method: 'GET', url: `/api/me/showcase-units/${id}`, headers: auth(aliceToken)});
        expect(detail.statusCode).toBe(200);
        const d = detail.json().data;
        expect(d.title).toBe('Refactor');
        expect(d.curatorsNote).toBe('take away this');
        expect(d.outcomeLink).toBe('https://example.com/pr/42');
        expect(d.hasOutcomeLink).toBe(true);
        // The inline annotation anchored to turn t1 round-trips.
        const t1 = d.display.turns.find((t: {turnRef: string}) => t.turnRef === 't1');
        expect(t1.annotations.map((a: {body: string}) => a.body)).toEqual(['gave it the failing test first on purpose']);

        const browse = await app.inject({method: 'GET', url: '/api/me/showcase-units/browse', headers: auth(aliceToken)});
        expect(browse.json().data.showcases.map((s: {title: string}) => s.title)).toEqual(['Refactor']);
    });

    // --- auth + ownership ------------------------------------------------------

    it('requires authentication to draft', async () => {
        const res = await app.inject({method: 'POST', url: '/api/me/showcase-units', payload: {}});
        expect(res.statusCode).toBe(401);
    });

    it('an admin with no developer profile cannot author (404 from /api/me)', async () => {
        const res = await draft(adminToken);
        expect(res.statusCode).toBe(404);
    });

    it('every :id route requires authentication (401 without a session)', async () => {
        const d = await draft(aliceToken);
        const id = d.id;
        const routes: Array<[string, string]> = [
            ['POST', `/api/me/showcase-units/${id}/annotations`],
            ['POST', `/api/me/showcase-units/${id}/scrub`],
            ['GET', `/api/me/showcase-units/${id}/review-panel`],
            ['POST', `/api/me/showcase-units/${id}/redact`],
            ['POST', `/api/me/showcase-units/${id}/submit`],
            ['POST', `/api/me/showcase-units/${id}/approve`],
            ['POST', `/api/me/showcase-units/${id}/confirm-review`],
            ['POST', `/api/me/showcase-units/${id}/publish`],
        ];
        for (const [method, url] of routes) {
            const res = await app.inject({method: method as 'GET' | 'POST', url, payload: {}});
            expect(res.statusCode, `${method} ${url}`).toBe(401);
        }
    });

    it('a non-owner gets a uniform 404 on every :id action (no leak of existence)', async () => {
        const d = await draft(aliceToken);
        const id = d.id;
        const asBob = auth(bobToken);
        const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
            ['POST', `/api/me/showcase-units/${id}/annotations`, {turn_ref: 't1', body: 'x'}],
            ['POST', `/api/me/showcase-units/${id}/scrub`, undefined],
            ['GET', `/api/me/showcase-units/${id}/review-panel`, undefined],
            ['POST', `/api/me/showcase-units/${id}/redact`, {redacted_conversation: CONVERSATION}],
            ['POST', `/api/me/showcase-units/${id}/submit`, undefined],
            ['POST', `/api/me/showcase-units/${id}/approve`, {visibility_scope: 'org'}],
            ['POST', `/api/me/showcase-units/${id}/confirm-review`, undefined],
            ['POST', `/api/me/showcase-units/${id}/publish`, undefined],
        ];
        for (const [method, url, payload] of cases) {
            const res = await app.inject({method: method as 'GET' | 'POST', url, headers: asBob, payload});
            expect(res.statusCode, `${method} ${url}`).toBe(404);
        }
        // Alice's draft is untouched (still a draft).
        expect(getContribution(db, id)?.state).toBe('draft');
    });

    // --- draft validation ------------------------------------------------------

    it('rejects a draft missing the mandatory curators note (400)', async () => {
        const res = await draft(aliceToken, {curators_note: '   '});
        expect(res.statusCode).toBe(400);
    });

    it('rejects a draft with an unknown scope, an unknown key, and a non-object body (400)', async () => {
        expect((await draft(aliceToken, {scope: 'galaxy'})).statusCode).toBe(400);
        const unknownKey = await app.inject({
            method: 'POST',
            url: '/api/me/showcase-units',
            headers: auth(aliceToken),
            payload: {title: 'T', conversation: CONVERSATION, curators_note: 'n', scope: 'org', surprise: 1},
        });
        expect(unknownKey.statusCode).toBe(400);
        const notObject = await app.inject({method: 'POST', url: '/api/me/showcase-units', headers: auth(aliceToken), payload: []});
        expect(notObject.statusCode).toBe(400);
    });

    it('pins a team-scoped draft to the author’s OWN team (client cannot name another team)', async () => {
        const res = await draft(aliceToken, {scope: 'team'});
        expect(res.statusCode).toBe(201);
        expect(getContribution(db, res.id)?.scopeTarget).toBe('eng');
    });

    // --- SEC-1: outcome-link scheme validation --------------------------------

    it('rejects a javascript:/data: outcome link at the route (400) and never stores it', async () => {
        // eslint-disable-next-line no-script-url
        const js = await draft(aliceToken, {outcome_link: 'javascript:alert(1)'});
        expect(js.statusCode).toBe(400);
        const data = await draft(aliceToken, {outcome_link: 'data:text/html,<script>alert(1)</script>'});
        expect(data.statusCode).toBe(400);
        const notUrl = await draft(aliceToken, {outcome_link: 'PR#1'});
        expect(notUrl.statusCode).toBe(400);
        // None were persisted.
        expect((db.prepare('SELECT COUNT(*) AS n FROM showcase_units').get() as {n: number}).n).toBe(0);
    });

    it('accepts and trims a valid http(s) outcome link on draft', async () => {
        const res = await draft(aliceToken, {outcome_link: '  https://example.com/pr/7  '});
        expect(res.statusCode).toBe(201);
        expect(getShowcaseUnit(db, res.id)?.outcomeLink).toBe('https://example.com/pr/7');
    });

    // --- mandatory gates cannot be bypassed -----------------------------------

    it('publish is refused (409) until the developer approves — consent gate', async () => {
        const d = await draft(aliceToken);
        const id = d.id;
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/submit`, headers: auth(aliceToken)});
        // No approve yet → the required-approval state gate blocks publish.
        const publish = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/publish`, headers: auth(aliceToken)});
        expect(publish.statusCode).toBe(409);
        expect(publish.json().code).toBe('gate_not_satisfied');
        expect(getContribution(db, id)?.state).toBe('submitted');
    });

    it('publish is refused (409) when the mandatory manual review is not confirmed', async () => {
        const d = await draft(aliceToken);
        const id = d.id;
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/submit`, headers: auth(aliceToken)});
        await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/approve`,
            headers: auth(aliceToken),
            payload: {visibility_scope: 'org'},
        });
        // Approved but NOT review-confirmed → manualReviewGate blocks publish.
        const publish = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/publish`, headers: auth(aliceToken)});
        expect(publish.statusCode).toBe(409);
        expect(publish.json().code).toBe('review_not_confirmed');
        expect(getContribution(db, id)?.state).toBe('submitted');
    });

    it('rejects an approve with an invalid visibility_scope (400)', async () => {
        const d = await draft(aliceToken);
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${d.id}/submit`, headers: auth(aliceToken)});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/approve`,
            headers: auth(aliceToken),
            payload: {visibility_scope: 'everyone'},
        });
        expect(res.statusCode).toBe(400);
    });

    it('rejects an approve whose visibility_scope disagrees with the draft scope (SO-1 consent binding)', async () => {
        // Draft org, then try to consent to 'team' — the browse surface publishes at the
        // draft scope (org), so consenting to a narrower reach would publish broader than
        // agreed. The route must reject the mismatch, and nothing may reach `published`.
        const d = await draft(aliceToken, {scope: 'org'});
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${d.id}/submit`, headers: auth(aliceToken)});
        const mismatch = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/approve`,
            headers: auth(aliceToken),
            payload: {visibility_scope: 'team'},
        });
        expect(mismatch.statusCode).toBe(400);
        // The consent was not recorded, so publish is still gate-blocked.
        const publish = await app.inject({method: 'POST', url: `/api/me/showcase-units/${d.id}/publish`, headers: auth(aliceToken)});
        expect(publish.statusCode).toBe(409);
        expect(getContribution(db, d.id)?.state).toBe('submitted');
    });

    it('a redaction AFTER review confirmation re-blocks publish until re-review (TST-1)', async () => {
        // submit → approve → confirm-review → redact (content changed) → publish must be
        // refused: the confirmation attested to content that no longer ships.
        const d = await draft(aliceToken);
        const id = d.id;
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/submit`, headers: auth(aliceToken)});
        await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/approve`,
            headers: auth(aliceToken),
            payload: {visibility_scope: 'org'},
        });
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/confirm-review`, headers: auth(aliceToken)});
        // Redact after confirming — invalidates the `reviewed` event.
        const redact = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/redact`,
            headers: auth(aliceToken),
            payload: {redacted_conversation: '[{"id":"t0","role":"user","text":"cleaned"}]'},
        });
        expect(redact.statusCode).toBe(200);
        const publish = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/publish`, headers: auth(aliceToken)});
        expect(publish.statusCode).toBe(409);
        expect(publish.json().code).toBe('review_not_confirmed');
        // Re-confirming the review after the redaction lets publish through.
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/confirm-review`, headers: auth(aliceToken)});
        const publish2 = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/publish`, headers: auth(aliceToken)});
        expect(publish2.statusCode).toBe(200);
        expect(publish2.json().data.state).toBe('published');
    });

    // --- annotations -----------------------------------------------------------

    it('rejects an annotation whose turn_ref anchors to no real turn (400)', async () => {
        const d = await draft(aliceToken);
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/annotations`,
            headers: auth(aliceToken),
            payload: {turn_ref: 'nope', body: 'x'},
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('turn_not_found');
    });

    it('rejects an annotation with a blank body (400) and one added after submit (409, frozen)', async () => {
        const d = await draft(aliceToken);
        const blank = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/annotations`,
            headers: auth(aliceToken),
            payload: {turn_ref: 't0', body: '   '},
        });
        expect(blank.statusCode).toBe(400);

        await app.inject({method: 'POST', url: `/api/me/showcase-units/${d.id}/submit`, headers: auth(aliceToken)});
        const afterSubmit = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/annotations`,
            headers: auth(aliceToken),
            payload: {turn_ref: 't0', body: 'too late'},
        });
        expect(afterSubmit.statusCode).toBe(409);
        expect(afterSubmit.json().code).toBe('not_editable');
    });

    // --- scrub + review panel + redact ----------------------------------------

    it('flags a secret, surfaces it in the review panel by tier, and resolves it via redact', async () => {
        const secretConvo = '[{"id":"t0","role":"user","text":"key is AKIAIOSFODNN7EXAMPLE and email me at a@b.com"}]';
        const d = await draft(aliceToken, {conversation: secretConvo});
        const id = d.id;

        const scrub = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/scrub`, headers: auth(aliceToken)});
        expect(scrub.statusCode).toBe(200);
        const flags = scrub.json().data.flags as Array<{id: string; tier: string}>;
        const secret = flags.find((f) => f.tier === 'secret_high');
        expect(secret).toBeDefined();
        expect(flags.some((f) => f.tier === 'pii_hint_low')).toBe(true);

        const panel = await app.inject({method: 'GET', url: `/api/me/showcase-units/${id}/review-panel`, headers: auth(aliceToken)});
        expect(panel.statusCode).toBe(200);
        expect(panel.json().data.secretCount).toBe(1);
        expect(panel.json().data.piiHintCount).toBeGreaterThanOrEqual(1);

        // An unknown flag id is rejected, not silently ignored.
        const badRedact = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/redact`,
            headers: auth(aliceToken),
            payload: {redacted_conversation: '[{"id":"t0","role":"user","text":"key is [REDACTED]"}]', resolved_flag_ids: ['ghost']},
        });
        expect(badRedact.statusCode).toBe(400);
        expect(badRedact.json().code).toBe('unknown_flag');

        const redact = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/redact`,
            headers: auth(aliceToken),
            payload: {
                redacted_conversation: '[{"id":"t0","role":"user","text":"key is [REDACTED]"}]',
                resolved_flag_ids: [secret!.id],
            },
        });
        expect(redact.statusCode).toBe(200);
        expect(redact.json().data.resolvedFlagIds).toEqual([secret!.id]);
        // The live unit now carries the redacted conversation.
        expect(getShowcaseUnit(db, id)?.conversation).toContain('[REDACTED]');
    });

    it('re-scrubbing is idempotent — flags do not accumulate duplicates (SO-2)', async () => {
        const secretConvo = '[{"id":"t0","role":"user","text":"key is AKIAIOSFODNN7EXAMPLE and email a@b.com"}]';
        const d = await draft(aliceToken, {conversation: secretConvo});
        const first = await app.inject({method: 'POST', url: `/api/me/showcase-units/${d.id}/scrub`, headers: auth(aliceToken)});
        const firstCount = (first.json().data.flags as unknown[]).length;
        expect(firstCount).toBeGreaterThan(0);
        const second = await app.inject({method: 'POST', url: `/api/me/showcase-units/${d.id}/scrub`, headers: auth(aliceToken)});
        expect((second.json().data.flags as unknown[]).length).toBe(firstCount);
        // The table holds exactly one scan's worth of flags, not two.
        const total = db.prepare('SELECT COUNT(*) AS n FROM scrub_flags WHERE contribution_id = ?').get(d.id) as {n: number};
        expect(total.n).toBe(firstCount);
    });

    it('scrubbing a published showcase is refused (409, pre-publish only) (SO-2)', async () => {
        const id = await publishFullPipeline();
        const res = await app.inject({method: 'POST', url: `/api/me/showcase-units/${id}/scrub`, headers: auth(aliceToken)});
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('not_pre_publish');
    });

    it('rejects an over-long annotation body (400)', async () => {
        const d = await draft(aliceToken);
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/annotations`,
            headers: auth(aliceToken),
            payload: {turn_ref: 't0', body: 'x'.repeat(5001)},
        });
        expect(res.statusCode).toBe(400);
    });

    it('a redact with a non-array resolved_flag_ids is a 400', async () => {
        const d = await draft(aliceToken);
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/redact`,
            headers: auth(aliceToken),
            payload: {redacted_conversation: CONVERSATION, resolved_flag_ids: 'not-an-array'},
        });
        expect(res.statusCode).toBe(400);
    });

    // --- note-only body validation --------------------------------------------

    it('a note-only route rejects an unknown key, a non-object body, and an over-long note (400)', async () => {
        const d = await draft(aliceToken);
        const base = `/api/me/showcase-units/${d.id}/submit`;
        const unknownKey = await app.inject({method: 'POST', url: base, headers: auth(aliceToken), payload: {surprise: 1}});
        expect(unknownKey.statusCode).toBe(400);
        // A JSON array is valid JSON but not an object — the note-only parser rejects it.
        const notObject = await app.inject({method: 'POST', url: base, headers: auth(aliceToken), payload: []});
        expect(notObject.statusCode).toBe(400);
        const longNote = await app.inject({method: 'POST', url: base, headers: auth(aliceToken), payload: {note: 'x'.repeat(2001)}});
        expect(longNote.statusCode).toBe(400);
        // An empty body is accepted (submit needs no note); the draft advances.
        const ok = await app.inject({method: 'POST', url: base, headers: auth(aliceToken)});
        expect(ok.statusCode).toBe(200);
    });

    // --- field-validation edges ------------------------------------------------

    it('rejects an over-long title and a non-string / over-long note on approve (400)', async () => {
        const tooLong = await draft(aliceToken, {title: 'x'.repeat(201)});
        expect(tooLong.statusCode).toBe(400);

        const d = await draft(aliceToken);
        await app.inject({method: 'POST', url: `/api/me/showcase-units/${d.id}/submit`, headers: auth(aliceToken)});
        const nonStringNote = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/approve`,
            headers: auth(aliceToken),
            payload: {visibility_scope: 'org', note: 42},
        });
        expect(nonStringNote.statusCode).toBe(400);
        // A non-object approve body is a 400 too.
        const nonObject = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/approve`,
            headers: auth(aliceToken),
            payload: [],
        });
        expect(nonObject.statusCode).toBe(400);
    });

    it('rejects a redact with a too-long resolved_flag_ids list and a blank entry (400)', async () => {
        const d = await draft(aliceToken);
        const tooMany = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/redact`,
            headers: auth(aliceToken),
            payload: {redacted_conversation: CONVERSATION, resolved_flag_ids: Array.from({length: 201}, (_, i) => `f${i}`)},
        });
        expect(tooMany.statusCode).toBe(400);
        const blankEntry = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/redact`,
            headers: auth(aliceToken),
            payload: {redacted_conversation: CONVERSATION, resolved_flag_ids: ['  ']},
        });
        expect(blankEntry.statusCode).toBe(400);
        // A non-object annotation body is a 400.
        const badAnnBody = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${d.id}/annotations`,
            headers: auth(aliceToken),
            payload: [],
        });
        expect(badAnnBody.statusCode).toBe(400);
    });
});
