import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {
    findByEmail,
    findByExternalId,
    getDeveloperById,
    listDevelopers,
    setDeveloperIdentities,
    setDeveloperTeam,
    type IdentityUpdates,
} from '../../../registry/developers';
import {teamExists} from '../../../registry/teams';
import {asObject, badRequest, conflict, forbidden, isAdmin, notFound} from './helpers';

// Git-attribution providers must be unique across developers, or commit
// attribution becomes ambiguous (same rule the Phase 1 registry enforces).
const ATTRIBUTION_PROVIDERS = ['github', 'bitbucket', 'gitlab'] as const;
// Tool identities (Copilot/Claude/Windsurf) are not attribution keys; they are
// not subject to the uniqueness check.
const ALL_PROVIDERS = [...ATTRIBUTION_PROVIDERS, 'copilot', 'claude', 'windsurf'] as const;

function asOptionalString(value: unknown, reply: FastifyReply, field: string): string | undefined | null {
    if (value === undefined) return undefined;
    if (value === null) return '';
    if (typeof value !== 'string') {
        badRequest(reply, `${field} must be a string`);
        return null;
    }
    return value;
}

export function registerAdminDeveloperRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/admin/developers', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        return {data: listDevelopers(db)};
    });

    app.patch<{Params: {id: string}; Body: unknown}>(
        '/api/admin/developers/:id/identities',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const developer = getDeveloperById(db, request.params.id);
            if (!developer) return notFound(reply, 'Developer not found');

            const body = asObject(request.body);
            if (!body) return badRequest(reply, 'Request body must be an object');

            const updates: IdentityUpdates = {};
            for (const provider of ALL_PROVIDERS) {
                const value = asOptionalString(body[provider], reply, provider);
                if (value === null) return; // type error already sent
                if (value !== undefined) updates[provider] = value;
            }

            // git_emails: an array of strings replacing the stored set.
            if (body.git_emails !== undefined) {
                if (!Array.isArray(body.git_emails) || body.git_emails.some((e) => typeof e !== 'string')) {
                    return badRequest(reply, 'git_emails must be an array of strings');
                }
                updates.gitEmails = body.git_emails as string[];
            }

            // Uniqueness: a git-attribution id (github/bitbucket/gitlab) or a git
            // email already owned by ANOTHER developer is rejected, so one
            // identity never maps to two developers.
            for (const provider of ATTRIBUTION_PROVIDERS) {
                const value = updates[provider];
                if (!value || !value.trim()) continue;
                const owner = findByExternalId(db, provider, value.trim());
                if (owner && owner.id !== developer.id) {
                    return conflict(
                        reply,
                        `${provider} identity '${value.trim()}' is already mapped to ${owner.name}`,
                    );
                }
            }
            if (updates.gitEmails) {
                for (const email of updates.gitEmails) {
                    const trimmed = email.trim();
                    if (!trimmed) continue;
                    const owner = findByEmail(db, trimmed);
                    if (owner && owner.id !== developer.id) {
                        return conflict(
                            reply,
                            `git email '${trimmed}' is already mapped to ${owner.name}`,
                        );
                    }
                }
            }

            const updated = setDeveloperIdentities(db, developer.id, updates);
            return {data: updated};
        },
    );

    app.patch<{Params: {id: string}; Body: unknown}>(
        '/api/admin/developers/:id',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const developer = getDeveloperById(db, request.params.id);
            if (!developer) return notFound(reply, 'Developer not found');

            const body = asObject(request.body);
            if (!body) return badRequest(reply, 'Request body must be an object');

            if (body.team === undefined) {
                return badRequest(reply, 'team is required');
            }
            if (typeof body.team !== 'string' || !body.team.trim()) {
                return badRequest(reply, 'team must be a non-empty string');
            }
            const team = body.team.trim();
            if (!teamExists(db, team)) {
                return badRequest(reply, `Team '${team}' does not exist`);
            }

            const updated = setDeveloperTeam(db, developer.id, team);
            return {data: updated};
        },
    );
}
