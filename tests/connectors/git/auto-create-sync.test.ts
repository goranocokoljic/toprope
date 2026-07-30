/**
 * Opt-in auto-create during sync (DO1.6 / #256, Epic DO1 / #250).
 *
 * These tests drive the REAL sync write path — a mocked provider returning commits, then
 * `GitSync.sync` — rather than calling the onboarding helpers directly. The whole feature is
 * about where the create sits relative to retention, projection and the cursor advance, and
 * only the real path can prove that.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam, getTeam, archiveTeam} from '../../../src/registry/teams';
import {addDeveloper, listDevelopers} from '../../../src/registry/developers';
import type {Developer} from '../../../src/registry/types';
import {
    GitSync,
    AUTO_CREATE_SUMMARY_PREFIX,
    UNMATCHED_AUTHORS_PREFIX,
    LEGACY_CELLS_SKIPPED_PREFIX,
    isAdvisoryError,
    autoCreateFailureLine,
} from '../../../src/connectors/git/sync';
import {listAuthorCandidates} from '../../../src/connectors/git/author-candidates';
import {createDeveloperWithReplay} from '../../../src/connectors/git/onboarding';
import type {GitConnectorConfig} from '../../../src/config/types';
import type {GitProvider, GitRepo, GitCommit, GitFileDiff} from '../../../src/connectors/git/providers/types';

vi.mock('../../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const DAY = '2024-01-15';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function config(overrides: Partial<GitConnectorConfig> = {}): GitConnectorConfig {
    return {
        enabled: true,
        providers: [{type: 'github', org: 'test-org', auth: {type: 'token', api_token: 't'}}],
        ...overrides,
    };
}

function makeRepo(name: string): GitRepo {
    return {id: name, name, fullName: `test-org/${name}`, defaultBranch: 'main', isArchived: false};
}

let shaCounter = 0;
function commitBy(username: string | null, email: string, sha?: string, day = DAY): GitCommit {
    return {
        sha: sha ?? `sha-${++shaCounter}`,
        author: {name: username ?? email, email, username: username ?? undefined},
        date: `${day}T10:00:00Z`,
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        filesChanged: ['src/foo.ts'],
        // Carried on the commit, which is the path every in-tree provider takes since #271 —
        // the sync loop reuses this and never calls `getCommitDiff` (#280). Before that this
        // whole file exercised the fallback branch instead.
        diffs: DIFFS,
    };
}

const DIFFS: GitFileDiff[] = [{path: 'src/foo.ts', additions: 50, deletions: 10, status: 'modified'}];

function mockProvider(commits: GitCommit[]): GitProvider {
    return {
        name: 'github',
        listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
        getCommits: vi.fn().mockResolvedValue(commits),
        getPullRequests: vi.fn().mockResolvedValue([]),
        getReviewComments: vi.fn().mockResolvedValue([]),
        getPRReviews: vi.fn().mockResolvedValue([]),
        getCommitDiff: vi.fn().mockResolvedValue(DIFFS),
        checkAccess: vi.fn().mockResolvedValue(undefined),
    };
}

async function installProvider(commits: GitCommit[]): Promise<GitProvider> {
    const {createGitProvider} = await import('../../../src/connectors/git/providers/factory');
    const provider = mockProvider(commits);
    (createGitProvider as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    return provider;
}

function snapshotsFor(db: Database.Database, developerId: string): {commits: number; date: string}[] {
    return db
        .prepare('SELECT date, commits FROM git_snapshots WHERE developer_id = ? ORDER BY date')
        .all(developerId) as {commits: number; date: string}[];
}

function totalCommits(db: Database.Database): number {
    const row = db.prepare('SELECT COALESCE(SUM(commits), 0) AS n FROM git_snapshots').get() as {n: number};
    return row.n;
}

function developerNamed(db: Database.Database, name: string): Developer | undefined {
    return listDevelopers(db).find((d) => d.name === name);
}

describe('auto-create developers during sync (#256)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
        shaCounter = 0;
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    describe('flag OFF (the default)', () => {
        it('creates no developers and behaves exactly as before', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            const result = await new GitSync(config()).sync(db);

            expect(listDevelopers(db)).toHaveLength(0);
            expect(totalCommits(db)).toBe(0);
            // Retained + advisory — the pre-#256 steady state, unchanged.
            expect(result.errors.some((e) => e.startsWith(UNMATCHED_AUTHORS_PREFIX))).toBe(true);
            expect(result.errors.some((e) => e.startsWith(AUTO_CREATE_SUMMARY_PREFIX))).toBe(false);
            expect(listAuthorCandidates(db).map((c) => c.login)).toEqual(['alice']);
        });

        it('creates no developers when the flag is explicitly false but a team is configured', async () => {
            addTeam(db, 'discovered');
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            await new GitSync(
                config({auto_create_developers: false, auto_create_team: 'discovered'}),
            ).sync(db);

            expect(listDevelopers(db)).toHaveLength(0);
        });
    });

    describe('flag ON', () => {
        it('creates the human author and attributes this run in the same run', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: 'discovered'}),
            ).sync(db);

            const alice = developerNamed(db, 'alice');
            expect(alice).toBeDefined();
            expect(alice?.team).toBe('discovered');
            expect(alice?.external_ids.github).toBe('alice');

            // Attributed in THIS run — no second sync, no re-fetch.
            expect(snapshotsFor(db, alice!.id)).toEqual([{date: DAY, commits: 1}]);
            expect(result.snapshotsWritten).toBeGreaterThan(0);
            expect(result.errors).toContain(
                `${AUTO_CREATE_SUMMARY_PREFIX} 1 developers (0 bot authors skipped) into team 'discovered'`,
            );
            // Nothing left unattributed, so no unmatched advisory.
            expect(result.errors.some((e) => e.startsWith(UNMATCHED_AUTHORS_PREFIX))).toBe(false);
            expect(listAuthorCandidates(db)).toHaveLength(0);
        });

        it('auto-creates the configured team when it does not exist yet', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);
            expect(getTeam(db, 'discovered')).toBeNull();

            await new GitSync(config({auto_create_developers: true, auto_create_team: 'discovered'})).sync(db);

            expect(getTeam(db, 'discovered')).not.toBeNull();
        });

        it('totals match a sync where the developer already existed — no double-count', async () => {
            // Control: the same commits synced against a PRE-EXISTING developer.
            const control = makeDb();
            addTeam(control, 'discovered');
            addDeveloper(control, 'alice', 'discovered', 'alice@corp.example', 'alice');
            await installProvider([commitBy('alice', 'alice@corp.example', 'sha-fixed')]);
            await new GitSync(config()).sync(control);
            const expected = totalCommits(control);
            expect(expected).toBe(1);
            control.close();

            await installProvider([commitBy('alice', 'alice@corp.example', 'sha-fixed')]);
            await new GitSync(config({auto_create_developers: true, auto_create_team: 'discovered'})).sync(db);

            expect(totalCommits(db)).toBe(expected);
        });

        it('a later run neither re-creates the developer nor re-announces onboarding', async () => {
            const cfg = config({auto_create_developers: true, auto_create_team: 'discovered'});
            await installProvider([commitBy('alice', 'alice@corp.example')]);
            await new GitSync(cfg).sync(db);
            const afterFirst = totalCommits(db);

            // A steady-state run: the cursor has advanced, so the provider has nothing new.
            await installProvider([]);
            const second = await new GitSync(cfg).sync(db);

            expect(listDevelopers(db)).toHaveLength(1);
            expect(totalCommits(db)).toBe(afterFirst);
            // Nobody to onboard, so no summary line every quiet run.
            expect(second.errors.some((e) => e.startsWith(AUTO_CREATE_SUMMARY_PREFIX))).toBe(false);
        });

        it('replays history retained by an EARLIER run, without re-fetching it', async () => {
            // Run 1, flag OFF: day 1's authorship is retained, nobody is created, nothing
            // is attributed. This is the history that would be lost without replay.
            const older = '2024-01-10';
            await installProvider([commitBy('alice', 'alice@corp.example', 'old-sha', older)]);
            await new GitSync(config()).sync(db);
            expect(totalCommits(db)).toBe(0);

            // Run 2, flag ON: the provider delivers ONLY day 2's commit — day 1 is behind
            // the cursor and is never re-fetched. Creating alice must still attribute BOTH
            // days, the older one purely from the retained raw rows.
            await installProvider([commitBy('alice', 'alice@corp.example', 'new-sha', DAY)]);
            await new GitSync(config({auto_create_developers: true, auto_create_team: 'discovered'})).sync(db);

            const alice = developerNamed(db, 'alice');
            expect(alice).toBeDefined();
            expect(snapshotsFor(db, alice!.id)).toEqual([
                {date: older, commits: 1},
                {date: DAY, commits: 1},
            ]);
        });

        it('onboards only the authors THIS run observed, not every queued candidate', async () => {
            // A candidate left unpromoted in the review queue from an earlier run must not
            // be swept up by a later run that never saw them: an operator who declined to
            // promote someone has made a decision the hands-off path should not override.
            await installProvider([commitBy('carol', 'carol@corp.example', 'carol-sha')]);
            await new GitSync(config()).sync(db);
            expect(listAuthorCandidates(db).map((c) => c.login)).toEqual(['carol']);

            await installProvider([commitBy('alice', 'alice@corp.example', 'alice-sha')]);
            await new GitSync(config({auto_create_developers: true, auto_create_team: 'discovered'})).sync(db);

            expect(listDevelopers(db).map((d) => d.name)).toEqual(['alice']);
            expect(listAuthorCandidates(db).map((c) => c.login)).toEqual(['carol']);
        });
    });

    describe('bots are a hard skip', () => {
        it('does not create a developer for a bot author, and leaves it a flagged candidate', async () => {
            await installProvider([commitBy('dependabot[bot]', 'dependabot@users.noreply.github.com')]);

            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: 'discovered'}),
            ).sync(db);

            expect(listDevelopers(db)).toHaveLength(0);
            expect(result.errors).toContain(
                `${AUTO_CREATE_SUMMARY_PREFIX} 0 developers (1 bot authors skipped) into team 'discovered'`,
            );

            const candidates = listAuthorCandidates(db);
            expect(candidates).toHaveLength(1);
            expect(candidates[0].likely_bot).toBe(true);
            expect(candidates[0].bot_reason).toMatch(/bot suffix|known automation/);
        });

        it('creates the human and skips the bot in a mixed run', async () => {
            await installProvider([
                commitBy('alice', 'alice@corp.example'),
                commitBy('renovate[bot]', 'renovate@corp.example'),
            ]);

            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: 'discovered'}),
            ).sync(db);

            expect(listDevelopers(db).map((d) => d.name)).toEqual(['alice']);
            expect(result.errors).toContain(
                `${AUTO_CREATE_SUMMARY_PREFIX} 1 developers (1 bot authors skipped) into team 'discovered'`,
            );
        });

        it('honours the operator exclusion denylist on top of the built-in classifier', async () => {
            // `svc-deploy` is a perfectly ordinary-looking login: no built-in rule fires.
            await installProvider([commitBy('svc-deploy', 'svc-deploy@corp.example')]);

            await new GitSync(
                config({
                    auto_create_developers: true,
                    auto_create_team: 'discovered',
                    auto_create_exclude: ['svc-*'],
                }),
            ).sync(db);

            expect(listDevelopers(db)).toHaveLength(0);
            // Without the denylist the same author WOULD have been created — a positive
            // control, so the assertion above cannot pass for the wrong reason.
            const candidates = listAuthorCandidates(db);
            expect(candidates[0].likely_bot).toBe(false);
        });

        it('creates an author the denylist does not match', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            await new GitSync(
                config({
                    auto_create_developers: true,
                    auto_create_team: 'discovered',
                    auto_create_exclude: ['svc-*'],
                }),
            ).sync(db);

            expect(developerNamed(db, 'alice')).toBeDefined();
        });
    });

    describe('fail-closed config', () => {
        it('rejects the flag on with no team and syncs nothing', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            const result = await new GitSync(config({auto_create_developers: true})).sync(db);

            expect(result.errors[0]).toMatch(/Invalid auto-create config.*auto_create_team is required/);
            expect(result.snapshotsWritten).toBe(0);
            expect(listDevelopers(db)).toHaveLength(0);
            // Fail-closed means nothing ran at all — not even retention.
            const raw = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number};
            expect(raw.n).toBe(0);
        });

        it('rejects a blank team', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);
            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: '   '}),
            ).sync(db);
            expect(result.errors[0]).toMatch(/auto_create_team is blank/);
        });

        it('rejects a non-boolean flag rather than coercing it', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);
            const result = await new GitSync(
                config({auto_create_developers: 'false', auto_create_team: 'discovered'}),
            ).sync(db);
            expect(result.errors[0]).toMatch(/auto_create_developers must be a boolean/);
            expect(listDevelopers(db)).toHaveLength(0);
        });

        it('refuses an ARCHIVED team: creates nobody, reports a genuine (non-advisory) error', async () => {
            addTeam(db, 'discovered');
            archiveTeam(db, 'discovered');
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: 'discovered'}),
            ).sync(db);

            expect(listDevelopers(db)).toHaveLength(0);
            const refusal = result.errors.find((e) => e.includes('is archived'));
            expect(refusal).toBeDefined();
            // NOT advisory-prefixed — an operator must see this turn the provider red.
            expect(refusal?.startsWith(AUTO_CREATE_SUMMARY_PREFIX)).toBe(false);
            // The rest of the sync still ran: authorship is retained for later promotion.
            const raw = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number};
            expect(raw.n).toBeGreaterThan(0);
        });
    });

    describe('identity uniqueness and atomicity', () => {
        it('never creates a duplicate when two raw keys point at one person', async () => {
            // Two commits from the same human: one carries the provider login, one does
            // not (a local `git config` with no linked account). They retain under two
            // different raw keys. Exactly ONE developer must exist afterwards.
            await installProvider([
                commitBy('alice', 'alice@corp.example', 'sha-a'),
                commitBy(null, 'alice@corp.example', 'sha-b'),
            ]);

            await new GitSync(config({auto_create_developers: true, auto_create_team: 'discovered'})).sync(db);

            const devs = listDevelopers(db);
            expect(devs).toHaveLength(1);
            expect(devs[0].external_ids.github).toBe('alice');
            // Only the login-keyed commit is attributed. The email-only key is deliberately
            // NOT auto-attributed: nothing proves that commit was authored by the same
            // person, only that someone typed that address into `git config`. It stays a
            // candidate for a human to confirm — see the spoofing test below.
            expect(snapshotsFor(db, devs[0].id)).toEqual([{date: DAY, commits: 1}]);
            expect(listAuthorCandidates(db).map((c) => c.raw_author_key)).toEqual([
                'github:email:alice@corp.example',
            ]);
        });

        it('an auto-created developer claims NO self-asserted commit email', async () => {
            // The identity-spoofing vector: a commit's author email is set by whoever made
            // the commit and verified by nobody. If auto-create seeded it as the primary
            // email it would become a global attribution key, so anyone able to push one
            // commit could permanently claim a colleague's address — capturing their future
            // commits and blocking their own honest registration.
            await installProvider([commitBy('mallory', 'alice@corp.example')]);

            await new GitSync(config({auto_create_developers: true, auto_create_team: 'discovered'})).sync(db);

            const mallory = developerNamed(db, 'mallory');
            expect(mallory).toBeDefined();
            // Created from the provider login ONLY.
            expect(mallory?.external_ids.github).toBe('mallory');
            expect(mallory?.email).toBeNull();
            expect(mallory?.external_ids.git_emails).toBeUndefined();

            // The address is therefore still free: Alice can register it later.
            const alice = createDeveloperWithReplay(db, {
                name: 'Alice',
                team: 'discovered',
                email: 'alice@corp.example',
            });
            expect(alice.ok).toBe(true);
        });

        it('does not auto-create an author who has no provider login at all', async () => {
            // Nothing here is provider-verified — only a self-asserted address.
            await installProvider([commitBy(null, 'somebody@corp.example')]);

            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: 'discovered'}),
            ).sync(db);

            expect(listDevelopers(db)).toHaveLength(0);
            // Held for the review queue, and counted in the run summary rather than silently.
            expect(result.errors).toContain(
                `${AUTO_CREATE_SUMMARY_PREFIX} 0 developers (1 bot authors skipped) into team 'discovered'`,
            );
            expect(listAuthorCandidates(db)).toHaveLength(1);
        });

        it('attributes an auto-created developer their PR records in the same run', async () => {
            // PR records were previously resolved against the PRE-fetch identity map, so an
            // auto-created developer's PRs were dropped — permanently, because providers
            // re-fetch by updated_at and a merged, untouched PR is never re-delivered.
            const provider = await installProvider([commitBy('alice', 'alice@corp.example')]);
            (provider.getPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
                {
                    id: '1',
                    title: 'feat: something',
                    author: {name: 'alice', email: 'alice@corp.example', username: 'alice'},
                    state: 'merged',
                    createdAt: `${DAY}T08:00:00Z`,
                    mergedAt: `${DAY}T12:00:00Z`,
                    closedAt: `${DAY}T12:00:00Z`,
                    updatedAt: `${DAY}T12:00:00Z`,
                    reviewers: [],
                    additions: 50,
                    deletions: 10,
                },
            ]);

            await new GitSync(config({auto_create_developers: true, auto_create_team: 'discovered'})).sync(db);

            const alice = developerNamed(db, 'alice');
            const prs = db
                .prepare('SELECT developer_id FROM pr_records WHERE developer_id = ?')
                .all(alice!.id) as {developer_id: string}[];
            expect(prs).toHaveLength(1);
        });

        it('does not create a developer for an author who already has one', async () => {
            addTeam(db, 'eng');
            addDeveloper(db, 'Alice Existing', 'eng', 'alice@corp.example', 'alice');
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: 'discovered'}),
            ).sync(db);

            expect(listDevelopers(db).map((d) => d.name)).toEqual(['Alice Existing']);
            expect(result.errors.some((e) => e.startsWith(AUTO_CREATE_SUMMARY_PREFIX))).toBe(false);
        });

        it('creation, projection and the cursor advance roll back together', async () => {
            await installProvider([commitBy('alice', 'alice@corp.example')]);

            // Fail the write transaction AFTER auto-create has run, by making the
            // projection's snapshot write throw. Everything the transaction did — the
            // developer, the retained rows, the cursor — must be gone.
            const realPrepare = db.prepare.bind(db);
            const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
                if (sql.includes('INSERT INTO git_snapshots')) {
                    throw new Error('boom: simulated snapshot write failure');
                }
                return realPrepare(sql);
            }) as typeof db.prepare);

            const result = await new GitSync(
                config({auto_create_developers: true, auto_create_team: 'discovered'}),
            ).sync(db);
            spy.mockRestore();

            expect(result.errors.some((e) => e.includes('transaction rolled back'))).toBe(true);
            expect(listDevelopers(db)).toHaveLength(0);
            expect(getTeam(db, 'discovered')).toBeNull();
            const raw = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number};
            expect(raw.n).toBe(0);
            const cursor = db
                .prepare(`SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'git_last_sync:%'`)
                .get() as {n: number};
            expect(cursor.n).toBe(0);
            // And a rolled-back run must not CLAIM it onboarded anyone.
            expect(result.errors.some((e) => e.startsWith(AUTO_CREATE_SUMMARY_PREFIX))).toBe(false);
        });
    });

    describe('advisory-vs-failure classification (TST-2)', () => {
        it('classifies the auto-create SUMMARY as advisory and the FAILURE line as a genuine error', () => {
            // The two lines come from the same function twelve lines apart and are told
            // apart ONLY by their wording. If the failure line is ever reworded to start
            // with the summary's sentinel, it is silently demoted to an advisory: a run
            // that left authorship permanently unattributed then persists
            // last_sync_status='ok' and the scheduler stops retrying it. Nothing else
            // asserts that distinction, so it is pinned here against the ONE classifier
            // every consumer now shares.
            expect(isAdvisoryError(`${AUTO_CREATE_SUMMARY_PREFIX} 3 developers (1 bot authors skipped) into team 'discovered'`)).toBe(true);
            // Built by the SOURCE, not copied here — a reword of the emitted line changes
            // this input too, so the assertion tracks the code instead of a stale copy.
            expect(isAdvisoryError(autoCreateFailureLine(2, 'github:login:jane (conflict: ...)'))).toBe(false);

            // The other advisories, and a real failure, on the same rule.
            expect(isAdvisoryError(`${UNMATCHED_AUTHORS_PREFIX} github:dependabot[bot]`)).toBe(true);
            expect(isAdvisoryError(`${LEGACY_CELLS_SKIPPED_PREFIX} 4 cell(s) were left untouched...`)).toBe(true);
            expect(isAdvisoryError('GitHub API error 401: bad token')).toBe(false);
            expect(isAdvisoryError('Failed to write sync data (transaction rolled back ...)')).toBe(false);
        });
    });
});
