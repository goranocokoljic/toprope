import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {getDeveloperById} from '../../registry/developers';
import {
    createManualSurvey,
    runTriggerSweep,
    sendSurvey,
    type DispatchDeps,
} from '../../surveys/dispatch';
import {
    declineSurvey,
    dismissSurvey,
    getLatestResponse,
    getSurveyById,
    listSurveys,
    listSurveysForDeveloper,
    respondToSurvey,
    type RespondOutcome,
} from '../../surveys/store';
import {
    isSurveyTriggerType,
    SURVEY_STATUSES,
    type SurveyChoice,
    type SurveyStatus,
} from '../../surveys/types';
import {forbidden, isAdmin, requireDeveloperId} from './guards';
import {badRequest, conflict, notFound} from './admin/helpers';

// Boundary caps on the one untrusted free-text fields (developer response text
// and a manager-authored question). Without these, an authenticated caller can
// persist an unbounded string that's then surfaced verbatim to every manager
// read. Generous enough for a real answer; small enough to stop storage abuse.
const MAX_RESPONSE_TEXT = 4000;
const MAX_QUESTION_TEXT = 2000;

/**
 * Data-prompted survey endpoints (Task 4.3 / #98).
 *
 * Two audiences, two privacy postures:
 *  - Manager (admin) routes under /api/surveys: the review queue, send/dismiss
 *    actions, manual creation, and the answered-with-context view. Admin-guarded
 *    inline (defense-in-depth behind the session middleware), like the rest of
 *    the manager API.
 *  - Developer routes under /api/me/surveys: a developer sees and answers ONLY
 *    their own surveys. The developer id comes strictly from the session, and
 *    respondToSurvey/declineSurvey re-check ownership — there is no way to act on
 *    someone else's survey.
 *
 * The shared `dispatchDeps` carry the optional Slack client + emailer so send
 * actions can actually deliver; they're injected by the server at registration.
 */
export interface SurveyRoutesDeps {
    slackClient?: DispatchDeps['slackClient'];
    emailer?: DispatchDeps['emailer'];
    log?: DispatchDeps['log'];
}

export function registerSurveyRoutes(
    app: FastifyInstance,
    db: Database.Database,
    deps: SurveyRoutesDeps = {},
): void {
    const dispatchDeps = (): DispatchDeps => ({db, ...deps});

    // --- Manager: review queue ------------------------------------------------
    app.get<{Querystring: {status?: string; trigger?: string; team?: string; limit?: string}}>(
        '/api/surveys',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const {status, trigger, team, limit} = request.query;
            if (status !== undefined && !isSurveyStatus(status)) {
                return badRequest(reply, `status must be one of: ${SURVEY_STATUSES.join(', ')}`);
            }
            if (trigger !== undefined && !isSurveyTriggerType(trigger)) {
                return badRequest(reply, 'unknown trigger type');
            }
            const surveys = listSurveys(db, {
                status: status as SurveyStatus | undefined,
                triggerType: trigger && isSurveyTriggerType(trigger) ? trigger : undefined,
                team,
                limit: parseLimit(limit),
            });
            return {data: surveys};
        },
    );

    // --- Manager: single survey detail (with response) ------------------------
    app.get<{Params: {id: string}}>('/api/surveys/:id', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const survey = getSurveyById(db, request.params.id);
        if (!survey) return notFound(reply, 'Survey not found');
        const developer = getDeveloperById(db, survey.developer_id);
        return {
            data: {
                ...survey,
                developer_name: developer?.name ?? null,
                team: developer?.team ?? null,
                response: getLatestResponse(db, survey.id),
            },
        };
    });

    // --- Manager: create a manual survey --------------------------------------
    app.post<{Body: {developerId?: unknown; questionText?: unknown; choices?: unknown}}>(
        '/api/surveys',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const body = request.body ?? {};
            const developerId = typeof body.developerId === 'string' ? body.developerId : '';
            const questionText = typeof body.questionText === 'string' ? body.questionText.trim() : '';
            if (!developerId) return badRequest(reply, 'developerId is required');
            if (!questionText) return badRequest(reply, 'questionText is required');
            if (questionText.length > MAX_QUESTION_TEXT) {
                return badRequest(reply, `questionText must be at most ${MAX_QUESTION_TEXT} characters`);
            }
            const choices = parseChoices(body.choices);
            const survey = createManualSurvey(db, {developerId, questionText, choices});
            if (!survey) return notFound(reply, 'Developer not found');
            return reply.status(201).send({data: survey});
        },
    );

    // --- Manager: send a queued survey (approval / retry) ---------------------
    app.post<{Params: {id: string}}>('/api/surveys/:id/send', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const survey = getSurveyById(db, request.params.id);
        if (!survey) return notFound(reply, 'Survey not found');
        if (survey.status !== 'queued') {
            return conflict(reply, `Survey is '${survey.status}', not queued`);
        }
        const result = await sendSurvey(dispatchDeps(), survey.id);
        if (!result.delivered) {
            return reply.status(502).send({
                error: 'Bad Gateway',
                message: `Could not deliver survey (${result.reason})`,
            });
        }
        return {data: {id: survey.id, delivered: true, delivery: result.delivery}};
    });

    // --- Manager: dismiss a queued survey -------------------------------------
    app.post<{Params: {id: string}}>('/api/surveys/:id/dismiss', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const survey = getSurveyById(db, request.params.id);
        if (!survey) return notFound(reply, 'Survey not found');
        if (!dismissSurvey(db, survey.id)) {
            return conflict(reply, `Survey is '${survey.status}', not queued`);
        }
        return {data: {id: survey.id, status: 'dismissed'}};
    });

    // --- Manager: run trigger detection + dispatch ----------------------------
    app.post('/api/surveys/run', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const summary = await runTriggerSweep(dispatchDeps());
        return {data: summary};
    });

    // --- Developer: my surveys ------------------------------------------------
    app.get('/api/me/surveys', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) return reply;
        return {data: listSurveysForDeveloper(db, developerId)};
    });

    // --- Developer: respond to my survey --------------------------------------
    app.post<{Params: {id: string}; Body: {choice?: unknown; text?: unknown}}>(
        '/api/me/surveys/:id/respond',
        async (request, reply) => {
            const developerId = requireDeveloperId(request, reply);
            if (!developerId) return reply;
            const body = request.body ?? {};
            const responseChoice = typeof body.choice === 'string' ? body.choice : null;
            const responseText = typeof body.text === 'string' ? body.text : null;
            if (!responseChoice && !responseText) {
                return badRequest(reply, 'Provide a choice or text');
            }
            if (responseText && responseText.length > MAX_RESPONSE_TEXT) {
                return badRequest(reply, `text must be at most ${MAX_RESPONSE_TEXT} characters`);
            }
            const outcome = respondToSurvey(db, request.params.id, developerId, {
                responseChoice,
                responseText,
            });
            return mapOutcome(reply, outcome, () => ({data: {id: request.params.id, status: 'answered'}}));
        },
    );

    // --- Developer: decline my survey -----------------------------------------
    app.post<{Params: {id: string}}>('/api/me/surveys/:id/decline', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) return reply;
        const outcome = declineSurvey(db, request.params.id, developerId);
        return mapOutcome(reply, outcome, () => ({data: {id: request.params.id, status: 'declined'}}));
    });
}

// --- helpers ------------------------------------------------------------------

function isSurveyStatus(value: string): value is SurveyStatus {
    return (SURVEY_STATUSES as readonly string[]).includes(value);
}

function parseLimit(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseChoices(raw: unknown): SurveyChoice[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: SurveyChoice[] = [];
    for (const c of raw) {
        if (c && typeof c === 'object') {
            const value = (c as Record<string, unknown>).value;
            const label = (c as Record<string, unknown>).label;
            if (typeof value === 'string' && typeof label === 'string' && value && label) {
                out.push({value, label});
            }
        }
    }
    return out.length > 0 ? out : undefined;
}

function mapOutcome(
    reply: FastifyReply,
    outcome: RespondOutcome,
    onOk: () => unknown,
): unknown {
    switch (outcome) {
        case 'ok':
            return onOk();
        case 'not_found':
            return notFound(reply, 'Survey not found');
        case 'forbidden':
            // A developer acting on a survey that isn't theirs. Return 404 (not
            // 403) so the existence of another developer's survey isn't revealed.
            return notFound(reply, 'Survey not found');
        case 'invalid_status':
            return conflict(reply, 'Survey is not awaiting a response');
        default:
            // Exhaustive over RespondOutcome — a new member becomes a compile error.
            return assertNever(outcome);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unhandled respond outcome: ${String(value)}`);
}
