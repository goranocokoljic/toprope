import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {upsertRawAuthorDaily, type RawAuthorDailyInput} from '../../src/connectors/git/raw-author-daily';
import {
    formatCandidateRow,
    runListCandidates,
    runPromoteAllCandidates,
    runPromoteCandidate,
} from '../../src/cli/discover-repo';
import type {AuthorCandidate} from '../../src/connectors/git/author-candidates';
import type {GitProviderType} from '../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

let db: Database.Database;
let out: string[];
let err: string[];

function rawRow(over: Partial<RawAuthorDailyInput> & {raw_author_key: string}): RawAuthorDailyInput {
    return {
        provider: 'github' as GitProviderType,
        container: 'acme',
        author_login: null,
        author_email: null,
        author_display_name: null,
        date: '2026-07-01',
        commits: 1,
        lines_added: 10,
        lines_removed: 2,
        files_changed: 1,
        prs_opened: 0,
        prs_merged: 0,
        review_comments_given: 0,
        avg_time_to_merge_hours: null,
        code_churn_rate: 0,
        ai_signature_score: 0,
        avg_commit_size: 12,
        commit_burst_count: 0,
        ...over,
    };
}

function seedGithubLogin(login: string, dates: string[]): void {
    for (const date of dates) {
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: `github:login:${login}`,
                author_login: login,
                author_email: `${login}@work.com`,
                date,
            }),
        );
    }
}

/** Everything the command printed to stdout, as one blob. */
function stdout(): string {
    return out.join('\n');
}

function stderr(): string {
    return err.join('\n');
}

beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    addTeam(db, 'eng');
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        err.push(args.map(String).join(' '));
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    db.close();
});

describe('formatCandidateRow', () => {
    const base: AuthorCandidate = {
        provider: 'github',
        raw_author_key: 'github:login:jane',
        login: 'jane',
        email: 'jane@work.com',
        display_name: 'Jane Doe',
        commit_count: 12,
        first_seen: '2026-07-01T00:00:00.000Z',
        last_seen: '2026-07-05T00:00:00.000Z',
        likely_bot: false,
    };

    it('shows the key, provider, identity, commit count and last-seen date', () => {
        const row = formatCandidateRow(base);

        expect(row).toContain('github:login:jane');
        expect(row).toContain('github');
        expect(row).toContain('jane');
        expect(row).toContain('12 commits');
        expect(row).toContain('2026-07-05');
    });

    it('singularizes a one-commit author', () => {
        expect(formatCandidateRow({...base, commit_count: 1})).toContain('1 commit ');
    });

    it('flags a bot with its reason, and leaves a human unflagged', () => {
        const bot = formatCandidateRow({
            ...base,
            likely_bot: true,
            bot_reason: 'login "dependabot[bot]" is a known automation account',
        });

        expect(bot).toContain('[likely-bot:');
        expect(bot).toContain('known automation account');
        // Positive control: the same row without the flag has no badge at all.
        expect(formatCandidateRow(base)).not.toContain('likely-bot');
    });
});

describe('runListCandidates', () => {
    it('says so plainly when nothing is unmatched', () => {
        expect(runListCandidates(db)).toBe(0);
        expect(stdout()).toContain('No unmatched authors');
    });

    it('lists candidates busiest-first with a bot count in the header', () => {
        seedGithubLogin('jane', ['2026-07-01', '2026-07-02', '2026-07-03']);
        seedGithubLogin('bob', ['2026-07-01']);
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:renovate', author_login: 'renovate'}),
        );

        expect(runListCandidates(db)).toBe(0);

        const text = stdout();
        expect(text).toContain('3 unmatched author(s)');
        expect(text).toContain('(1 flagged as likely bots)');
        // Busiest first: jane (3 commits) is printed before bob (1).
        expect(text.indexOf('github:login:jane')).toBeLessThan(text.indexOf('github:login:bob'));
        expect(text).toContain('--promote-all --team');
    });

    it('omits the bot count when every candidate is human', () => {
        seedGithubLogin('jane', ['2026-07-01']);

        runListCandidates(db);

        expect(stdout()).toContain('1 unmatched author(s):');
        expect(stdout()).not.toContain('flagged as likely bots');
    });
});

describe('runPromoteCandidate', () => {
    it('creates the developer, attributes the history, and reports the date count', () => {
        seedGithubLogin('jane', ['2026-07-01', '2026-07-02']);

        expect(runPromoteCandidate(db, 'github:login:jane', 'eng')).toBe(0);

        expect(stdout()).toContain('Attributed 2 snapshot date(s)');
        const rows = db.prepare('SELECT COUNT(*) AS n FROM git_snapshots').get();
        expect(rows).toEqual({n: 2});
    });

    it('applies the --name override to the created developer', () => {
        seedGithubLogin('jane', ['2026-07-01']);

        runPromoteCandidate(db, 'github:login:jane', 'eng', {name: 'Jane Q. Doe'});

        expect(db.prepare('SELECT name FROM developers').get()).toEqual({name: 'Jane Q. Doe'});
    });

    it('warns when a promotion attributed nothing rather than reporting a bare success', () => {
        // A LOGIN-ONLY candidate (no email to fall back on), promoted with a
        // github override that matches nothing retained — created, but zero
        // history recovered. With an email on the candidate this would still
        // attribute, which is exactly why the fixture withholds one.
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:jane', author_login: 'jane', author_email: null}),
        );

        runPromoteCandidate(db, 'github:login:jane', 'eng', {github: 'someone-else'});

        expect(stdout()).toContain('Attributed 0 snapshot date(s)');
        expect(stdout()).toContain('no retained authorship resolved');
    });

    it('exits non-zero on an unknown key and creates nothing', () => {
        expect(runPromoteCandidate(db, 'github:login:ghost', 'eng')).toBe(1);

        expect(stderr()).toContain('No unmatched author with key');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 0});
    });

    it('exits non-zero on a duplicate identity, surfacing the conflict message', () => {
        seedGithubLogin('jane', ['2026-07-01']);
        addDeveloper(db, 'Existing', 'eng', undefined, 'taken-gh');

        expect(runPromoteCandidate(db, 'github:login:jane', 'eng', {github: 'taken-gh'})).toBe(1);

        expect(stderr()).toContain("github identity 'taken-gh' is already mapped to Existing");
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 1});
    });

    it('exits non-zero on an unknown team without creating a partial developer', () => {
        seedGithubLogin('jane', ['2026-07-01']);

        expect(runPromoteCandidate(db, 'github:login:jane', 'ghost-team')).toBe(1);

        expect(stderr()).toContain("Team 'ghost-team' does not exist");
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 0});
    });
});

describe('runPromoteAllCandidates', () => {
    beforeEach(() => {
        seedGithubLogin('jane', ['2026-07-01', '2026-07-02']);
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:renovate', author_login: 'renovate'}),
        );
    });

    it('promotes humans, skips bots, and totals the attributed dates', () => {
        expect(runPromoteAllCandidates(db, 'eng')).toBe(0);

        const text = stdout();
        expect(text).toContain('Promoted 1 developer(s);');
        expect(text).toContain('2 date(s) attributed');
        expect(text).toContain('skipped 1 likely bot(s)');
        expect(text).toContain('--include-bots');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 1});
    });

    it('includes bots under --include-bots', () => {
        expect(runPromoteAllCandidates(db, 'eng', {includeBots: true})).toBe(0);

        expect(stdout()).toContain('skipped 0 likely bot(s)');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 2});
    });

    it('exits non-zero on a partial failure so a script cannot read it as complete', () => {
        // Every candidate fails: the team does not exist.
        expect(runPromoteAllCandidates(db, 'ghost-team')).toBe(1);

        expect(stderr()).toContain('does not exist');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 0});
    });

    it('reports an empty queue without touching the registry', () => {
        const fresh = new Database(':memory:');
        try {
            fresh.pragma('foreign_keys = ON');
            runMigrations(fresh, MIGRATIONS_DIR);
            addTeam(fresh, 'eng');

            expect(runPromoteAllCandidates(fresh, 'eng')).toBe(0);
            expect(stdout()).toContain('No unmatched authors to promote');
        } finally {
            fresh.close();
        }
    });
});
