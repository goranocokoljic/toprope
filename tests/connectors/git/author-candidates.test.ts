import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {upsertRawAuthorDaily, type RawAuthorDailyInput} from '../../../src/connectors/git/raw-author-daily';
import {classifyAuthor, listAuthorCandidates} from '../../../src/connectors/git/author-candidates';
import type {GitProviderType} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    addTeam(db, 'eng');
    return db;
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

describe('classifyAuthor — the shared bot classifier (#254)', () => {
    describe('bot-suffixed logins', () => {
        it.each([
            ['dependabot[bot]'],
            ['some-new-thing[bot]'],
            ['scanner-bot'],
            ['scanner_bot'],
        ])('flags "%s" as a bot', (login) => {
            const verdict = classifyAuthor({login, email: 'x@example.com'});
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason).toContain('bot suffix');
        });

        it('matches the suffix case-insensitively', () => {
            expect(classifyAuthor({login: 'Renovate[Bot]'}).isBot).toBe(true);
        });
    });

    describe('known automation logins', () => {
        it.each([
            ['dependabot'],
            ['renovate'],
            ['github-actions'],
            ['mergify'],
            ['snyk-bot'],
            ['web-flow'],
        ])('flags the known bot "%s"', (login) => {
            expect(classifyAuthor({login}).isBot).toBe(true);
        });

        it('matches a known bot regardless of login casing', () => {
            const verdict = classifyAuthor({login: 'GitHub-Actions'});
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason).toContain('known automation account');
        });

        it('matches EXACTLY, so a human whose login merely CONTAINS a bot name passes', () => {
            // Substring matching would hide these real people — the expensive error.
            expect(classifyAuthor({login: 'robotnik'}).isBot).toBe(false);
            expect(classifyAuthor({login: 'abbott'}).isBot).toBe(false);
            expect(classifyAuthor({login: 'snyk-fan'}).isBot).toBe(false);
            expect(classifyAuthor({login: 'renovator'}).isBot).toBe(false);
        });
    });

    describe('placeholder identities', () => {
        it.each([['unknown'], ['none'], ['anonymous'], ['ghost'], ['N/A']])(
            'flags the placeholder login "%s"',
            (login) => {
                const verdict = classifyAuthor({login});
                expect(verdict.isBot).toBe(true);
                expect(verdict.reason).toContain('placeholder');
            },
        );

        it('flags an author with NEITHER a login nor an email', () => {
            const verdict = classifyAuthor({login: '   ', email: null});
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason).toContain('empty identity');
        });

        it('flags a fully absent input object', () => {
            expect(classifyAuthor({}).isBot).toBe(true);
        });
    });

    describe('no-reply email addresses', () => {
        it.each([
            ['12345+ci@users.noreply.github.com'],
            ['pipeline@noreply.example.com'],
            ['bot@no-reply.internal.corp'],
            ['deploy@noreply.gitlab.com'],
        ])('flags the login-less no-reply address "%s"', (email) => {
            const verdict = classifyAuthor({login: null, email});
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason).toContain('no-reply');
        });

        it('matches the domain case-insensitively', () => {
            expect(classifyAuthor({email: 'X@Users.NoReply.GitHub.COM'}).isBot).toBe(true);
        });

        it('does NOT flag a human who has a login, even on a noreply address (GitHub privacy mode)', () => {
            // The expensive error this guard exists to prevent: privacy-mode commits come
            // from users.noreply.github.com but belong to real, promotable developers.
            const verdict = classifyAuthor({login: 'alice', email: '9876+alice@users.noreply.github.com'});
            expect(verdict.isBot).toBe(false);
            expect(verdict.reason).toBeUndefined();
        });

        it('does not flag a domain that merely contains the word reply', () => {
            expect(classifyAuthor({email: 'a@replyto.example.com'}).isBot).toBe(false);
        });

        it('does not flag on the LOCAL part looking like noreply', () => {
            expect(classifyAuthor({email: 'noreply@example.com'}).isBot).toBe(false);
        });
    });

    describe('humans and the uncertain case', () => {
        it('passes a plain human identity', () => {
            const verdict = classifyAuthor({login: 'alice', email: 'alice@example.com'});
            expect(verdict).toEqual({isBot: false});
        });

        it('defaults an UNRECOGNIZED identity to human rather than guessing bot', () => {
            // No signal fired: conservative contract says human.
            expect(classifyAuthor({login: 'ci-runner-7', email: 'ci-runner-7@corp.io'}).isBot).toBe(false);
            expect(classifyAuthor({email: 'someone@corp.io'}).isBot).toBe(false);
            expect(classifyAuthor({login: 'automation'}).isBot).toBe(false);
        });

        it('never attaches a reason when the verdict is human', () => {
            for (const input of [{login: 'alice'}, {email: 'bob@corp.io'}, {login: 'x', email: 'y@z.io'}]) {
                expect(classifyAuthor(input).reason).toBeUndefined();
            }
        });

        it('treats a malformed email as no signal rather than as a bot', () => {
            expect(classifyAuthor({email: 'not-an-address'}).isBot).toBe(false);
            expect(classifyAuthor({email: 'trailing@'}).isBot).toBe(false);
        });
    });
});

describe('listAuthorCandidates — unmapped retained authors (#254)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('returns nothing when the raw store is empty', () => {
        expect(listAuthorCandidates(db)).toEqual([]);
    });

    it('includes an unmapped retained author with their raw identity fields', () => {
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:login:alice',
                author_login: 'alice',
                author_email: 'alice@example.com',
                author_display_name: 'Alice A',
                commits: 3,
            }),
            '2026-07-01T00:00:00.000Z',
        );

        const candidates = listAuthorCandidates(db);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            provider: 'github',
            raw_author_key: 'github:login:alice',
            login: 'alice',
            email: 'alice@example.com',
            display_name: 'Alice A',
            commit_count: 3,
            likely_bot: false,
        });
        expect(candidates[0].bot_reason).toBeUndefined();
    });

    it('EXCLUDES an author already mapped by provider login', () => {
        addDeveloper(db, 'Alice', 'eng', 'alice@corp.io', 'alice');
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:alice', author_login: 'alice'}),
            '2026-07-01T00:00:00.000Z',
        );

        expect(listAuthorCandidates(db)).toEqual([]);
    });

    it('EXCLUDES an author already mapped by commit email, case-insensitively', () => {
        addDeveloper(db, 'Bob', 'eng', 'Bob@Corp.IO');
        upsertRawAuthorDaily(
            db,
            rawRow({
                provider: 'bitbucket',
                raw_author_key: 'bitbucket:email:bob@corp.io',
                author_email: 'bob@corp.io',
            }),
            '2026-07-01T00:00:00.000Z',
        );

        expect(listAuthorCandidates(db)).toEqual([]);
    });

    it('includes only the UNMAPPED authors when the store holds both kinds', () => {
        addDeveloper(db, 'Alice', 'eng', 'alice@corp.io', 'alice');
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:alice', author_login: 'alice'}),
            '2026-07-01T00:00:00.000Z',
        );
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:carol', author_login: 'carol'}),
            '2026-07-01T00:00:00.000Z',
        );

        expect(listAuthorCandidates(db).map((c) => c.raw_author_key)).toEqual(['github:login:carol']);
    });

    it('drops a candidate the moment its identity is mapped — the list is derived, not stored', () => {
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'gitlab:login:dave', provider: 'gitlab', author_login: 'dave'}),
            '2026-07-01T00:00:00.000Z',
        );
        expect(listAuthorCandidates(db)).toHaveLength(1);

        addDeveloper(db, 'Dave', 'eng', undefined, undefined, {gitlab: 'dave'});

        expect(listAuthorCandidates(db)).toEqual([]);
    });

    it('aggregates commit_count / first_seen / last_seen across a candidate’s many days', () => {
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:erin', author_login: 'erin', date: '2026-07-01', commits: 2}),
            '2026-07-02T00:00:00.000Z',
        );
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:erin', author_login: 'erin', date: '2026-07-02', commits: 5}),
            '2026-07-03T00:00:00.000Z',
        );
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:erin', author_login: 'erin', date: '2026-07-03', commits: 4}),
            '2026-07-01T09:00:00.000Z',
        );

        const [erin] = listAuthorCandidates(db);
        expect(erin.commit_count).toBe(11);
        expect(erin.first_seen).toBe('2026-07-01T09:00:00.000Z');
        expect(erin.last_seen).toBe('2026-07-03T00:00:00.000Z');
    });

    it('accumulates commits across RUNS on the same day (the raw store’s additive merge)', () => {
        const row = rawRow({raw_author_key: 'github:login:frank', author_login: 'frank', commits: 3});
        upsertRawAuthorDaily(db, row, '2026-07-01T00:00:00.000Z');
        upsertRawAuthorDaily(db, row, '2026-07-02T00:00:00.000Z');

        expect(listAuthorCandidates(db)[0].commit_count).toBe(6);
    });

    it('orders by commit_count DESC and is stable under a differing insertion order', () => {
        const seed = (key: string, login: string, commits: number, observedAt: string): void => {
            upsertRawAuthorDaily(db, rawRow({raw_author_key: key, author_login: login, commits}), observedAt);
        };
        // last_seen deliberately runs OPPOSITE to commit_count: if the list inherited
        // distinctRawAuthors' last_seen tiebreak, this ordering would come out reversed.
        seed('github:login:low', 'low', 1, '2026-07-09T00:00:00.000Z');
        seed('github:login:mid', 'mid', 5, '2026-07-05T00:00:00.000Z');
        seed('github:login:high', 'high', 9, '2026-07-01T00:00:00.000Z');

        expect(listAuthorCandidates(db).map((c) => c.raw_author_key)).toEqual([
            'github:login:high',
            'github:login:mid',
            'github:login:low',
        ]);
    });

    it('breaks a commit_count tie on raw_author_key ASC — a TOTAL, deterministic order', () => {
        for (const [key, login, observedAt] of [
            ['github:login:zoe', 'zoe', '2026-07-09T00:00:00.000Z'],
            ['github:login:adam', 'adam', '2026-07-01T00:00:00.000Z'],
            ['github:login:mona', 'mona', '2026-07-05T00:00:00.000Z'],
        ] as const) {
            upsertRawAuthorDaily(db, rawRow({raw_author_key: key, author_login: login, commits: 4}), observedAt);
        }

        const order = listAuthorCandidates(db).map((c) => c.raw_author_key);
        expect(order).toEqual(['github:login:adam', 'github:login:mona', 'github:login:zoe']);
        // Re-deriving must give byte-identical order — nothing nondeterministic in the chain.
        expect(listAuthorCandidates(db).map((c) => c.raw_author_key)).toEqual(order);
    });

    it('flags a bot candidate with its reason but still LISTS it for admin review', () => {
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:login:dependabot[bot]',
                author_login: 'dependabot[bot]',
                commits: 50,
            }),
            '2026-07-01T00:00:00.000Z',
        );
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:grace', author_login: 'grace', commits: 2}),
            '2026-07-01T00:00:00.000Z',
        );

        const candidates = listAuthorCandidates(db);
        expect(candidates.map((c) => c.likely_bot)).toEqual([true, false]);
        expect(candidates[0].bot_reason).toContain('bot suffix');
        expect(candidates[1].bot_reason).toBeUndefined();
    });

    it('keys candidates per provider — the same login on two providers is two candidates', () => {
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:sam', author_login: 'sam', commits: 2}),
            '2026-07-01T00:00:00.000Z',
        );
        upsertRawAuthorDaily(
            db,
            rawRow({
                provider: 'gitlab',
                raw_author_key: 'gitlab:login:sam',
                author_login: 'sam',
                commits: 2,
            }),
            '2026-07-01T00:00:00.000Z',
        );

        expect(listAuthorCandidates(db).map((c) => c.raw_author_key)).toEqual([
            'github:login:sam',
            'gitlab:login:sam',
        ]);
    });

    it('still lists a github author when only the SAME-named gitlab identity is mapped', () => {
        // resolveDeveloperId is provider-namespaced; a gitlab mapping must not silently
        // absorb the github author's commits.
        addDeveloper(db, 'Sam', 'eng', undefined, undefined, {gitlab: 'sam'});
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:sam', author_login: 'sam'}),
            '2026-07-01T00:00:00.000Z',
        );

        expect(listAuthorCandidates(db).map((c) => c.raw_author_key)).toEqual(['github:login:sam']);
    });
});
