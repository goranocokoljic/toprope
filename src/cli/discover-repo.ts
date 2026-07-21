/**
 * `toprope dev discover-repo` — discover developers from the repositories you already
 * synced (DO1.5 / #255, Epic DO1 / #250).
 *
 * The existing `dev discover` reads GitHub ORG MEMBERS: it needs a GitHub org, a token with
 * org scope, and it happily creates developers who never touched a repo while missing every
 * contractor, Bitbucket user and GitLab user who did. This command is its provider-agnostic
 * sibling and works off what sync actually observed — the `raw_author_daily` authorship
 * retained by #252/#253 — so "who is in this codebase" is answered by the codebase.
 *
 * Deliberately NOT a fork of `discoverOrgMembers`: no shared logic is copied. Listing is
 * `listAuthorCandidates` (#254) and promotion is `promoteCandidate` /
 * `promoteAllCandidates` (`connectors/git/onboarding`), the same functions the Admin review
 * queue calls through the HTTP API. This module is presentation and argument handling only.
 *
 * Rendering lives here rather than in `cli.ts` so it can be tested; each `run*` returns the
 * process exit code instead of calling `process.exit`, so a test can assert failure without
 * killing the runner.
 */

import type Database from 'better-sqlite3';
import {listAuthorCandidates, type AuthorCandidate} from '../connectors/git/author-candidates';
import {
    promoteAllCandidates,
    promoteCandidate,
    type PromoteOverrides,
} from '../connectors/git/onboarding';

/** The identity a reader recognises the candidate by: login when there is one, else email. */
function candidateLabel(candidate: AuthorCandidate): string {
    return candidate.login ?? candidate.email ?? candidate.raw_author_key;
}

/**
 * One candidate as a single line. The `[likely-bot]` flag is a suffix, not a filter — the
 * queue only ever FLAGS automation (auto-create is the surface that hard-skips it), so an
 * operator can still promote a misclassified account, and the reason explains the badge
 * rather than leaving it unexplained.
 */
export function formatCandidateRow(candidate: AuthorCandidate): string {
    const commits = `${candidate.commit_count} commit${candidate.commit_count === 1 ? '' : 's'}`;
    const display =
        candidate.display_name && candidate.display_name !== candidateLabel(candidate)
            ? ` (${candidate.display_name})`
            : '';
    const bot = candidate.likely_bot ? `  [likely-bot: ${candidate.bot_reason ?? 'automation'}]` : '';
    return (
        `  ${candidate.raw_author_key}\n` +
        `      ${candidate.provider}  ${candidateLabel(candidate)}${display}  ` +
        `${commits}  last seen ${candidate.last_seen}${bot}`
    );
}

/** Print the review queue. Returns the exit code (always 0 — an empty queue is not an error). */
export function runListCandidates(db: Database.Database): number {
    const candidates = listAuthorCandidates(db);
    if (candidates.length === 0) {
        console.log(
            'No unmatched authors. Every git author in the synced history already maps to a developer.',
        );
        return 0;
    }

    const bots = candidates.filter((c) => c.likely_bot).length;
    console.log(
        `${candidates.length} unmatched author(s)${bots > 0 ? ` (${bots} flagged as likely bots)` : ''}:`,
    );
    for (const candidate of candidates) console.log(formatCandidateRow(candidate));
    console.log('');
    console.log(
        'Promote one:  toprope dev discover-repo --promote <raw_author_key> --name <name> --team <team>',
    );
    console.log('Promote all:  toprope dev discover-repo --promote-all --team <team>');
    return 0;
}

/** Promote a single candidate by key. Returns 0 on success, 1 on any refusal. */
export function runPromoteCandidate(
    db: Database.Database,
    rawAuthorKey: string,
    team: string,
    overrides: PromoteOverrides = {},
): number {
    const outcome = promoteCandidate(db, rawAuthorKey, team, overrides);
    if (!outcome.ok) {
        console.error(`Error: ${outcome.message}`);
        return 1;
    }

    const {developer, replay} = outcome;
    console.log(`Developer '${developer.name}' created with id: ${developer.id} (team: ${developer.team})`);
    console.log(
        `Attributed ${replay.datesCovered} snapshot date(s) of retained history ` +
            `(${replay.cellsWritten} cell(s) written).`,
    );
    if (replay.datesCovered === 0) {
        console.log(
            'Note: no retained authorship resolved to these identities — check the login/email spelling.',
        );
    }
    return 0;
}

/**
 * Bulk-promote the queue. Returns 0 when nothing failed, 1 when at least one candidate was
 * refused — a partial success is still a non-zero exit so a script does not read "some
 * developers were created" as "all of them were".
 */
export function runPromoteAllCandidates(
    db: Database.Database,
    team: string,
    options: {includeBots?: boolean} = {},
): number {
    const result = promoteAllCandidates(db, team, options);

    if (result.entries.length === 0) {
        console.log('No unmatched authors to promote.');
        return 0;
    }

    let attributedDates = 0;
    for (const entry of result.entries) {
        const label = candidateLabel(entry.candidate);
        if (entry.status === 'promoted') {
            attributedDates += entry.replay.datesCovered;
            console.log(
                `  + ${label} -> ${entry.developer.name} (${entry.developer.id}) — ` +
                    `${entry.replay.datesCovered} date(s) attributed`,
            );
        } else if (entry.status === 'skipped_bot') {
            console.log(`  - ${label} skipped (${entry.reason}) — use --include-bots to promote it`);
        } else {
            console.error(`  ! ${label} failed: ${entry.message}`);
        }
    }

    console.log(
        `Promoted ${result.promoted} developer(s), attributing ${attributedDates} snapshot date(s); ` +
            `skipped ${result.skippedBots} likely bot(s); ${result.failed} failed.`,
    );
    return result.failed > 0 ? 1 : 0;
}
