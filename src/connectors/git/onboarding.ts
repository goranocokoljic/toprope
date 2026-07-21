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
import {addDeveloper, tokenizeGitEmails} from '../../registry/developers';
import type {Developer} from '../../registry/types';
import {getTeam} from '../../registry/teams';
import {findIdentityConflict} from '../../registry/identity-guard';
import {replayDeveloper, replayDevelopers, type ProjectionResult} from './projection';
import {listAuthorCandidates, type AuthorCandidate} from './author-candidates';
import {isLoginKey} from './raw-author-daily';
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
    options: {deferReplay?: boolean} = {},
): CreateDeveloperOutcome {
    const name = input.name.trim();
    const team = input.team.trim();
    const email = input.email?.trim() || undefined;
    // Provider ids are trimmed HERE, not just where they are checked: the guard
    // trims before `findByExternalId`, so storing an untrimmed value means the
    // string that was checked is not the string that was stored. ' alice' would
    // pass a lookup for 'alice', persist with the space, resolve nothing forever
    // (silent zero attribution), and still leave a later honest claim of 'alice'
    // looking free — two developers nominally owning one GitHub identity.
    const github = input.github?.trim() || undefined;
    const bitbucket = input.bitbucket?.trim() || undefined;
    const gitlab = input.gitlab?.trim() || undefined;
    // Split each entry into INDIVIDUAL addresses before it is either checked or
    // stored. Storage and lookup disagree about what one entry is: `joinGitEmails`
    // persists the set comma-joined WITHOUT splitting, while `buildDevLookupMap`
    // and `findByEmail` split the stored value on ',' and register each part as
    // its own lookup key. So 'evil@x.com,jane@corp.com' is uniqueness-checked as
    // one opaque string that matches nothing, then stored and split into a live
    // claim on jane@corp.com — silently re-pointing Jane's commit attribution at
    // whoever submitted it. A raw author's email column is provider-supplied and
    // unvalidated, so this reaches here from a crafted commit via promotion.
    // Tokenizing at the WRITE boundary is what closes it for every caller; the
    // admin route's own `gitEmailsField` is now a redundant second line, not the
    // only one.
    const gitEmails = tokenizeGitEmails(input.gitEmails ?? []);

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
                github,
                bitbucket,
                gitlab,
                emails: [
                    ...(email ? [{value: email, label: 'email'}] : []),
                    ...gitEmails.map((value) => ({value, label: 'git email'})),
                ],
            },
            null,
        );
        if (conflict) return {ok: false, reason: 'conflict', message: conflict};

        const developer = addDeveloper(db, name, team, email, github, {
            bitbucket,
            gitlab,
            gitEmails: gitEmails.length > 0 ? gitEmails : undefined,
        });

        // Inside the same transaction on purpose — see the module header. The developer row
        // is visible to `buildDevLookupMap` here (same connection), so the replay resolves
        // the identities that were just written.
        //
        // `deferReplay` is for BULK callers only: a `dates`-mode projection rebuilds whole
        // days across all developers, so running one per creation repeats nearly the same
        // rebuild N times. The bulk path creates everyone first and issues a single
        // `replayDevelopers` over the union instead (same output — the projection is
        // idempotent). It must never be set by a caller that doesn't then replay, or the
        // developer is created with their history left unattributed.
        const replay = options.deferReplay
            ? {cellsWritten: 0, cellsRetracted: 0, cellsSkippedLegacy: 0, datesCovered: 0}
            : replayDeveloper(db, developer.id);
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
 * Build the create input for an UNREVIEWED promotion: the provider login identity ONLY,
 * with the commit email deliberately dropped.
 *
 * A commit's `author_email` is set by whoever made the commit (`git config user.email`) and
 * is verified by no provider. `candidateCreateInput` seeds it as the developer's primary
 * `email`, which `buildDevLookupMap` registers as a GLOBAL attribution key — correct when an
 * admin is looking at the row and vouching for it (DO1.5), and unsafe when nobody is
 * (DO1.6). Without this, anyone who can push one commit to a scanned repo could set
 * `user.email` to a colleague's address and have the hands-off path mint a developer that
 * permanently claims it: every later unattributed row carrying that address projects onto
 * the impostor, and the colleague's own honest registration is refused as a conflict.
 *
 * The provider login is a different class of assertion — it comes from the provider's
 * account linkage, not from commit metadata — so it is the only identity auto-create
 * claims. Attribution still works, because `resolveDeveloperId` tries `${provider}:${login}`
 * FIRST and every row retained under a login key carries that login.
 *
 * The cost is deliberate: an author's login-less commits stay unattributed until a human
 * promotes them from the review queue. Under-attributing a real person is recoverable in one
 * click; mis-attributing one person's commits to another is a privacy breach that nothing
 * surfaces.
 */
function verifiedCreateInput(candidate: AuthorCandidate, team: string): CreateDeveloperInput {
    const login = candidate.login?.trim();
    const identities: Record<GitProviderType, string | undefined> = {
        github: undefined,
        bitbucket: undefined,
        gitlab: undefined,
    };
    if (login) identities[candidate.provider] = login;

    return {
        name: deriveCandidateName(candidate),
        team,
        // No `email`, no `gitEmails` — see above. Both are uniqueness-claiming lookup keys.
        github: identities.github,
        bitbucket: identities.bitbucket,
        gitlab: identities.gitlab,
    };
}

/** How a bulk promotion is scoped and classified. */
export interface PromoteAllOptions {
    /** Promote authors the classifier flagged as automation too. Never set by auto-create. */
    includeBots?: boolean;
    /**
     * Restrict promotion to these `raw_author_key`s (DO1.6: exactly the keys ONE sync run
     * retained). Omitted means "every current candidate", which is what the CLI's
     * `--promote-all` means. Scoping matters for the hands-off path: a run should act on
     * the authorship it just observed, not silently sweep up candidates an operator left
     * unpromoted in the review queue on purpose.
     */
    onlyKeys?: ReadonlySet<string>;
    /**
     * The operator's compiled `auto_create_exclude` denylist. Threaded into
     * {@link listAuthorCandidates} so `likely_bot` here is computed against the SAME rules
     * the skip decision below reads — never classified twice with two answers.
     */
    exclusions?: readonly RegExp[];
    /**
     * UNREVIEWED mode (#256's auto-create). Two effects, both fail-closed:
     *   - a candidate whose retained key is the EMAIL form is skipped entirely — a
     *     self-asserted address with no provider account behind it is not something to mint
     *     a developer from with no human in the loop; it stays in the review queue;
     *   - the developers that ARE created claim only their provider login, never the commit
     *     email (see {@link verifiedCreateInput}).
     * Left false for the admin/CLI surfaces, where a human is vouching for the row.
     */
    unreviewed?: boolean;
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
 * only what is still a candidate. When this runs INSIDE a caller's transaction (DO1.6 calls
 * it from the sync write transaction), better-sqlite3 turns each inner `db.transaction` into
 * a SAVEPOINT, so the per-promotion boundary still isolates one failure while the whole
 * batch remains atomic with the caller's cursor advance — a rolled-back sync creates nobody.
 */
export function promoteAllCandidates(
    db: Database.Database,
    team: string,
    options: PromoteAllOptions = {},
): BulkPromoteResult {
    const entries: BulkPromoteEntry[] = [];

    for (const candidate of listAuthorCandidates(db, options.exclusions ?? [])) {
        if (options.onlyKeys && !options.onlyKeys.has(candidate.raw_author_key)) continue;
        if (candidate.likely_bot && !options.includeBots) {
            entries.push({
                status: 'skipped_bot',
                candidate,
                reason: candidate.bot_reason ?? 'classified as automation',
            });
            continue;
        }
        // Unreviewed mode only mints developers for provider-VERIFIED identities. An
        // email-keyed author carries nothing but a self-asserted address, so it is held for
        // the review queue rather than acted on. Reported under `skipped_bot` so the count
        // is visible in the run summary — the shared "not onboarded automatically" bucket.
        if (options.unreviewed && !isLoginKey(candidate.provider, candidate.raw_author_key)) {
            entries.push({
                status: 'skipped_bot',
                candidate,
                reason: 'no provider login — a self-asserted commit email is not auto-created; promote it from the review queue',
            });
            continue;
        }
        const input = options.unreviewed
            ? verifiedCreateInput(candidate, team)
            : candidateCreateInput(candidate, team);
        // Replay DEFERRED — see below. Each create still gets its own transaction, so the
        // per-promotion failure isolation is unchanged.
        const outcome = createDeveloperWithReplay(db, input, {deferReplay: true});
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

    // ONE whole-day rebuild covering everyone just created, instead of one per promotion.
    // A `dates`-mode projection's cost is driven by the day set rather than by whose replay
    // requested it, and promoted candidates overwhelmingly share days, so the per-candidate
    // version re-rebuilt almost the same days once per author — quadratic in practice, and
    // holding the SQLite write lock throughout when this runs inside the sync write
    // transaction (#256). Idempotency is what makes the collapse exact: one pass over the
    // union writes precisely what N passes would have converged to.
    const promotedIds = entries.flatMap((e) => (e.status === 'promoted' ? [e.developer.id] : []));
    if (promotedIds.length > 0) {
        const {datesPerDeveloper} = replayDevelopers(db, promotedIds);
        for (const entry of entries) {
            if (entry.status !== 'promoted') continue;
            // Per-entry reporting stays per-developer: the operator-facing "N date(s)
            // attributed" is about THIS author's history, not the batch's total.
            entry.replay = {...entry.replay, datesCovered: datesPerDeveloper.get(entry.developer.id) ?? 0};
        }
    }

    return {
        entries,
        promoted: entries.filter((e) => e.status === 'promoted').length,
        skippedBots: entries.filter((e) => e.status === 'skipped_bot').length,
        failed: entries.filter((e) => e.status === 'failed').length,
    };
}
