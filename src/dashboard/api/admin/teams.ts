import type {FastifyInstance} from 'fastify';
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
import {
    FIELD_INVALID,
    asObject,
    badRequest,
    conflict,
    forbidden,
    isAdmin,
    notFound,
    optionalStringField,
} from './helpers';

const MAX_NAME_LENGTH = 100;

function withDeveloperCount(db: Database.Database, team: Team): Record<string, unknown> {
    const row = db
        .prepare('SELECT COUNT(*) AS cnt FROM developers WHERE team = ?')
        .get(team.name) as {cnt: number};
    return {...team, developer_count: row.cnt};
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

        const department = optionalStringField(body.department, 'department', reply);
        if (department === FIELD_INVALID) return;
        const manager = optionalStringField(body.manager, 'manager', reply);
        if (manager === FIELD_INVALID) return;
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

            const department = optionalStringField(body.department, 'department', reply);
            if (department === FIELD_INVALID) return;
            const manager = optionalStringField(body.manager, 'manager', reply);
            if (manager === FIELD_INVALID) return;
            if (department !== undefined || manager !== undefined) {
                updateTeam(db, name, {department, manager});
            }

            const updated = getTeam(db, name);
            return {data: updated ? withDeveloperCount(db, updated) : null};
        },
    );
}
