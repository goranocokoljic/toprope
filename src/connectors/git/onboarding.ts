/**
 * Developer onboarding: create a developer AND attribute the history already retained for
 * them, in one atomic step (DO1.5 / #255, Epic DO1 / #250).
 *
 * This is the module the epic exists to make possible. #252 retained every author's daily
 * facts in `raw_author_daily`; #253 made `git_snapshots` a deterministic projection over
 * them and exposed `replayDeveloper`; #254 turned the unmapped remainder into a reviewable
 * candidate list. What was still missing is the verb: "this author is a person — make them
 * one, and give them their history back".
 *
 * TWO SURFACES, ONE IMPLEMENTATION. The Admin review queue (via `POST
 * /api/admin/developers`) and the CLI (`toprope dev discover-repo --promote`) both land
 * here. The alternative — each surface calling `addDeveloper` then `replayDeveloper`
 * itself — is how one of them ends up skipping the uniqueness guard, or replaying outside
 * the create transaction, or deriving a different display name. There is one definition.
 *
 * ATOMICITY. The uniqueness check, the INSERT and the replay run inside a SINGLE
 * `db.transaction`. Splitting them would leave the two failure halves visible: a created
 * developer whose retained history never attributed (silently unattributed commits — the
 * exact failure this epic exists to end), or a replay against a developer whose INSERT
 * later rolled back. Replay is idempotent, so a caller that retries after a failure
 * re-attributes rather than double-counting.
 */

import type Database from 'better-sqlite3';
import {addDeveloper} from '../../registry/developers';
import type {Developer} from '../../registry/types';
import {getTeam} from '../../registry/teams';
import {findIdentityConflict} from '../../registry/identity-guard';
import {replayDeveloper, type ProjectionResult} from './projection';
import {listAuthorCandidates, type AuthorCandidate} from './author-candidates';
import type {GitProviderType} from './providers/types';

/**
 * Longest display name accepted. Shared with the admin create route so the HTTP 400 and the
 * clamp applied to a derived name below agree about the bound.
 */
export const MAX_DEVELOPER_NAME_LENGTH = 100;

/** Everything needed to create a developer. Identities are optional; `name`/`team` are not. */
export interface CreateDeveloperInput {
    name: string;
    team: string;
    email?: string;
    github?: string;
    bitbucket?: string;
    gitlab?: string;
    gitEmails?: string[];
}

/** Why a create refused. Typed so each surface maps it (409 / 400 / stderr) rather than guessing. */
export type OnboardingRefusal = 'conflict' | 'invalid_team' | 'candidate_not_found';

export type CreateDeveloperOutcome =
    | {ok: true; developer: Developer; replay: ProjectionResult}
    | {ok: false; reason: OnboardingRefusal; message: string};

/**
 * Create a developer and immediately re-project every retained day their identities now
 * resolve, in one transaction.
 *
 * The team is re-validated here even though the admin route validated it a moment earlier:
 * this function is the write boundary, the CLI reaches it without the route's field
 * validation, and a create against an archived or absent team is a silent data-integrity
 * hole (the developer never appears in any team aggregate). Fail closed, at the write.
 *
 * `replay` reports what the attribution actually did — `datesCovered` is the
 * attributed-dates count both surfaces show as confirmation. It is legitimately 0 for a
 * developer with no retained authorship (a brand-new hire, or an identity that matches
 * nothing yet); that is information, not an error.
 */
export function createDeveloperWithReplay(
    db: Database.Database,
    input: CreateDeveloperInput,
): CreateDeveloperOutcome {
    const name = input.name.trim();
    const team = input.team.trim();
    const email = input.email?.trim() || undefined;
    const gitEmails = (input.gitEmails ?? []).map((e) => e.trim()).filter(Boolean);

    return db.transaction((): CreateDeveloperOutcome => {
        const target = getTeam(db, team);
        if (!target) {
            return {ok: false, reason: 'invalid_team', message: `Team '${team}' does not exist`};
        }
        if (target.archived_at) {
            return {ok: false, reason: 'invalid_team', message: `Team '${team}' is archived`};
        }

        const conflict = findIdentityConflict(
            db,
            {
                github: input.github,
                bitbucket: input.bitbucket,
                gitlab: input.gitlab,
                emails: [
                    ...(email ? [{value: email, label: 'email'}] : []),
                    ...gitEmails.map((value) => ({value, label: 'git email'})),
                ],
            },
            null,
        );
        if (conflict) return {ok: false, reason: 'conflict', message: conflict};

        const developer = addDeveloper(db, name, team, email, input.github, {
            bitbucket: input.bitbucket,
            gitlab: input.gitlab,
            gitEmails: gitEmails.length > 0 ? gitEmails : undefined,
        });

        // Inside the same transaction on purpose — see the module header. The developer row
        // is visible to `buildDevLookupMap` here (same connection), so the replay resolves
        // the identities that were just written.
        const replay = replayDeveloper(db, developer.id);
        return {ok: true, developer, replay};
    })();
}

/** Identity overrides an operator can supply when promoting a candidate. */
export interface PromoteOverrides {
    name?: string;
    email?: string;
    github?: string;
    bitbucket?: string;
    gitlab?: string;
}

export type PromoteOutcome =
    | {ok: true; candidate: AuthorCandidate; developer: Developer; replay: ProjectionResult}
    | {ok: false; reason: OnboardingRefusal; message: string};

/**
 * The name a promoted candidate gets when the operator did not supply one: the provider's
 * display name, else the login, else the email. Clamped to {@link MAX_DEVELOPER_NAME_LENGTH}
 * because nothing upstream bounds these columns — `upsertRawAuthorDaily` passes the identity
 * fields through verbatim, so a self-hosted provider can return an arbitrarily long one, and
 * bulk promotion has no human in the loop to notice.
 *
 * Never empty: a candidate with neither login nor email cannot exist (`rawAuthorKeyFor`
 * returns null for that author and the row is never retained), and the classifier flags the
 * empty identity as a bot regardless.
 */
export function deriveCandidateName(candidate: AuthorCandidate): string {
    const derived = (candidate.display_name ?? candidate.login ?? candidate.email ?? '').trim();
    const fallback = derived || candidate.raw_author_key;
    return fallback.slice(0, MAX_DEVELOPER_NAME_LENGTH);
}

/**
 * Turn a candidate plus operator overrides into the create input.
 *
 * The candidate's OWN provider login goes on that provider's field — a Bitbucket candidate
 * must not be written as a `github` identity, or `resolveDeveloperId` will never match it
 * and the promotion attributes nothing. Overrides win over the candidate's values, and an
 * override for a DIFFERENT provider is carried through as well (an admin promoting a
 * Bitbucket author who also has a known GitHub login).
 *
 * The candidate's email is preserved even when the operator supplies a different primary
 * `email`: it lands in `git_emails` instead. Dropping it is how a promotion "succeeds" and
 * still attributes nothing — the commits carry the candidate's address, not the operator's.
 */
export function candidateCreateInput(
    candidate: AuthorCandidate,
    team: string,
    overrides: PromoteOverrides = {},
): CreateDeveloperInput {
    const identities: Record<GitProviderType, string | undefined> = {
        github: overrides.github,
        bitbucket: overrides.bitbucket,
        gitlab: overrides.gitlab,
    };
    const login = candidate.login?.trim();
    if (login && !identities[candidate.provider]) identities[candidate.provider] = login;

    const candidateEmail = candidate.email?.trim() || undefined;
    const email = overrides.email?.trim() || candidateEmail;
    // Only a SECOND address needs the git_emails slot; when it is already the primary email
    // the lookup map covers it and duplicating it would just widen the uniqueness claim.
    const extraGitEmails =
        candidateEmail && candidateEmail.toLowerCase() !== (email ?? '').toLowerCase()
            ? [candidateEmail]
            : [];

    return {
        name: overrides.name?.trim() || deriveCandidateName(candidate),
        team,
        email,
        github: identities.github,
        bitbucket: identities.bitbucket,
        gitlab: identities.gitlab,
        gitEmails: extraGitEmails,
    };
}

/**
 * Promote one candidate by its `raw_author_key`: create the developer with the candidate's
 * identities pre-filled, then attribute their retained history.
 *
 * The key is resolved against the LIVE candidate list rather than the raw store directly, so
 * an author that is already mapped is `candidate_not_found` rather than a silent duplicate
 * developer for a person who is already here.
 */
export function promoteCandidate(
    db: Database.Database,
    rawAuthorKey: string,
    team: string,
    overrides: PromoteOverrides = {},
): PromoteOutcome {
    const candidate = listAuthorCandidates(db).find((c) => c.raw_author_key === rawAuthorKey);
    if (!candidate) {
        return {
            ok: false,
            reason: 'candidate_not_found',
            message: `No unmatched author with key '${rawAuthorKey}' (already mapped, or never seen).`,
        };
    }

    const outcome = createDeveloperWithReplay(db, candidateCreateInput(candidate, team, overrides));
    return outcome.ok ? {...outcome, candidate} : outcome;
}

/** One candidate's fate in a bulk promotion. */
export type BulkPromoteEntry =
    | {status: 'promoted'; candidate: AuthorCandidate; developer: Developer; replay: ProjectionResult}
    | {status: 'skipped_bot'; candidate: AuthorCandidate; reason: string}
    | {status: 'failed'; candidate: AuthorCandidate; reason: OnboardingRefusal; message: string};

export interface BulkPromoteResult {
    entries: BulkPromoteEntry[];
    promoted: number;
    skippedBots: number;
    failed: number;
}

/**
 * Promote every current candidate, bots excluded unless `includeBots`.
 *
 * The list is snapshotted ONCE and then promoted in its (deterministic) order, rather than
 * re-derived per promotion. Each promotion changes the identity map, so re-deriving would
 * make the iteration order depend on how far it had already got. A candidate that becomes
 * unpromotable partway through — two keys for one person, the second now colliding with the
 * developer the first created — is reported as a `failed` entry with the guard's conflict
 * message, not silently swallowed: that is a real duplicate identity the operator should see.
 *
 * Each promotion is its own transaction. One failure does not roll back the developers
 * already created, which is what makes a partial bulk run resumable — re-running promotes
 * only what is still a candidate.
 */
export function promoteAllCandidates(
    db: Database.Database,
    team: string,
    options: {includeBots?: boolean} = {},
): BulkPromoteResult {
    const entries: BulkPromoteEntry[] = [];

    for (const candidate of listAuthorCandidates(db)) {
        if (candidate.likely_bot && !options.includeBots) {
            entries.push({
                status: 'skipped_bot',
                candidate,
                reason: candidate.bot_reason ?? 'classified as automation',
            });
            continue;
        }
        const outcome = createDeveloperWithReplay(db, candidateCreateInput(candidate, team));
        entries.push(
            outcome.ok
                ? {
                      status: 'promoted',
                      candidate,
                      developer: outcome.developer,
                      replay: outcome.replay,
                  }
                : {status: 'failed', candidate, reason: outcome.reason, message: outcome.message},
        );
    }

    return {
        entries,
        promoted: entries.filter((e) => e.status === 'promoted').length,
        skippedBots: entries.filter((e) => e.status === 'skipped_bot').length,
        failed: entries.filter((e) => e.status === 'failed').length,
    };
}
