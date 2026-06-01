import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {
    adminResetPassword,
    countAdmins,
    createUser,
    deactivateUser,
    getUserById,
    listUsers,
    reactivateUser,
    updateUser,
} from '../../../auth/users';
import {generateTempPassword, hashPassword} from '../../../auth/password';
import {getDeveloperById} from '../../../registry/developers';
import type {User, UserRole} from '../../../auth/types';
import {asObject, badRequest, conflict, forbidden, isAdmin, notFound} from './helpers';

const MAX_EMAIL_LENGTH = 320;

/** Public projection of a user — never leaks password_hash. */
function publicUser(db: Database.Database, user: User): Record<string, unknown> {
    const developer = user.developer_id ? getDeveloperById(db, user.developer_id) : null;
    return {
        id: user.id,
        email: user.email,
        role: user.role,
        developer_id: user.developer_id,
        developer_name: developer?.name ?? null,
        must_change_password: user.must_change_password,
        created_at: user.created_at,
        deactivated_at: user.deactivated_at,
        active: user.deactivated_at === null,
    };
}

function isValidEmail(email: string): boolean {
    // Deliberately permissive: a single @ with non-empty local and domain parts.
    // Real delivery validation is out of scope for an internal admin tool.
    return /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= MAX_EMAIL_LENGTH;
}

// Reject a change that would leave the system with no active admin — there must
// always be at least one account that can reach the admin area.
function wouldDropLastAdmin(db: Database.Database, target: User, becomesInactiveOrDeveloper: boolean): boolean {
    if (!becomesInactiveOrDeveloper) return false;
    const isActiveAdmin = target.role === 'admin' && target.deactivated_at === null;
    return isActiveAdmin && countAdmins(db) <= 1;
}

export function registerAdminUserRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/admin/users', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        return {data: listUsers(db).map((u) => publicUser(db, u))};
    });

    app.post<{Body: unknown}>('/api/admin/users', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const body = asObject(request.body);
        if (!body) return badRequest(reply, 'Request body must be an object');

        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (!email || !isValidEmail(email)) {
            return badRequest(reply, 'A valid email is required');
        }
        const role = body.role;
        if (role !== 'admin' && role !== 'developer') {
            return badRequest(reply, "role must be 'admin' or 'developer'");
        }
        const developerId = validateDeveloperLink(db, body.developer_id, reply);
        if (developerId === INVALID) return;

        // Provision with a one-time temporary password; force a change on first
        // login. The plaintext is returned ONCE here and never stored.
        const tempPassword = generateTempPassword();
        const passwordHash = await hashPassword(tempPassword);

        let created: User;
        try {
            created = createUser(db, {
                email,
                passwordHash,
                role,
                developerId,
                mustChangePassword: true,
            });
        } catch (err) {
            if (err instanceof Error && /UNIQUE/i.test(err.message)) {
                return conflict(reply, 'A user with that email already exists');
            }
            throw err;
        }

        return reply.status(201).send({
            data: {...publicUser(db, created), temp_password: tempPassword},
        });
    });

    app.patch<{Params: {id: string}; Body: unknown}>(
        '/api/admin/users/:id',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const target = getUserById(db, request.params.id);
            if (!target) return notFound(reply, 'User not found');

            const body = asObject(request.body);
            if (!body) return badRequest(reply, 'Request body must be an object');

            // Resolve the requested changes first, validating each.
            let email: string | undefined;
            if (body.email !== undefined) {
                if (typeof body.email !== 'string' || !isValidEmail(body.email.trim())) {
                    return badRequest(reply, 'A valid email is required');
                }
                email = body.email.trim();
            }
            let role: UserRole | undefined;
            if (body.role !== undefined) {
                if (body.role !== 'admin' && body.role !== 'developer') {
                    return badRequest(reply, "role must be 'admin' or 'developer'");
                }
                role = body.role;
            }
            let developerId: string | null | undefined;
            if (body.developer_id !== undefined) {
                const resolved = validateDeveloperLink(db, body.developer_id, reply);
                if (resolved === INVALID) return;
                developerId = resolved;
            }

            // active:false → deactivate, active:true → reactivate.
            let setActive: boolean | undefined;
            if (body.active !== undefined) {
                if (typeof body.active !== 'boolean') {
                    return badRequest(reply, 'active must be a boolean');
                }
                setActive = body.active;
            }

            // Last-admin guard: block demotion or deactivation of the final admin.
            const demoting = role === 'developer' && target.role === 'admin';
            const deactivating = setActive === false;
            if (wouldDropLastAdmin(db, target, demoting || deactivating)) {
                return conflict(reply, 'Cannot remove the last active admin');
            }

            // Apply field updates, then the activation change.
            try {
                if (email !== undefined || role !== undefined || developerId !== undefined) {
                    updateUser(db, target.id, {email, role, developerId});
                }
            } catch (err) {
                if (err instanceof Error && /UNIQUE/i.test(err.message)) {
                    return conflict(reply, 'A user with that email already exists');
                }
                throw err;
            }
            if (setActive === false) {
                deactivateUser(db, target.id);
            } else if (setActive === true) {
                reactivateUser(db, target.id);
            }

            const updated = getUserById(db, target.id);
            return {data: updated ? publicUser(db, updated) : null};
        },
    );

    app.post<{Params: {id: string}}>(
        '/api/admin/users/:id/reset-password',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const target = getUserById(db, request.params.id);
            if (!target) return notFound(reply, 'User not found');

            const tempPassword = generateTempPassword();
            const passwordHash = await hashPassword(tempPassword);
            adminResetPassword(db, target.id, passwordHash);

            return {data: {id: target.id, temp_password: tempPassword}};
        },
    );
}

// Sentinel distinguishing "validation already sent an error response" from a
// legitimately null developer link.
const INVALID = Symbol('invalid-developer-link');

function validateDeveloperLink(
    db: Database.Database,
    raw: unknown,
    reply: FastifyReply,
): string | null | typeof INVALID {
    if (raw === undefined || raw === null || raw === '') {
        return null;
    }
    if (typeof raw !== 'string') {
        badRequest(reply, 'developer_id must be a string');
        return INVALID;
    }
    if (!getDeveloperById(db, raw)) {
        badRequest(reply, `Developer '${raw}' not found`);
        return INVALID;
    }
    return raw;
}
