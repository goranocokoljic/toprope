import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    addDeveloper,
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
// Tool identities (Copilot/Claude/Windsurf/Cursor) are not attribution keys;
// they are not subject to the uniqueness check.
const ALL_PROVIDERS = [...ATTRIBUTION_PROVIDERS, 'copilot', 'claude', 'windsurf', 'cursor'] as const;

const MAX_NAME_LENGTH = 100;

/**
 * A set of git-attribution identities one developer is claiming. Emails carry
 * their own label: the primary `email` and each `git_emails` entry are both
 * checked with `findByEmail` (it matches either column) but read differently in
 * the conflict message.
 */
interface IdentityClaim {
    github?: string;
    bitbucket?: string;
    gitlab?: string;
    emails?: {value: string; label: string}[];
}

/**
 * The conflict message for the first claimed git-attribution identity or git
 * email already owned by a DIFFERENT developer, or null when the whole claim is
 * free. `excludeId` is the developer making the claim — null on create, where
 * the row does not exist yet.
 *
 * MUST be called inside the same `db.transaction` as the write it guards. The
 * uniqueness model is best-effort (the ids live in a JSON blob with no DB unique
 * index), so the transaction is what closes the read-then-write race that would
 * otherwise let two concurrent writes both pass the check and map one git
 * identity to two developers — which makes commit attribution ambiguous.
 *
 * Both the create route and the identities PATCH go through here so the rule and
 * its message shape have exactly one definition.
 */
function findIdentityConflict(
    db: Database.Database,
    claim: IdentityClaim,
    excludeId: string | null,
): string | null {
    for (const provider of ATTRIBUTION_PROVIDERS) {
        const value = claim[provider]?.trim();
        if (!value) continue;
        const owner = findByExternalId(db, provider, value);
        if (owner && owner.id !== excludeId) {
            return `${provider} identity '${value}' is already mapped to ${owner.name}`;
        }
    }
    for (const {value, label} of claim.emails ?? []) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        const owner = findByEmail(db, trimmed);
        if (owner && owner.id !== excludeId) {
            return `${label} '${trimmed}' is already mapped to ${owner.name}`;
        }
    }
    return null;
}

/**
 * Resolve a REQUIRED `team` field: a non-blank string naming a team that exists
 * and is not archived. Sends the 400 and returns FIELD_INVALID otherwise.
 *
 * The server is the trust boundary here even though the UI already filters
 * archived teams out of its dropdown, and both the create route and the team
 * PATCH validate identically — so the rule lives in one place.
 */
function requiredTeamField(
    db: Database.Database,
    value: unknown,
    reply: Parameters<typeof badRequest>[0],
): string | typeof FIELD_INVALID {
    if (value === undefined) {
        badRequest(reply, 'team is required');
        return FIELD_INVALID;
    }
    if (typeof value !== 'string' || !value.trim()) {
        badRequest(reply, 'team must be a non-empty string');
        return FIELD_INVALID;
    }
    const team = value.trim();
    const target = getTeam(db, team);
    if (!target) {
        badRequest(reply, `Team '${team}' does not exist`);
        return FIELD_INVALID;
    }
    if (target.archived_at) {
        badRequest(reply, `Team '${team}' is archived`);
        return FIELD_INVALID;
    }
    return team;
}

/**
 * Parse an optional `git_emails` array of strings from a request body into
 * INDIVIDUAL emails. Returns undefined when absent, FIELD_INVALID (after sending
 * a 400) when it is present but not an array of strings.
 *
 * Each element is split on commas/whitespace rather than taken whole, because
 * the store and the reader disagree about what one element is: `joinGitEmails`
 * persists the set as a comma-joined string, and both `findByEmail` and sync's
 * `buildDevLookupMap` split that string on ',' to get back individual emails.
 * An element that itself contains a comma therefore stores as two emails but
 * would be uniqueness-checked as one opaque string that matches nothing — so
 * 'mine@corp.com, jane@corp.com' passes the guard and then silently re-points
 * Jane's commit attribution at the new developer. Normalizing here keeps
 * validation, storage, and lookup tokenizing identically.
 */
function gitEmailsField(
    value: unknown,
    reply: Parameters<typeof badRequest>[0],
): string[] | undefined | typeof FIELD_INVALID {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((e) => typeof e !== 'string')) {
        badRequest(reply, 'git_emails must be an array of strings');
        return FIELD_INVALID;
    }
    return (value as string[]).flatMap((e) =>
        e
            .split(/[,\s]+/)
            .map((part) => part.trim())
            .filter(Boolean),
    );
}

export function registerAdminDeveloperRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/admin/developers', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        return {data: listDevelopers(db)};
    });

    // Create a developer (DO1.1 / #251). Until now the only creation paths were
    // the CLI and GitHub-org discovery, so a fresh install that connected a git
    // provider had no way to get developers into the system at all — and sync
    // attributes commits only to developers that already exist.
    app.post<{Body: unknown}>('/api/admin/developers', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const body = asObject(request.body);
        if (!body) return badRequest(reply, 'Request body must be an object');

        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return badRequest(reply, 'name is required');
        if (name.length > MAX_NAME_LENGTH) {
            return badRequest(reply, `name must be at most ${MAX_NAME_LENGTH} characters`);
        }

        const team = requiredTeamField(db, body.team, reply);
        if (team === FIELD_INVALID) return; // 400 already sent

        const email = optionalStringField(body.email, 'email', reply);
        if (email === FIELD_INVALID) return;
        const github = optionalStringField(body.github, 'github', reply);
        if (github === FIELD_INVALID) return;
        const bitbucket = optionalStringField(body.bitbucket, 'bitbucket', reply);
        if (bitbucket === FIELD_INVALID) return;
        const gitlab = optionalStringField(body.gitlab, 'gitlab', reply);
        if (gitlab === FIELD_INVALID) return;
        const gitEmails = gitEmailsField(body.git_emails, reply);
        if (gitEmails === FIELD_INVALID) return;

        // The uniqueness check and the INSERT run in ONE transaction — see
        // findIdentityConflict for why the read-then-write must not be split.
        let conflictMessage: string | null = null;
        const created = db.transaction((): ReturnType<typeof addDeveloper> | null => {
            conflictMessage = findIdentityConflict(
                db,
                {
                    github: github ?? undefined,
                    bitbucket: bitbucket ?? undefined,
                    gitlab: gitlab ?? undefined,
                    emails: [
                        ...(email ? [{value: email, label: 'email'}] : []),
                        ...(gitEmails ?? []).map((value) => ({value, label: 'git email'})),
                    ],
                },
                null,
            );
            if (conflictMessage) return null;
            return addDeveloper(db, name, team, email ?? undefined, github ?? undefined, {
                bitbucket: bitbucket ?? undefined,
                gitlab: gitlab ?? undefined,
                gitEmails: gitEmails ?? undefined,
            });
        })();

        if (conflictMessage) return conflict(reply, conflictMessage);
        return reply.status(201).send({data: created});
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
            const gitEmails = gitEmailsField(body.git_emails, reply);
            if (gitEmails === FIELD_INVALID) return;
            if (gitEmails !== undefined) updates.gitEmails = gitEmails;

            // Uniqueness check + write run in ONE transaction — see
            // findIdentityConflict for why the read-then-write must not be split.
            // A git-attribution id (github/bitbucket/gitlab) or a git email
            // already owned by ANOTHER developer is rejected.
            let conflictMessage: string | null = null;
            const updated = db.transaction((): ReturnType<typeof setDeveloperIdentities> => {
                conflictMessage = findIdentityConflict(
                    db,
                    {
                        github: updates.github,
                        bitbucket: updates.bitbucket,
                        gitlab: updates.gitlab,
                        emails: (updates.gitEmails ?? []).map((value) => ({
                            value,
                            label: 'git email',
                        })),
                    },
                    developer.id,
                );
                if (conflictMessage) return null;
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

            const team = requiredTeamField(db, body.team, reply);
            if (team === FIELD_INVALID) return; // 400 already sent

            const updated = setDeveloperTeam(db, developer.id, team);
            return {data: updated};
        },
    );
}
