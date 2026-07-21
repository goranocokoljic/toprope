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
 *     listAuthorCandidates(db) = distinctRawAuthors(db) MINUS everything the identity
 *                                map already resolves
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
import {distinctRawAuthors, type DistinctRawAuthor} from './raw-author-daily.js';
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
 * Matched on the domain part only (after the last `@`), case-insensitively:
 *
 *   - `users.noreply.github.com` — GitHub's privacy-mode commit address. NOTE this is a
 *     WEAK signal about botness: a real human with "keep my email private" enabled commits
 *     from exactly this domain. It is only ever consulted for an author with NO login (see
 *     {@link classifyAuthor}), where there is no person-shaped identity to promote anyway.
 *   - a `noreply.`-prefixed or bare `noreply`/`no-reply` host — the generic shape of an
 *     unattended sender address.
 */
const NOREPLY_DOMAIN_PATTERNS: readonly RegExp[] = [
    /^users\.noreply\.github\.com$/,
    /^no-?reply(\.|$)/,
    /(^|\.)no-?reply\./,
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
    'renovate-bot',
    'github-actions',
    'actions-user',
    'mergify',
    'snyk',
    'snyk-bot',
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
 *   2. a `[bot]` / `-bot` / `_bot` login suffix;
 *   3. a login in {@link KNOWN_BOT_LOGINS} (after suffix-stripping);
 *   4. a placeholder login ({@link PLACEHOLDER_LOGINS});
 *   5. a no-reply email domain — ONLY when the author has no login at all.
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

        if (BOT_SUFFIX_RE.test(lower)) {
            return {isBot: true, reason: `login "${login}" carries a bot suffix`};
        }

        const base = stripBotSuffix(lower);
        if (KNOWN_BOT_LOGINS.has(base)) {
            return {isBot: true, reason: `login "${login}" is a known automation account`};
        }

        if (PLACEHOLDER_LOGINS.has(lower)) {
            return {isBot: true, reason: `login "${login}" is a placeholder, not an identity`};
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

/**
 * Every retained raw author that resolves to NO developer under the CURRENT identity map,
 * busiest first.
 *
 * Cost is two queries total regardless of author count — `distinctRawAuthors` (one grouped
 * rollup) and `buildDevLookupMap` (one scan of `developers`) — then an in-memory check per
 * author. Never a lookup per row.
 *
 * Ordering is `commit_count DESC, raw_author_key ASC`, applied here rather than inherited:
 * `distinctRawAuthors` sorts by `commit_count DESC, last_seen DESC, …` for its own callers,
 * and a candidate list whose order depends on `last_seen` would reshuffle on every sync
 * even when nothing about the candidates changed. The comparator is TOTAL —
 * `raw_author_key` embeds its provider and `(provider, raw_author_key)` is UNIQUE in the
 * store, so the key alone is a unique final tiebreak and no two rows can compare equal.
 *
 * The result is derived, never stored: mapping a candidate's identity to a developer
 * removes it from the next call with no invalidation step.
 */
export function listAuthorCandidates(db: Database.Database): AuthorCandidate[] {
    const lookup = buildDevLookupMap(db);

    const candidates = distinctRawAuthors(db)
        .filter((author) => resolveDeveloperId(lookup, author.provider, author.login, author.email) === null)
        .map((author): AuthorCandidate => {
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
