import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import https from 'https';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam, archiveTeam, getTeam, listTeams} from '../../src/registry/teams';
import {discoverOrgMembers} from '../../src/registry/discovery';
import {addDeveloper} from '../../src/registry/developers';
import {upsertRawAuthorDaily} from '../../src/connectors/git/raw-author-daily';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/**
 * Only the default-team resolution is exercised here — the member fetch is unmocked live
 * HTTP and is not under test. These cases reach a decision BEFORE any network call, which
 * is why they need no mock: the team gate was moved ahead of the fetch in #256 so an
 * unusable team fails immediately instead of after paginating a whole org.
 */
describe('discoverOrgMembers — default team resolution (#256)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('refuses an ARCHIVED team before making any API call', async () => {
        addTeam(db, 'discovered');
        archiveTeam(db, 'discovered');

        // A live fetch would time out or throw a network error; the assertion below is on
        // the team message specifically, so it can only pass by failing at the gate.
        await expect(discoverOrgMembers(db, 'acme', 'token', 'discovered')).rejects.toThrow(
            /Team 'discovered' is archived/,
        );
    });

    it('refuses an archived DEFAULT team (no --team supplied)', async () => {
        addTeam(db, 'discovered');
        archiveTeam(db, 'discovered');

        await expect(discoverOrgMembers(db, 'acme', 'token')).rejects.toThrow(/is archived/);
    });

    it('does not resurrect or duplicate the archived team', async () => {
        addTeam(db, 'discovered');
        archiveTeam(db, 'discovered');

        await expect(discoverOrgMembers(db, 'acme', 'token', 'discovered')).rejects.toThrow();

        expect(listTeams(db, true)).toHaveLength(1);
        expect(getTeam(db, 'discovered')?.archived_at).not.toBeNull();
    });
});

/**
 * The member-fetch path, with `https` stubbed so no network is touched. This exists for
 * one reason: to prove org discovery ATTRIBUTES retained history. Every other onboarding
 * surface routes through `createDeveloperWithReplay`; this one calls `addDeveloper`
 * directly, so without a replay it was the single path where a created developer silently
 * got nothing — and it would never self-heal, because sync projects in `cells` mode and
 * never revisits a past day.
 */
describe('discoverOrgMembers — attributes retained history (#250 SO-2)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'discovered');
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    /** Stub https.get so each URL resolves to a canned JSON body. */
    function stubHttps(bodyFor: (url: string) => unknown): void {
        vi.spyOn(https, 'get').mockImplementation(((
            url: string,
            _options: unknown,
            callback: (res: unknown) => void,
        ) => {
            const handlers: Record<string, (arg?: unknown) => void> = {};
            const res = {
                statusCode: 200,
                on: (event: string, handler: (arg?: unknown) => void): void => {
                    handlers[event] = handler;
                },
            };
            // Deliver the body on the next tick, after the caller has registered its
            // data/end handlers — the real socket ordering.
            queueMicrotask((): void => {
                callback(res);
                handlers.data?.(Buffer.from(JSON.stringify(bodyFor(url)), 'utf8'));
                handlers.end?.();
            });
            return {on: (): undefined => undefined};
        }) as unknown as typeof https.get);
    }

    /** Retain one day of authorship for a github login. */
    function retain(login: string, date: string, commits: number): void {
        upsertRawAuthorDaily(db, {
            provider: 'github',
            container: 'acme',
            raw_author_key: `github:login:${login}`,
            author_login: login,
            author_email: `${login}@work.com`,
            author_display_name: null,
            date,
            commits,
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
        });
    }

    it('attributes each discovered member the history retained before they existed', async () => {
        retain('ada', '2026-07-01', 5);
        retain('ada', '2026-07-02', 4);
        retain('linus', '2026-07-01', 3);
        // An author nobody discovers stays retained but unattributed.
        retain('ghost', '2026-07-01', 9);

        stubHttps((url) =>
            url.includes('/members')
                ? url.includes('page=1')
                    ? [{login: 'ada'}, {login: 'linus'}]
                    : []
                : {login: 'x', name: null},
        );

        const result = await discoverOrgMembers(db, 'acme', 'token', 'discovered');

        expect(result.created.map((d) => d.name).sort()).toEqual(['ada', 'linus']);
        // Three distinct days across both members — the batched replay's coverage.
        expect(result.datesAttributed).toBe(2);

        const snapsFor = (name: string): {date: string; commits: number}[] => {
            const id = result.created.find((d) => d.name === name)!.id;
            return db
                .prepare('SELECT date, commits FROM git_snapshots WHERE developer_id = ? ORDER BY date')
                .all(id) as {date: string; commits: number}[];
        };
        expect(snapsFor('ada')).toEqual([
            {date: '2026-07-01', commits: 5},
            {date: '2026-07-02', commits: 4},
        ]);
        expect(snapsFor('linus')).toEqual([{date: '2026-07-01', commits: 3}]);
        // The undiscovered author is retained but projected to nobody — no phantom row.
        const total = db.prepare('SELECT COALESCE(SUM(commits), 0) AS n FROM git_snapshots').get() as {
            n: number;
        };
        expect(total.n).toBe(12);
    });

    it('reports zero attributed dates when nothing retained matches the discovered members', async () => {
        retain('ghost', '2026-07-01', 9);
        stubHttps((url) =>
            url.includes('/members') ? (url.includes('page=1') ? [{login: 'ada'}] : []) : {login: 'ada', name: null},
        );

        const result = await discoverOrgMembers(db, 'acme', 'token', 'discovered');

        expect(result.created).toHaveLength(1);
        expect(result.datesAttributed).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS n FROM git_snapshots').get()).toEqual({n: 0});
    });

    it('skips an already-registered login rather than creating a duplicate', async () => {
        addDeveloper(db, 'Ada Existing', 'discovered', undefined, 'ada');
        stubHttps((url) =>
            url.includes('/members') ? (url.includes('page=1') ? [{login: 'ada'}] : []) : {login: 'ada', name: null},
        );

        const result = await discoverOrgMembers(db, 'acme', 'token', 'discovered');

        expect(result.created).toEqual([]);
        expect(result.skipped).toEqual(['ada']);
    });
});
