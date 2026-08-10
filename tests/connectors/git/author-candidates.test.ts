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

describe('classifyAuthor — the shared bot classifier (#254)', () => {
    describe('bot-suffixed logins', () => {
        it.each([
            ['some-new-thing[bot]'],
            ['scanner-bot'],
            ['scanner_bot'],
        ])('flags the unknown-but-suffixed login "%s" as a bot', (login) => {
            const verdict = classifyAuthor({login, email: 'x@example.com'});
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason).toContain('bot suffix');
        });

        it('matches the suffix case-insensitively', () => {
            expect(classifyAuthor({login: 'Some-Thing[Bot]'}).isBot).toBe(true);
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

        it('resolves a suffixed known bot by NAME, not by its suffix', () => {
            // The known-bot rule must run BEFORE the generic suffix rule, or every
            // "<name>-bot" / "<name>[bot]" entry in the set becomes unreachable and the
            // set silently stops meaning anything. Asserting the REASON is what makes
            // this test fail if the two rules are reordered or the set is emptied.
            for (const login of ['dependabot[bot]', 'snyk-bot', 'renovate[bot]']) {
                expect(classifyAuthor({login}).reason).toContain('known automation account');
            }
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

        it('bounds the login it quotes back, so an unbounded provider login cannot ride into the reason', () => {
            // author_login is passed through from the provider API unvalidated; the reason
            // is headed for an admin UI.
            const verdict = classifyAuthor({login: `${'x'.repeat(5000)}[bot]`});
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason!.length).toBeLessThan(120);
            expect(verdict.reason).toContain('…');
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
            rawRow({raw_author_key: 'github:login:erin', author_login: 'erin', date: '2026-06-30', commits: 4}),
            '2026-07-01T09:00:00.000Z',
        );

        const [erin] = listAuthorCandidates(db);
        expect(erin.commit_count).toBe(11);
        expect(erin.first_seen).toBe('2026-07-01T09:00:00.000Z');
        expect(erin.last_seen).toBe('2026-07-03T00:00:00.000Z');
    });

    it('sums an author’s commits across their retained DAYS, and re-observing one day does not inflate it', () => {
        // The rollup adds across days; it must NOT add across runs. Since IG1.2 (#318) a
        // `raw_author_daily` cell is a recompute of `raw_commits`, so writing the same day twice
        // stores the same number twice — the old additive merge would have reported 9 here.
        const day1 = rawRow({raw_author_key: 'github:login:frank', author_login: 'frank', commits: 3});
        upsertRawAuthorDaily(db, day1, '2026-07-01T00:00:00.000Z');
        upsertRawAuthorDaily(db, day1, '2026-07-02T00:00:00.000Z');
        upsertRawAuthorDaily(
            db,
            {...day1, date: '2026-07-02', commits: 3},
            '2026-07-02T00:00:00.000Z',
        );

        expect(listAuthorCandidates(db)[0].commit_count).toBe(6);
    });

    it('orders by commit_count DESC and is stable under a differing insertion order', () => {
        const seed = (key: string, login: string, commits: number, observedAt: string): void => {
            upsertRawAuthorDaily(db, rawRow({raw_author_key: key, author_login: login, commits}), observedAt);
        };
        // last_seen deliberately runs OPPOSITE to commit_count: if the list inherited
        // a last_seen-based tiebreak, this ordering would come out reversed.
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
        expect(candidates[0].bot_reason).toContain('known automation account');
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

    describe('an author whose days carry DIFFERENT emails under one login key', () => {
        // sync.ts stamps ONE run's sample commit email onto every date row that run
        // writes, so a person committing from two addresses leaves different emails on
        // different days under a single `github:login:x` key. Attribution is decided per
        // row, so such an author can be mapped on some days and unmapped on others.
        function seedTwoEmailAuthor(mappedEmail: string, unmappedEmail: string): void {
            upsertRawAuthorDaily(
                db,
                rawRow({
                    raw_author_key: 'github:login:carl',
                    author_login: 'carl',
                    author_email: mappedEmail,
                    date: '2026-07-01',
                    commits: 4,
                }),
                '2026-07-01T00:00:00.000Z',
            );
            upsertRawAuthorDaily(
                db,
                rawRow({
                    raw_author_key: 'github:login:carl',
                    author_login: 'carl',
                    author_email: unmappedEmail,
                    date: '2026-07-02',
                    commits: 6,
                }),
                '2026-07-02T00:00:00.000Z',
            );
        }

        it('LISTS them when the collapsed email would have byte-sorted to the MAPPED one', () => {
            // MAX(author_email) picks 'zz@corp.io' -> a per-author resolve would say
            // "mapped" and drop the candidate entirely, while the aa@ days project to
            // nobody: silently unattributed history with nothing surfacing it.
            addDeveloper(db, 'Carl', 'eng', 'zz@corp.io');
            seedTwoEmailAuthor('zz@corp.io', 'aa@personal.dev');

            const candidates = listAuthorCandidates(db);
            expect(candidates.map((c) => c.raw_author_key)).toEqual(['github:login:carl']);
            // ONLY the unattributed day's commits — the 4 already attributed to Carl are
            // not waiting for anyone and must not be counted again.
            expect(candidates[0].commit_count).toBe(6);
            expect(candidates[0].email).toBe('aa@personal.dev');
        });

        it('counts ONLY unattributed commits when the collapsed email would have been the UNMAPPED one', () => {
            // MAX picks 'zz@personal.dev' -> a per-author resolve says "unmapped" and
            // reports all 10 commits, including the 4 already attributed. #256 would then
            // auto-create a duplicate developer for a person who is already here.
            addDeveloper(db, 'Carl', 'eng', 'aa@corp.io');
            seedTwoEmailAuthor('aa@corp.io', 'zz@personal.dev');

            const candidates = listAuthorCandidates(db);
            expect(candidates).toHaveLength(1);
            expect(candidates[0].commit_count).toBe(6);
        });

        it('drops the candidate only once EVERY one of its identities is mapped', () => {
            addDeveloper(db, 'Carl', 'eng', 'aa@corp.io');
            seedTwoEmailAuthor('aa@corp.io', 'zz@personal.dev');
            expect(listAuthorCandidates(db)).toHaveLength(1);

            // Registering the github login attributes every one of the key's days.
            addDeveloper(db, 'Carl (git)', 'eng', undefined, 'carl');

            expect(listAuthorCandidates(db)).toEqual([]);
        });

        it('folds unattributed variants into one candidate, spanning their full seen-range', () => {
            seedTwoEmailAuthor('one@personal.dev', 'two@personal.dev');

            const [carl] = listAuthorCandidates(db);
            expect(carl.commit_count).toBe(10);
            expect(carl.first_seen).toBe('2026-07-01T00:00:00.000Z');
            expect(carl.last_seen).toBe('2026-07-02T00:00:00.000Z');
            // Pre-fill comes from the BUSIEST variant, deterministically.
            expect(carl.email).toBe('two@personal.dev');
            expect(carl.login).toBe('carl');
        });
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

describe('operator exclusion patterns (#256)', () => {
    // Compiled the way the config boundary compiles them: anchored, case-insensitive,
    // `*` -> `.*`. Built here rather than imported so this file stays a pure-logic test.
    const svc = [/^svc-.*$/i];

    describe('classifyAuthor', () => {
        it('flags a login the operator excluded that no built-in rule would catch', () => {
            expect(classifyAuthor({login: 'svc-deploy'})).toEqual({isBot: false});

            const verdict = classifyAuthor({login: 'svc-deploy'}, svc);
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason).toMatch(/operator exclusion pattern/);
        });

        it('flags on the EMAIL as well as the login', () => {
            const verdict = classifyAuthor({login: null, email: 'deploy@bots.corp.example'}, [
                /^.*@bots\.corp\.example$/i,
            ]);
            expect(verdict.isBot).toBe(true);
            expect(verdict.reason).toMatch(/operator exclusion pattern/);
        });

        it('flags on the email even when a login is present', () => {
            // The built-in no-reply rule deliberately ignores the email when a login
            // exists; an OPERATOR pattern is an explicit instruction and must not be.
            expect(classifyAuthor({login: 'deployer', email: 'x@bots.corp.example'}, [
                /^.*@bots\.corp\.example$/i,
            ]).isBot).toBe(true);
        });

        it('leaves an author the patterns do not match alone', () => {
            expect(classifyAuthor({login: 'alice', email: 'alice@corp.example'}, svc)).toEqual({isBot: false});
        });

        it('still applies the built-in rules when patterns are supplied', () => {
            expect(classifyAuthor({login: 'dependabot[bot]'}, svc).isBot).toBe(true);
        });

        it('is stateless across calls on a reused pattern instance', () => {
            // A /g-flagged RegExp carries `lastIndex` between .test() calls and would
            // alternate true/false. The compiled patterns must not be global.
            const shared = [/^svc-.*$/i];
            expect(classifyAuthor({login: 'svc-a'}, shared).isBot).toBe(true);
            expect(classifyAuthor({login: 'svc-b'}, shared).isBot).toBe(true);
            expect(classifyAuthor({login: 'svc-c'}, shared).isBot).toBe(true);
        });

        it('defaults to no exclusions, leaving behaviour exactly as #254 defined it', () => {
            expect(classifyAuthor({login: 'svc-deploy'})).toEqual(classifyAuthor({login: 'svc-deploy'}, []));
        });

        it('CLAMPS the match subject, bounding the n in the pattern engine backtracking cost (TST-1)', () => {
            // The config boundary caps the WILDCARD count; this clamp caps the subject
            // length. Both factors are needed — backtracking cost grows with each — and
            // both inputs are provider/committer-supplied and otherwise unbounded
            // (`upsertRawAuthorDaily` passes the identity columns through verbatim). This
            // runs inside the sync write transaction, so an unbounded subject means the
            // SQLite write lock is held for the duration of the backtrack.
            //
            // The clamp is observable: a pattern anchored on a suffix beyond the 320-char
            // cut cannot match, because the tail was truncated away.
            const suffix = [/^.*abc$/i];

            // Positive control — the SAME pattern matches when the subject is short, so a
            // failure below means the clamp fired, not that the pattern is simply inert.
            expect(classifyAuthor({login: 'xabc'}, suffix).isBot).toBe(true);
            expect(classifyAuthor({login: null, email: 'xabc'}, suffix).isBot).toBe(true);

            // Beyond the clamp the 'abc' tail is cut off, so neither field matches.
            const long = `${'x'.repeat(400)}abc`;
            expect(classifyAuthor({login: long}, suffix).isBot).toBe(false);
            expect(classifyAuthor({login: null, email: long}, suffix).isBot).toBe(false);

            // …and truncation can only turn a match into a non-match, never a human into a
            // bot: a pattern anchored on the PREFIX still matches past the clamp.
            expect(classifyAuthor({login: long}, [/^x.*$/i]).isBot).toBe(true);
        });
    });

    describe('listAuthorCandidates', () => {
        let db: Database.Database;

        beforeEach(() => {
            db = makeDb();
        });

        afterEach(() => {
            db.close();
        });

        it('computes likely_bot against the operator patterns it is given', () => {
            upsertRawAuthorDaily(
                db,
                rawRow({raw_author_key: 'github:login:svc-deploy', author_login: 'svc-deploy'}),
                '2026-07-01T00:00:00.000Z',
            );

            expect(listAuthorCandidates(db)[0].likely_bot).toBe(false);

            const flagged = listAuthorCandidates(db, [/^svc-.*$/i])[0];
            expect(flagged.likely_bot).toBe(true);
            expect(flagged.bot_reason).toMatch(/operator exclusion pattern/);
        });

        it('still LISTS an excluded author — exclusion suppresses auto-create, not review', () => {
            upsertRawAuthorDaily(
                db,
                rawRow({raw_author_key: 'github:login:svc-deploy', author_login: 'svc-deploy'}),
                '2026-07-01T00:00:00.000Z',
            );

            expect(listAuthorCandidates(db, [/^svc-.*$/i])).toHaveLength(1);
        });
    });
});
