import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam, archiveTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {upsertRawAuthorDaily, type RawAuthorDailyInput} from '../../../src/connectors/git/raw-author-daily';
import {listAuthorCandidates, type AuthorCandidate} from '../../../src/connectors/git/author-candidates';
import {
    candidateCreateInput,
    createDeveloperWithReplay,
    deriveCandidateName,
    promoteAllCandidates,
    promoteCandidate,
    MAX_DEVELOPER_NAME_LENGTH,
} from '../../../src/connectors/git/onboarding';
import type {GitProviderType} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

let db: Database.Database;

function makeDb(): Database.Database {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    runMigrations(database, MIGRATIONS_DIR);
    addTeam(database, 'eng');
    return database;
}

/** One retained raw daily fact. Defaults to a single-commit github day. */
function rawRow(over: Partial<RawAuthorDailyInput> & {raw_author_key: string}): RawAuthorDailyInput {
    return {
        provider: 'github' as GitProviderType,
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

/** Retain N days of authorship for one github login, one commit each. */
function seedGithubLogin(login: string, dates: string[], commitsPerDay = 1): void {
    for (const date of dates) {
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: `github:login:${login}`,
                author_login: login,
                author_email: `${login}@work.com`,
                author_display_name: null,
                date,
                commits: commitsPerDay,
            }),
        );
    }
}

function snapshotsFor(developerId: string): {date: string; commits: number}[] {
    return db
        .prepare('SELECT date, commits FROM git_snapshots WHERE developer_id = ? ORDER BY date')
        .all(developerId) as {date: string; commits: number}[];
}

function candidate(over: Partial<AuthorCandidate> = {}): AuthorCandidate {
    return {
        provider: 'github',
        raw_author_key: 'github:login:jane',
        login: 'jane',
        email: 'jane@work.com',
        display_name: 'Jane Doe',
        commit_count: 5,
        first_seen: '2026-07-01T00:00:00.000Z',
        last_seen: '2026-07-05T00:00:00.000Z',
        likely_bot: false,
        ...over,
    };
}

beforeEach(() => {
    db = makeDb();
});

afterEach(() => {
    db.close();
});

describe('createDeveloperWithReplay — create + attribute retained history atomically (#255)', () => {
    it('attributes the retained history the new identities resolve', () => {
        seedGithubLogin('jane', ['2026-07-01', '2026-07-02', '2026-07-03']);

        const outcome = createDeveloperWithReplay(db, {name: 'Jane', team: 'eng', github: 'jane'});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.replay.datesCovered).toBe(3);
        expect(snapshotsFor(outcome.developer.id).map((s) => s.date)).toEqual([
            '2026-07-01',
            '2026-07-02',
            '2026-07-03',
        ]);
    });

    it('reports zero attributed dates — and writes no snapshots — when nothing retained matches', () => {
        seedGithubLogin('jane', ['2026-07-01']);

        const outcome = createDeveloperWithReplay(db, {name: 'New Hire', team: 'eng', github: 'newbie'});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // The honest zero: a real developer, no retained authorship of theirs.
        expect(outcome.replay.datesCovered).toBe(0);
        expect(snapshotsFor(outcome.developer.id)).toEqual([]);
    });

    it('does not double-count when the same day is retained across two providers', () => {
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:login:jane',
                author_login: 'jane',
                date: '2026-07-01',
                commits: 3,
            }),
        );
        upsertRawAuthorDaily(
            db,
            rawRow({
                provider: 'bitbucket' as GitProviderType,
                raw_author_key: 'bitbucket:login:jane-bb',
                author_login: 'jane-bb',
                date: '2026-07-01',
                commits: 4,
            }),
        );

        const outcome = createDeveloperWithReplay(db, {
            name: 'Jane',
            team: 'eng',
            github: 'jane',
            bitbucket: 'jane-bb',
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // One (developer, date) cell holding the SUM once — not 3, not 14.
        expect(snapshotsFor(outcome.developer.id)).toEqual([{date: '2026-07-01', commits: 7}]);
    });

    it('is idempotent across a re-run: a second create for the same person conflicts, snapshots unchanged', () => {
        seedGithubLogin('jane', ['2026-07-01', '2026-07-02']);
        const first = createDeveloperWithReplay(db, {name: 'Jane', team: 'eng', github: 'jane'});
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const before = snapshotsFor(first.developer.id);

        const second = createDeveloperWithReplay(db, {name: 'Jane Again', team: 'eng', github: 'jane'});

        expect(second.ok).toBe(false);
        if (second.ok) return;
        expect(second.reason).toBe('conflict');
        expect(second.message).toContain('already mapped to Jane');
        expect(snapshotsFor(first.developer.id)).toEqual(before);
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 1});
    });

    it('rolls the whole create back on a duplicate email — no developer row survives', () => {
        addDeveloper(db, 'Existing', 'eng', 'taken@work.com');

        const outcome = createDeveloperWithReplay(db, {
            name: 'Impostor',
            team: 'eng',
            email: 'taken@work.com',
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.reason).toBe('conflict');
        expect(outcome.message).toContain("email 'taken@work.com' is already mapped to Existing");
        expect(db.prepare("SELECT COUNT(*) AS n FROM developers WHERE name = 'Impostor'").get()).toEqual({
            n: 0,
        });
    });

    it('fails closed on a team that does not exist', () => {
        const outcome = createDeveloperWithReplay(db, {name: 'Jane', team: 'ghost-team'});

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.reason).toBe('invalid_team');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 0});
    });

    it('fails closed on an archived team', () => {
        addTeam(db, 'legacy');
        archiveTeam(db, 'legacy');

        const outcome = createDeveloperWithReplay(db, {name: 'Jane', team: 'legacy'});

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.reason).toBe('invalid_team');
        expect(outcome.message).toContain('archived');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 0});
    });
});

describe('candidateCreateInput — seeding the create from a candidate', () => {
    it("writes the candidate's login onto ITS OWN provider, not github", () => {
        const input = candidateCreateInput(
            candidate({provider: 'bitbucket', raw_author_key: 'bitbucket:login:carol', login: 'carol'}),
            'eng',
        );

        expect(input.bitbucket).toBe('carol');
        expect(input.github).toBeUndefined();
        expect(input.gitlab).toBeUndefined();
    });

    it('routes a gitlab candidate to the gitlab field', () => {
        const input = candidateCreateInput(
            candidate({provider: 'gitlab', raw_author_key: 'gitlab:login:gina', login: 'gina'}),
            'eng',
        );

        expect(input.gitlab).toBe('gina');
        expect(input.github).toBeUndefined();
    });

    it("keeps the candidate's email as a git email when the operator overrides the primary one", () => {
        const input = candidateCreateInput(candidate({email: 'jane@work.com'}), 'eng', {
            email: 'jane@corp.com',
        });

        expect(input.email).toBe('jane@corp.com');
        // Dropping it is how a promotion "succeeds" and attributes nothing.
        expect(input.gitEmails).toEqual(['jane@work.com']);
    });

    it('does not duplicate the candidate email into git_emails when it IS the primary email', () => {
        const input = candidateCreateInput(candidate({email: 'jane@work.com'}), 'eng');

        expect(input.email).toBe('jane@work.com');
        expect(input.gitEmails).toEqual([]);
    });

    it('treats a case-differing override as the same address, not a second one', () => {
        const input = candidateCreateInput(candidate({email: 'jane@work.com'}), 'eng', {
            email: 'Jane@Work.com',
        });

        expect(input.gitEmails).toEqual([]);
    });

    it('carries an override for a DIFFERENT provider through alongside the candidate login', () => {
        const input = candidateCreateInput(
            candidate({provider: 'bitbucket', raw_author_key: 'bitbucket:login:carol', login: 'carol'}),
            'eng',
            {github: 'carol-gh'},
        );

        expect(input.bitbucket).toBe('carol');
        expect(input.github).toBe('carol-gh');
    });

    it('lets an explicit name override the derived one', () => {
        expect(candidateCreateInput(candidate(), 'eng', {name: 'Jane Q. Doe'}).name).toBe('Jane Q. Doe');
    });
});

describe('deriveCandidateName', () => {
    it('prefers the display name, then the login, then the email', () => {
        expect(deriveCandidateName(candidate())).toBe('Jane Doe');
        expect(deriveCandidateName(candidate({display_name: null}))).toBe('jane');
        expect(deriveCandidateName(candidate({display_name: null, login: null}))).toBe('jane@work.com');
    });

    it('clamps an unbounded provider-supplied name to the create limit', () => {
        const long = 'x'.repeat(500);

        const name = deriveCandidateName(candidate({display_name: long}));

        expect(name).toHaveLength(MAX_DEVELOPER_NAME_LENGTH);
    });
});

describe('promoteCandidate', () => {
    it('creates the developer and attributes their retained history in one call', () => {
        seedGithubLogin('jane', ['2026-07-01', '2026-07-02']);

        const outcome = promoteCandidate(db, 'github:login:jane', 'eng');

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.replay.datesCovered).toBe(2);
        expect(snapshotsFor(outcome.developer.id)).toHaveLength(2);
    });

    it('removes the promoted author from the candidate list (derived, no cleanup step)', () => {
        seedGithubLogin('jane', ['2026-07-01']);
        seedGithubLogin('bob', ['2026-07-01']);
        expect(listAuthorCandidates(db).map((c) => c.raw_author_key)).toContain('github:login:jane');

        promoteCandidate(db, 'github:login:jane', 'eng');

        const keys = listAuthorCandidates(db).map((c) => c.raw_author_key);
        expect(keys).not.toContain('github:login:jane');
        // Positive control: the OTHER unmatched author is still queued, so the
        // assertion above is about the promotion and not an empty list.
        expect(keys).toContain('github:login:bob');
    });

    it('refuses an unknown key rather than creating a developer for nobody', () => {
        const outcome = promoteCandidate(db, 'github:login:ghost', 'eng');

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.reason).toBe('candidate_not_found');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 0});
    });

    it('refuses a key that is already mapped, instead of minting a duplicate developer', () => {
        seedGithubLogin('jane', ['2026-07-01']);
        addDeveloper(db, 'Jane', 'eng', undefined, 'jane');

        const outcome = promoteCandidate(db, 'github:login:jane', 'eng');

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.reason).toBe('candidate_not_found');
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 1});
    });

    it('rejects a promotion whose overridden identity is already owned (409 message shape)', () => {
        seedGithubLogin('jane', ['2026-07-01']);
        addDeveloper(db, 'Existing', 'eng', undefined, 'taken-gh');

        const outcome = promoteCandidate(db, 'github:login:jane', 'eng', {github: 'taken-gh'});

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.reason).toBe('conflict');
        expect(outcome.message).toBe("github identity 'taken-gh' is already mapped to Existing");
    });

    it('attributes an email-keyed candidate that has no login at all', () => {
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:email:dan@work.com',
                author_login: null,
                author_email: 'dan@work.com',
                date: '2026-07-04',
                commits: 2,
            }),
        );

        const outcome = promoteCandidate(db, 'github:email:dan@work.com', 'eng');

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.developer.email).toBe('dan@work.com');
        expect(snapshotsFor(outcome.developer.id)).toEqual([{date: '2026-07-04', commits: 2}]);
    });
});

describe('promoteAllCandidates', () => {
    beforeEach(() => {
        seedGithubLogin('jane', ['2026-07-01', '2026-07-02']);
        seedGithubLogin('bob', ['2026-07-01']);
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:login:dependabot[bot]',
                author_login: 'dependabot[bot]',
                date: '2026-07-01',
                commits: 9,
            }),
        );
    });

    it('promotes the humans and skips the bots by default', () => {
        const result = promoteAllCandidates(db, 'eng');

        expect(result.promoted).toBe(2);
        expect(result.skippedBots).toBe(1);
        expect(result.failed).toBe(0);
        const names = (
            db.prepare('SELECT name FROM developers ORDER BY name').all() as {name: string}[]
        ).map((r) => r.name);
        expect(names).toEqual(['bob', 'jane']);
        // The skip carries the classifier's reason, not a bare boolean.
        const skipped = result.entries.find((e) => e.status === 'skipped_bot');
        expect(skipped?.status === 'skipped_bot' && skipped.reason).toContain('automation');
    });

    it('promotes bots too under --include-bots', () => {
        const result = promoteAllCandidates(db, 'eng', {includeBots: true});

        expect(result.promoted).toBe(3);
        expect(result.skippedBots).toBe(0);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM developers WHERE name = 'dependabot[bot]'").get(),
        ).toEqual({n: 1});
    });

    it('attributes each promoted developer their own history — nothing is merged or doubled', () => {
        const result = promoteAllCandidates(db, 'eng');

        const promoted = result.entries.filter((e) => e.status === 'promoted');
        const byName = new Map(
            promoted.map((e) => [
                e.status === 'promoted' ? e.developer.name : '',
                e.status === 'promoted' ? e.replay.datesCovered : -1,
            ]),
        );
        expect(byName.get('jane')).toBe(2);
        expect(byName.get('bob')).toBe(1);
    });

    it('empties the queue it promoted from', () => {
        promoteAllCandidates(db, 'eng', {includeBots: true});

        expect(listAuthorCandidates(db)).toEqual([]);
    });

    it('reports a mid-run conflict as a failed entry and keeps promoting the rest', () => {
        // A second key for a person the first promotion is about to create: the
        // guard must catch it, and it must not abort the whole run.
        upsertRawAuthorDaily(
            db,
            rawRow({
                provider: 'bitbucket' as GitProviderType,
                raw_author_key: 'bitbucket:email:jane@work.com',
                author_login: null,
                author_email: 'jane@work.com',
                date: '2026-07-05',
                commits: 1,
            }),
        );

        const result = promoteAllCandidates(db, 'eng');

        expect(result.failed).toBe(1);
        expect(result.promoted).toBe(2);
        const failure = result.entries.find((e) => e.status === 'failed');
        expect(failure?.status === 'failed' && failure.reason).toBe('conflict');
        expect(failure?.status === 'failed' && failure.message).toContain('already mapped to jane');
    });

    it('returns an empty, all-zero result when there is nothing to promote', () => {
        const fresh = makeDb();
        try {
            const result = promoteAllCandidates(fresh, 'eng');
            expect(result).toEqual({entries: [], promoted: 0, skippedBots: 0, failed: 0});
        } finally {
            fresh.close();
        }
    });
});
