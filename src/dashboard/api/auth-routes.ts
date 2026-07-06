import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {SESSION_COOKIE, clearCookie, serializeCookie} from '../../auth/cookies';
import {hashPassword, validatePasswordStrength, verifyPassword} from '../../auth/password';
import {createSession, deleteSession, deleteSessionsForUser} from '../../auth/sessions';
import {getActiveUserByEmail, getUserById, updatePassword} from '../../auth/users';
import {LoginRateLimiter, type RateLimitOptions} from '../../auth/rate-limit';

// Upper bounds on credential inputs, rejected at the HTTP boundary so an
// oversized body can't be fed into argon2 (a CPU-DoS lever).
const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1024;

export interface AuthRoutesOptions {
    sessionTtlHours: number;
    cookieSecure: boolean;
    // Optional override for the login brute-force limiter (mainly for tests).
    loginRateLimit?: RateLimitOptions;
}

// A real argon2 hash used to equalize verify timing when the email is unknown,
// so login response time can't be used to enumerate valid accounts. Computed
// once, lazily, on the first failed lookup.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
    if (!dummyHashPromise) {
        dummyHashPromise = hashPassword('toprope-timing-equalizer');
    }
    return dummyHashPromise;
}

function setSessionCookie(
    reply: FastifyReply,
    token: string,
    opts: AuthRoutesOptions,
): void {
    reply.header(
        'set-cookie',
        serializeCookie(SESSION_COOKIE, token, {
            httpOnly: true,
            sameSite: 'Lax',
            secure: opts.cookieSecure,
            maxAgeSeconds: opts.sessionTtlHours * 60 * 60,
        }),
    );
}

export function registerAuthRoutes(
    app: FastifyInstance,
    db: Database.Database,
    opts: AuthRoutesOptions,
): void {
    // One limiter per server instance; resets with the process.
    const loginLimiter = new LoginRateLimiter(opts.loginRateLimit);

    app.post<{Body: {email?: string; password?: string}}>(
        '/api/auth/login',
        async (request, reply) => {
            const rateKey = request.ip;
            if (loginLimiter.isLimited(rateKey)) {
                return reply.status(429).send({
                    error: 'Too Many Requests',
                    message: 'Too many login attempts. Please try again later.',
                });
            }

            const {email, password} = request.body ?? {};
            if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
                return reply
                    .status(400)
                    .send({error: 'Bad Request', message: 'Email and password are required'});
            }
            if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
                return reply
                    .status(400)
                    .send({error: 'Bad Request', message: 'Email or password is too long'});
            }

            const user = getActiveUserByEmail(db, email);
            // Always run a verify (against the real or a dummy hash) so response
            // timing doesn't reveal whether the email exists.
            let passwordOk = false;
            if (user) {
                passwordOk = await verifyPassword(user.password_hash, password);
            } else {
                await verifyPassword(await getDummyHash(), password);
            }

            if (!user || !passwordOk) {
                loginLimiter.recordFailure(rateKey);
                return reply
                    .status(401)
                    .send({error: 'Unauthorized', message: 'Invalid email or password'});
            }

            loginLimiter.reset(rateKey);
            const session = createSession(db, user.id, opts.sessionTtlHours);
            setSessionCookie(reply, session.id, opts);

            return {
                data: {
                    role: user.role,
                    developer_id: user.developer_id,
                    must_change_password: user.must_change_password,
                },
            };
        },
    );

    app.post('/api/auth/logout', async (request, reply) => {
        const sessionId = request.authUser?.sessionId;
        if (sessionId) {
            deleteSession(db, sessionId);
        }
        reply.header('set-cookie', clearCookie(SESSION_COOKIE, {secure: opts.cookieSecure}));
        return {data: {ok: true}};
    });

    app.get('/api/auth/me', async (request, reply) => {
        const authUser = request.authUser;
        if (!authUser) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Authentication required'});
        }
        return {
            data: {
                email: authUser.email,
                role: authUser.role,
                developer_id: authUser.developerId,
                must_change_password: authUser.mustChangePassword,
            },
        };
    });

    app.post<{Body: {current_password?: string; new_password?: string}}>(
        '/api/auth/change-password',
        async (request, reply) => {
            const authUser = request.authUser;
            if (!authUser) {
                return reply
                    .status(401)
                    .send({error: 'Unauthorized', message: 'Authentication required'});
            }

            const {current_password: currentPassword, new_password: newPassword} = request.body ?? {};
            if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: 'current_password and new_password are required',
                });
            }
            if (newPassword.length > MAX_PASSWORD_LENGTH) {
                return reply
                    .status(400)
                    .send({error: 'Bad Request', message: 'New password is too long'});
            }

            const strength = validatePasswordStrength(newPassword);
            if (!strength.valid) {
                return reply.status(400).send({error: 'Bad Request', message: strength.error});
            }

            const user = getUserById(db, authUser.userId);
            if (!user) {
                return reply
                    .status(401)
                    .send({error: 'Unauthorized', message: 'Authentication required'});
            }

            const currentOk = await verifyPassword(user.password_hash, currentPassword);
            if (!currentOk) {
                return reply
                    .status(401)
                    .send({error: 'Unauthorized', message: 'Current password is incorrect'});
            }

            const newHash = await hashPassword(newPassword);
            updatePassword(db, user.id, newHash);

            // Rotate sessions: invalidate every existing session (including this
            // one) and issue a fresh cookie, so a stolen pre-change session and
            // any other device are logged out.
            deleteSessionsForUser(db, user.id);
            const session = createSession(db, user.id, opts.sessionTtlHours);
            setSessionCookie(reply, session.id, opts);

            return {data: {ok: true}};
        },
    );
}
