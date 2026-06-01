import type {FastifyInstance} from 'fastify';
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
import {getTeam} from '../../../registry/teams';
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

// Git-attribution providers must be unique across developers, or commit
// attribution becomes ambiguous (same rule the Phase 1 registry enforces).
const ATTRIBUTION_PROVIDERS = ['github', 'bitbucket', 'gitlab'] as const;
// Tool identities (Copilot/Claude/Windsurf) are not attribution keys; they are
// not subject to the uniqueness check.
const ALL_PROVIDERS = [...ATTRIBUTION_PROVIDERS, 'copilot', 'claude', 'windsurf'] as const;

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
                const value = optionalStringField(body[provider], provider, reply);
                if (value === FIELD_INVALID) return; // type error already sent
                // null (explicit null or blank) clears the field; setDeveloperIdentities
                // treats an empty string as "remove this identity".
                if (value !== undefined) updates[provider] = value ?? '';
            }

            // git_emails: an array of strings replacing the stored set.
            if (body.git_emails !== undefined) {
                if (!Array.isArray(body.git_emails) || body.git_emails.some((e) => typeof e !== 'string')) {
                    return badRequest(reply, 'git_emails must be an array of strings');
                }
                updates.gitEmails = body.git_emails as string[];
            }

            // Uniqueness check + write run in ONE transaction so two concurrent
            // edits can't both pass the check and both write — which would map a
            // single git-attribution identity to two developers. The uniqueness
            // model is best-effort (the ids live in a JSON blob with no DB unique
            // index), but the transaction closes the read-then-write race within
            // this process. A git-attribution id (github/bitbucket/gitlab) or a
            // git email already owned by ANOTHER developer is rejected.
            let conflictMessage: string | null = null;
            const updated = db.transaction((): ReturnType<typeof setDeveloperIdentities> => {
                for (const provider of ATTRIBUTION_PROVIDERS) {
                    const value = updates[provider];
                    if (!value || !value.trim()) continue;
                    const owner = findByExternalId(db, provider, value.trim());
                    if (owner && owner.id !== developer.id) {
                        conflictMessage = `${provider} identity '${value.trim()}' is already mapped to ${owner.name}`;
                        return null;
                    }
                }
                if (updates.gitEmails) {
                    for (const email of updates.gitEmails) {
                        const trimmed = email.trim();
                        if (!trimmed) continue;
                        const owner = findByEmail(db, trimmed);
                        if (owner && owner.id !== developer.id) {
                            conflictMessage = `git email '${trimmed}' is already mapped to ${owner.name}`;
                            return null;
                        }
                    }
                }
                return setDeveloperIdentities(db, developer.id, updates);
            })();

            if (conflictMessage) return conflict(reply, conflictMessage);
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
            const target = getTeam(db, team);
            if (!target) {
                return badRequest(reply, `Team '${team}' does not exist`);
            }
            // The server is the trust boundary: reject a move onto an archived
            // team even though the UI already filters them out of the dropdown.
            if (target.archived_at) {
                return badRequest(reply, `Team '${team}' is archived`);
            }

            const updated = setDeveloperTeam(db, developer.id, team);
            return {data: updated};
        },
    );
}
