import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {
    addTeam,
    archiveTeam,
    getTeam,
    listTeams,
    teamExists,
    unarchiveTeam,
    updateTeam,
} from '../../../registry/teams';
import type {Team} from '../../../registry/types';
import {asObject, badRequest, conflict, forbidden, isAdmin, notFound} from './helpers';

const MAX_NAME_LENGTH = 100;

function withDeveloperCount(db: Database.Database, team: Team): Record<string, unknown> {
    const row = db
        .prepare('SELECT COUNT(*) AS cnt FROM developers WHERE team = ?')
        .get(team.name) as {cnt: number};
    return {...team, developer_count: row.cnt};
}

// Distinguishes "a 400 was already sent for a bad type" from a real value.
const INVALID = Symbol('invalid-field');

// An optional string field: undefined → omit, null/'' → clear, else trimmed. A
// non-string (e.g. a number) is a client error and is rejected with 400 rather
// than silently dropped.
function optionalString(value: unknown, field: string, reply: FastifyReply): string | null | undefined | typeof INVALID {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') {
        badRequest(reply, `${field} must be a string`);
        return INVALID;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function registerAdminTeamRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/admin/teams', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        // Archived teams are included so the admin can see and restore them.
        return {data: listTeams(db, true).map((t) => withDeveloperCount(db, t))};
    });

    app.post<{Body: unknown}>('/api/admin/teams', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const body = asObject(request.body);
        if (!body) return badRequest(reply, 'Request body must be an object');

        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return badRequest(reply, 'Team name is required');
        if (name.length > MAX_NAME_LENGTH) {
            return badRequest(reply, `Team name must be at most ${MAX_NAME_LENGTH} characters`);
        }
        if (teamExists(db, name)) {
            return conflict(reply, `Team '${name}' already exists`);
        }

        const department = optionalString(body.department, 'department', reply);
        if (department === INVALID) return;
        const manager = optionalString(body.manager, 'manager', reply);
        if (manager === INVALID) return;
        const team = addTeam(db, name, department ?? undefined, manager ?? undefined);
        return reply.status(201).send({data: withDeveloperCount(db, team)});
    });

    app.patch<{Params: {name: string}; Body: unknown}>(
        '/api/admin/teams/:name',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const {name} = request.params;
            if (!getTeam(db, name)) return notFound(reply, `Team '${name}' not found`);

            const body = asObject(request.body);
            if (!body) return badRequest(reply, 'Request body must be an object');

            if (body.archived !== undefined) {
                if (typeof body.archived !== 'boolean') {
                    return badRequest(reply, 'archived must be a boolean');
                }
                if (body.archived) {
                    archiveTeam(db, name);
                } else {
                    unarchiveTeam(db, name);
                }
            }

            const department = optionalString(body.department, 'department', reply);
            if (department === INVALID) return;
            const manager = optionalString(body.manager, 'manager', reply);
            if (manager === INVALID) return;
            if (department !== undefined || manager !== undefined) {
                updateTeam(db, name, {department, manager});
            }

            const updated = getTeam(db, name);
            return {data: updated ? withDeveloperCount(db, updated) : null};
        },
    );
}
