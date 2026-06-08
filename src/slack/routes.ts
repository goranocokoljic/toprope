import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import type {SlackBotConfig} from '../config/types';
import {createSlackClient, type SlackClient} from './client';
import {
    handleInteraction,
    handleSlashCommand,
    type SlackHandlerDeps,
    type SlackHandlerResult,
    type SlashCommandBody,
} from './handlers';
import {verifySlackSignature} from './signature';

declare module 'fastify' {
    interface FastifyRequest {
        // The unparsed urlencoded body, captured for Slack signature verification.
        // Set by the content-type parser registered in registerSlackRoutes.
        rawBody?: string;
    }
}

const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const SIGNATURE_HEADER = 'x-slack-signature';

function headerValue(request: FastifyRequest, name: string): string | undefined {
    const v = request.headers[name];
    return Array.isArray(v) ? v[0] : v;
}

function sendResult(reply: FastifyReply, result: SlackHandlerResult): FastifyReply {
    reply.status(result.status);
    // Slack accepts an empty 200 as an acknowledgement; only send a JSON body
    // when the handler produced one (ephemeral messages, view errors, etc.).
    return result.body === undefined ? reply.send('') : reply.send(result.body);
}

export interface RegisterSlackRoutesOptions {
    // Inject a client/deps for testing; defaults to a real client from bot_token.
    client?: SlackClient;
}

/**
 * Register the Slack bot's HTTP endpoints:
 *   POST /slack/commands       — the /govproxy-log slash command
 *   POST /slack/interactivity  — modal submissions + button clicks
 *
 * Both live outside /api, so the session-auth gate doesn't apply; every request
 * is instead authenticated by its Slack signature. A request that fails
 * verification is rejected with 401 before any handler runs.
 */
export function registerSlackRoutes(
    app: FastifyInstance,
    db: Database.Database,
    config: SlackBotConfig,
    options: RegisterSlackRoutesOptions = {},
): void {
    const signingSecret = config.signing_secret ?? '';
    if (!signingSecret) {
        app.log.warn(
            'slack.enabled is true but slack.signing_secret is not set — all Slack requests will be rejected.',
        );
    }
    const client = options.client ?? createSlackClient(config.bot_token ?? '');
    const deps: SlackHandlerDeps = {db, client, log: (m, e) => app.log.error({err: e}, `[slack] ${m}`)};

    // Slack sends application/x-www-form-urlencoded, which Fastify doesn't parse
    // by default. Capture the raw body (needed for signature verification) and
    // also expose it parsed. This parser is additive — JSON routes are untouched.
    app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        {parseAs: 'string'},
        (request, body, done) => {
            const raw = typeof body === 'string' ? body : body.toString('utf8');
            request.rawBody = raw;
            try {
                const params = new URLSearchParams(raw);
                const obj: Record<string, string> = {};
                for (const [key, value] of params) obj[key] = value;
                done(null, obj);
            } catch (err) {
                done(err as Error);
            }
        },
    );

    function verify(request: FastifyRequest): boolean {
        return verifySlackSignature({
            signingSecret,
            timestamp: headerValue(request, TIMESTAMP_HEADER),
            signature: headerValue(request, SIGNATURE_HEADER),
            rawBody: request.rawBody ?? '',
        });
    }

    app.post('/slack/commands', async (request, reply) => {
        if (!verify(request)) {
            return reply.status(401).send('invalid signature');
        }
        const result = await handleSlashCommand((request.body ?? {}) as SlashCommandBody, deps);
        return sendResult(reply, result);
    });

    app.post('/slack/interactivity', async (request, reply) => {
        if (!verify(request)) {
            return reply.status(401).send('invalid signature');
        }
        const body = (request.body ?? {}) as {payload?: string};
        let payload: unknown;
        try {
            payload = JSON.parse(body.payload ?? '');
        } catch {
            return reply.status(400).send('invalid payload');
        }
        const result = await handleInteraction(payload, deps);
        return sendResult(reply, result);
    });
}
