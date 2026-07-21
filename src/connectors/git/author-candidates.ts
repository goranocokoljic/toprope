/**
 * Author candidates + the shared bot classifier (DO1.4 / #254, Epic DO1 / #250).
 *
 * #252 retained every author's daily facts in `raw_author_daily`; #253 made
 * `git_snapshots` a projection over them. What is still missing is the human-facing
 * half: which retained authors are NOT yet anybody, and which of those are worth an
 * admin's attention.
 *
 * This module answers exactly that, as a DERIVED VIEW:
 *
 *     listAuthorCandidates(db) = every retained raw identity MINUS everything the
 *                                identity map already resolves
 *
 * Deliberately not a stored `author_candidates` table. A stored list would be a second
 * source of truth that drifts the moment a developer is created, renamed, or has an
 * identity edited — someone would then have to remember to delete the row. Because this
 * is recomputed from (raw store, identity map) on every call, a candidate DISAPPEARS the
 * instant its identity is mapped, with no invalidation step to forget.
 *
 * The classifier is a pure function so DO1.5's review queue and DO1.6's auto-create can
 * share ONE definition of "this is a bot". Two copies would diverge, and the two callers
 * treat the answer very differently: auto-create makes it a hard skip, the queue only
 * flags it. That asymmetry is exactly why the classifier is CONSERVATIVE — see
 * {@link classifyAuthor}.
 *
 * Data layer + pure logic only: no HTTP, no CLI, no UI (those are #255/#256).
 */

import type Database from 'better-sqlite3';
import {
    distinctRawAuthorIdentities,
    type DistinctRawAuthor,
    type RawAuthorIdentityVariant,
} from './raw-author-daily.js';
import {buildDevLookupMap, resolveDeveloperId} from './projection.js';

/** What {@link classifyAuthor} is handed — the raw identity fields, both optional. */
export interface AuthorIdentityInput {
    login?: string | null;
    email?: string | null;
}

/**
 * The verdict. `reason` is present IFF `isBot` is true, and names the signal that
 * fired so a UI can show WHY an author was flagged rather than an unexplained badge.
 */
export interface AuthorClassification {
    isBot: boolean;
    reason?: string;
}

/**
 * One unmapped retained author, ready for review or promotion. Extends
 * {@link DistinctRawAuthor} (the raw store's rollup) rather than restating its fields, so
 * the candidate shape cannot drift from what the store actually aggregates.
 */
export interface AuthorCandidate extends DistinctRawAuthor {
    likely_bot: boolean;
    /** Present IFF `likely_bot` — the signal that fired. */
    bot_reason?: string;
}

/**
 * Email domains/hosts that identify a synthetic address rather than a person's mailbox.
 * Matched on the domain part only (after the last `@`), case-insensitively.
 *
 * Two generic shapes, not a curated host list: a `no-reply`/`noreply` label at the START
 * of the domain (`noreply.example.com`, and the bare `noreply` host), or one ANYWHERE as a
 * dot-delimited label (`users.noreply.github.com`, `x.no-reply.corp`). GitHub's
 * privacy-mode domain is deliberately NOT listed separately — it is matched by the second
 * pattern, and listing it would suggest the denylist is narrower than it is.
 *
 * Requiring a whole dot-delimited label is what keeps `replyto.example.com` and
 * `noreplyclothing.com` out. Note this is a WEAK signal about botness: a real human with
 * "keep my email private" enabled commits from `users.noreply.github.com`. It is therefore
 * only ever consulted for an author with NO login at all (see {@link classifyAuthor}).
 */
const NOREPLY_DOMAIN_PATTERNS: readonly RegExp[] = [
    /^no-?reply(\.|$)/,
    /\.no-?reply\./,
];

/**
 * Known automation logins, matched against the login LOWERCASED and stripped of a
 * trailing `[bot]`/`-bot`/`_bot` suffix (so `dependabot[bot]`, `Dependabot` and
 * `dependabot` are one entry, not three).
 *
 * Deliberately an exact-match set rather than substring matching: a substring rule would
 * flag `robotnik`, `abbott`, or a person whose login merely contains `snyk`. Under this
 * module's conservative bias a missed bot is cheap (an admin sees one extra row and
 * ignores it) while a false bot is expensive (a real developer is silently hidden from
 * the queue and hard-skipped by auto-create), so precision wins over recall.
 *
 * DO1.6 layers operator-supplied extra patterns on top of this via config; this set is
 * the shared floor, not the whole vocabulary.
 */
const KNOWN_BOT_LOGINS: ReadonlySet<string> = new Set([
    'dependabot',
    'renovate',
    'github-actions',
    'actions-user',
    'mergify',
    'snyk',
    'greenkeeper',
    'imgbot',
    'codecov',
    'semantic-release',
    'allcontributors',
    'sonarcloud',
    'stale',
    'copilot',
    'web-flow',
]);

/**
 * Login placeholders that carry no identity — the shapes a provider emits when it has
 * nothing to report. Matched lowercased and exactly; these are not people, but they are
 * not really bots either, so they are flagged under the same `isBot` gate purely to keep
 * them out of auto-create.
 */
const PLACEHOLDER_LOGINS: ReadonlySet<string> = new Set([
    'unknown',
    'none',
    'null',
    'n/a',
    'na',
    'anonymous',
    'ghost',
]);

/** A bot-suffixed login: `dependabot[bot]`, `renovate-bot`, `foo_bot`. */
const BOT_SUFFIX_RE = /(\[bot\]|[-_]bot)$/;

/** Strip the bot suffix so the known-bot set holds one entry per bot, not one per spelling. */
function stripBotSuffix(login: string): string {
    return login.replace(BOT_SUFFIX_RE, '');
}

/**
 * How much of a login {@link classifyAuthor} will quote back inside a `reason`. `reason`
 * is provider-supplied text headed for an admin UI (#255) and nothing upstream bounds
 * `author_login` — `upsertRawAuthorDaily` shape-validates the key, the date and the
 * metrics, but passes the identity columns through verbatim. A self-hosted instance can
 * hand back a login of arbitrary length, so the quote is capped where it is minted rather
 * than trusting every future renderer to cope. (The reason is human-readable prose, NOT a
 * machine-readable field: callers branch on `isBot`/`likely_bot`, never on this string.)
 */
const REASON_LOGIN_MAX = 64;

/** The login as it will appear inside a reason: bounded, with the truncation made visible. */
function quoteLogin(login: string): string {
    return login.length <= REASON_LOGIN_MAX ? login : `${login.slice(0, REASON_LOGIN_MAX)}…`;
}

/** The domain part of an email, lowercased — or null if it isn't shaped like an address. */
function emailDomain(email: string): string | null {
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1) return null;
    return email.slice(at + 1).toLowerCase();
}

/**
 * Decide whether a raw git author is automation rather than a person.
 *
 * CONSERVATIVE BY CONTRACT: when the signals are ambiguous the answer is `isBot: false`.
 * The two outcomes are not symmetric —
 *   - a false HUMAN costs an admin one extra reviewable row, which they dismiss; but
 *   - a false BOT silently hides a real developer (the queue de-emphasises them and
 *     DO1.6's auto-create hard-skips them), and nothing surfaces the mistake.
 * So every rule below must be a POSITIVE match on a documented signal. There is no
 * heuristic fall-through, and no rule may fire merely because a field is missing.
 *
 * Signals, in order:
 *   1. an empty/whitespace identity on BOTH fields — nothing to promote;
 *   2. a login in {@link KNOWN_BOT_LOGINS} (after suffix-stripping);
 *   3. a `[bot]` / `-bot` / `_bot` login suffix;
 *   4. a placeholder login ({@link PLACEHOLDER_LOGINS});
 *   5. a no-reply email domain — ONLY when the author has no login at all.
 *
 * Rules 2 and 3 are in that order on purpose. Both fire for `dependabot[bot]`, and the
 * named-bot answer is the more specific one; running the generic suffix rule first would
 * shadow it, leaving `stripBotSuffix` unreachable and every `*-bot` entry in the set dead.
 * The verdict is the same either way — only the `reason` differs — but a dead branch is
 * how a set entry silently stops meaning anything.
 *
 * Rule 5's login guard is the important one: GitHub's privacy mode gives ordinary humans
 * a `users.noreply.github.com` commit address, so flagging on the email alone would mark
 * every privacy-conscious developer a bot. With a login present the login rules already
 * had their say and the email adds nothing trustworthy; without one, the address is the
 * only identity there is and a no-reply address is not a person to promote.
 *
 * Pure: no DB, no clock, no config. Shared verbatim by DO1.5's queue and DO1.6's
 * auto-create so the two can never disagree about what a bot is.
 */
export function classifyAuthor(author: AuthorIdentityInput): AuthorClassification {
    const login = (author.login ?? '').trim();
    const email = (author.email ?? '').trim();

    if (!login && !email) {
        return {isBot: true, reason: 'empty identity (no login, no email)'};
    }

    if (login) {
        const lower = login.toLowerCase();
        const quoted = quoteLogin(login);

        if (KNOWN_BOT_LOGINS.has(stripBotSuffix(lower))) {
            return {isBot: true, reason: `login "${quoted}" is a known automation account`};
        }

        if (BOT_SUFFIX_RE.test(lower)) {
            return {isBot: true, reason: `login "${quoted}" carries a bot suffix`};
        }

        if (PLACEHOLDER_LOGINS.has(lower)) {
            return {isBot: true, reason: `login "${quoted}" is a placeholder, not an identity`};
        }

        // A login is present and matched nothing. Do NOT consult the email: a human on
        // GitHub privacy mode has a noreply address, and hiding them is the expensive
        // error. Uncertain -> human.
        return {isBot: false};
    }

    const domain = emailDomain(email);
    if (domain && NOREPLY_DOMAIN_PATTERNS.some((re) => re.test(domain))) {
        return {isBot: true, reason: `email domain "${domain}" is a no-reply address`};
    }

    return {isBot: false};
}

/**
 * Code-unit comparison, matching SQLite's BINARY collation. `localeCompare` would order
 * the same keys differently from the SQL this list is derived from, which is the kind of
 * mismatch that only shows up once a non-ASCII login appears.
 */
function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Keep a known value rather than letting a variant that lacks the field erase it. */
function firstKnown(kept: string | null, next: string | null): string | null {
    return kept ?? next;
}

/**
 * Roll a second unattributed variant of the same key into the accumulated candidate.
 *
 * `distinctRawAuthorIdentities` returns a key's variants in `commit_count DESC` order, so
 * `kept` is always the BUSIEST one — its login/email are what a promote form should
 * pre-fill, and the merge only ever fills in fields it was missing. `first_seen`/`last_seen`
 * are shape-pinned UTC ISO instants at the write boundary, so comparing them as strings is
 * sound (that pin is exactly what makes it sound — see UTC_ISO_INSTANT_RE in the store).
 */
function foldVariant(kept: DistinctRawAuthor, next: RawAuthorIdentityVariant): DistinctRawAuthor {
    return {
        ...kept,
        login: firstKnown(kept.login, next.login),
        email: firstKnown(kept.email, next.email),
        display_name: firstKnown(kept.display_name, next.display_name),
        commit_count: kept.commit_count + next.commit_count,
        first_seen: compareText(next.first_seen, kept.first_seen) < 0 ? next.first_seen : kept.first_seen,
        last_seen: compareText(next.last_seen, kept.last_seen) > 0 ? next.last_seen : kept.last_seen,
    };
}

/**
 * Every retained raw author with activity that resolves to NO developer under the CURRENT
 * identity map, busiest first.
 *
 * RESOLVED PER IDENTITY VARIANT, not per author, and this is the whole subtlety of the
 * function. Attribution happens per row: the projection resolves each retained row's own
 * `(author_login, author_email)`, and `sync.ts` stamps one run's sample commit email onto
 * every date row that run writes — so one login key can carry a mapped address on some days
 * and an unmapped one on others. Collapsing the key to a single email first (what
 * `distinctRawAuthors` does, correctly, for its own callers) would then get BOTH directions
 * wrong:
 *   - the collapsed email happens to be the MAPPED one → the author vanishes from the queue
 *     while their other days project to nobody. Silently unattributed history with no
 *     surface reporting it is precisely the failure this epic exists to end.
 *   - the collapsed email happens to be the UNMAPPED one → the author is listed with a
 *     `commit_count` that includes commits ALREADY attributed to an existing developer, and
 *     #256's auto-create mints a duplicate record for a person who is already here.
 * Folding only the UNATTRIBUTED variants makes `commit_count` mean what a reviewer reads it
 * as: commits currently waiting to be attributed.
 *
 * Cost is two queries total regardless of author count — `distinctRawAuthorIdentities` (one
 * grouped rollup) and `buildDevLookupMap` (one scan of `developers`) — then an in-memory
 * check per variant. Never a lookup per row.
 *
 * Ordering is `commit_count DESC, raw_author_key ASC`, applied here rather than inherited:
 * the store's readers sort by `commit_count DESC, last_seen DESC, …` for their own callers,
 * and a candidate list whose order depends on `last_seen` would reshuffle on every sync even
 * when nothing about the candidates changed. The comparator is TOTAL — `raw_author_key`
 * embeds its provider and `(provider, raw_author_key)` is UNIQUE in the store, so the key
 * alone is a unique final tiebreak and no two rows can compare equal.
 *
 * KNOWN LIMIT, inherited deliberately: `resolveDeveloperId` matches a provider login
 * CASE-SENSITIVELY, so a developer registered as `--github alice` against an API that
 * reports `Alice` is listed here as a candidate. That is self-consistent — the projection
 * fails to attribute that author too, so surfacing them reports a real mapping defect rather
 * than inventing one — and making the resolver case-insensitive is a cross-cutting identity
 * change for the epic, not this module's to make unilaterally.
 *
 * The result is derived, never stored: mapping a candidate's identity to a developer removes
 * it from the next call with no invalidation step.
 */
export function listAuthorCandidates(db: Database.Database): AuthorCandidate[] {
    const lookup = buildDevLookupMap(db);

    const unattributed = new Map<string, DistinctRawAuthor>();
    for (const variant of distinctRawAuthorIdentities(db)) {
        if (resolveDeveloperId(lookup, variant.provider, variant.login, variant.email) !== null) continue;
        const kept = unattributed.get(variant.raw_author_key);
        unattributed.set(variant.raw_author_key, kept ? foldVariant(kept, variant) : variant);
    }

    const candidates = [...unattributed.values()].map((author): AuthorCandidate => {
        const {isBot, reason} = classifyAuthor({login: author.login, email: author.email});
        return {
            ...author,
            likely_bot: isBot,
            ...(isBot && reason ? {bot_reason: reason} : {}),
        };
    });

    return candidates.sort(
        (a, b) => b.commit_count - a.commit_count || compareText(a.raw_author_key, b.raw_author_key),
    );
}
