/**
 * #317 (IG1.1, epic #316) — THE GOLDEN BASELINE. Criterion B's instrument.
 *
 * The epic replaces the additive `raw_author_daily` write with a per-commit `raw_commits` insert
 * plus a per-cell recompute (IG1.2/#318). Criterion B is "no silent semantics drift": for a fresh
 * database and ONE sync run, the recomputed cells must be value-identical to what TODAY's
 * pipeline produces for the same fixtures. A claim like that is only worth anything if the
 * "today" side is recorded BEFORE the write path changes — which is what this file does, on the
 * untouched pipeline, in the child that changes no write logic at all.
 *
 * IG1.2 INHERITS THIS FILE UNCHANGED. That is why it drives the REAL pipeline
 * (`GitSync.syncProviders` over the REAL provider classes over a stubbed `fetch`) rather than
 * re-implementing the ingest tail in the test: a harness that reproduced sync.ts's write loop
 * would keep passing after the rewrite by construction, proving nothing. Everything the run
 * depends on is pinned — a frozen clock, a fixed route table, no network, no random input — so a
 * diff in the stored cells can only come from a change in the pipeline's semantics.
 *
 * WHAT IS AND IS NOT IN THE GOLDEN. Every stored column except `id`, which is a `randomUUID` and
 * carries no meaning (`(provider, container, raw_author_key, date)` is the real key, and the rows
 * are ordered by it). `first_seen`/`last_seen` ARE included: on a fresh database and a single run
 * both are the run's own instant, which the frozen clock makes deterministic — so keeping them
 * pins the provenance semantics too.
 *
 * BOOTSTRAP, NOT SELF-HEALING: if the fixture file is missing, the test WRITES it and FAILS,
 * telling you to review and commit it. It never overwrites an existing golden — a rewrite that
 * changes the numbers has to fail here, which is the entire point.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../../src/storage/migrator';
import {GitSync} from '../../../src/connectors/git/sync';
import {
    AUTHOR_EMAIL,
    BITBUCKET_CONFIG,
    COMMIT_DATE,
    GITHUB_CONFIG,
    GITLAB_CONFIG,
    SHAS,
    bitbucketRoutes,
    githubRoutes,
    gitlabRoutes,
    makeCountingFetch,
    type Route,
} from './providers/provider-fetch-fixtures';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const GOLDEN_FILE = path.resolve(
    __dirname,
    '../../fixtures/golden/raw-author-daily-pre-ig1.json',
);

/**
 * The run's instant. Frozen, and late enough that every fixture date is inside the first-sync
 * window but none is in the future (a future author-day is refused at the write boundary, #309).
 */
const NOW = '2024-01-20T00:00:00.000Z';

/** The one PR the GitHub fixture carries — opened one day, merged the next. */
const PR_NUMBER = 7;

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/**
 * GitHub PR + review routes, prepended to the shared table so they win the first-match lookup
 * (`githubRoutes()` stubs `/pulls?` as an empty list).
 *
 * They exist so the golden covers the PR-derived counters — `prs_opened`, `prs_merged`,
 * `avg_time_to_merge_hours`, `review_comments_given` — which IG1.2 keeps on their existing
 * `pr_records` path while everything around them changes. A golden that only pinned commit
 * counters would leave exactly the fields most likely to be disturbed by the rewrite unpinned.
 */
function githubPullRequestRoutes(): Route[] {
    return [
        {
            match: /\/repos\/test-org\/repo1\/pulls\?/,
            body: [
                {
                    number: PR_NUMBER,
                    title: 'feat: work',
                    user: {login: 'alice-gh'},
                    state: 'closed',
                    created_at: '2024-01-14T09:00:00.000Z',
                    merged_at: '2024-01-15T15:00:00.000Z',
                    closed_at: '2024-01-15T15:00:00.000Z',
                    updated_at: '2024-01-15T15:00:00.000Z',
                    requested_reviewers: [],
                },
            ],
        },
        {
            match: new RegExp(`/pulls/${PR_NUMBER}/comments`),
            body: [
                {user: {login: 'alice-gh'}, body: 'nit: naming', created_at: '2024-01-15T11:00:00.000Z'},
                {user: {login: 'alice-gh'}, body: 'ship it', created_at: '2024-01-16T09:00:00.000Z'},
            ],
        },
        // Routed explicitly: an unrouted URL resolves to a Bitbucket-shaped empty page, which is
        // an object where the GitHub provider expects an array.
        {match: new RegExp(`/pulls/${PR_NUMBER}/reviews`), body: []},
    ];
}

/**
 * The Bitbucket commit list again, identical to the shared builder except for the commit MESSAGE,
 * which carries enough error-handling vocabulary to trip `scoreAiSignature`'s bulk-error-handling
 * signal (>= 10 mentions).
 *
 * Why it is here at all: with the shared `feat: work` message every fixture commit scores 0, so
 * `ai_signature_score` would be pinned at zero in every golden cell — i.e. the one derived score
 * IG1.2 has to recompute from `raw_commits` would be pinned by a value that any implementation
 * produces, including a broken one. Overriding one provider's message is the smallest change that
 * makes that column carry signal; the diff numbers (and therefore churn, lines and avg size) are
 * untouched, so this stays a message-only difference between the three providers.
 */
function bitbucketAiSignatureCommitRoute(): Route {
    return {
        match: /\/repositories\/test-ws\/repo1\/commits\?/,
        body: {
            values: SHAS.map((hash) => ({
                hash,
                author: {raw: `Alice <${AUTHOR_EMAIL}>`, user: {nickname: 'alice-bb'}},
                date: COMMIT_DATE,
                message:
                    'fix: try catch throw Error exception onError try catch throw Error exception',
            })),
        },
    };
}

function allRoutes(): Route[] {
    return [
        ...githubPullRequestRoutes(),
        bitbucketAiSignatureCommitRoute(),
        ...githubRoutes(),
        ...bitbucketRoutes(),
        ...gitlabRoutes(),
    ];
}

/** Every stored column except `id` — see the file header. */
const GOLDEN_COLUMNS = [
    'provider', 'container', 'raw_author_key', 'author_login', 'author_email',
    'author_display_name', 'date', 'commits', 'lines_added', 'lines_removed', 'files_changed',
    'prs_opened', 'prs_merged', 'review_comments_given', 'avg_time_to_merge_hours',
    'code_churn_rate', 'ai_signature_score', 'avg_commit_size', 'commit_burst_count',
    'first_seen', 'last_seen',
];

function readRawAuthorDaily(db: Database.Database): Record<string, unknown>[] {
    return db
        .prepare(
            `SELECT ${GOLDEN_COLUMNS.join(', ')} FROM raw_author_daily
              ORDER BY provider, container, raw_author_key, date`,
        )
        .all() as Record<string, unknown>[];
}

describe('golden baseline — raw_author_daily as TODAY\'s pipeline writes it (#317, criterion B)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
        db.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    async function runGoldenSync(): Promise<Record<string, unknown>[]> {
        vi.stubGlobal('fetch', makeCountingFetch(allRoutes()).fetchMock);
        const pending = new GitSync({enabled: false}).syncProviders(db, [
            GITHUB_CONFIG,
            BITBUCKET_CONFIG,
            GITLAB_CONFIG,
        ]);
        await vi.runAllTimersAsync();
        await pending;
        return readRawAuthorDaily(db);
    }

    it('reproduces the committed golden fixture exactly', async () => {
        const actual = await runGoldenSync();

        if (!fs.existsSync(GOLDEN_FILE)) {
            fs.mkdirSync(path.dirname(GOLDEN_FILE), {recursive: true});
            fs.writeFileSync(GOLDEN_FILE, `${JSON.stringify(actual, null, 4)}\n`, 'utf-8');
            throw new Error(
                `No golden fixture existed, so one was RECORDED at ${GOLDEN_FILE}. Review it and ` +
                    'commit it — this test does not overwrite an existing golden, on purpose.',
            );
        }

        const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf-8')) as unknown[];
        expect(actual).toEqual(expected);
    });

    /**
     * The golden is only evidence if it is not vacuous. These assert the fixture actually
     * exercises the fields the rewrite touches — three providers, both identity key shapes, and a
     * non-zero value in every counter class — so a future run that silently imports NOTHING
     * (an unrouted URL, a provider that stopped listing) fails loudly here instead of comparing
     * two empty arrays.
     */
    it('is a non-vacuous baseline: three providers, both key shapes, every counter class non-zero', async () => {
        const rows = await runGoldenSync();

        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.provider))).toEqual(
            new Set(['github', 'bitbucket', 'gitlab']),
        );
        expect(new Set(rows.map((r) => r.container))).toEqual(
            new Set(['test-org', 'test-ws', 'test-group']),
        );
        // Both shapes `rawAuthorKeyFor` can produce: a provider username, and the email fallback
        // for a commit that carried none (GitLab's fixture).
        expect(rows.some((r) => String(r.raw_author_key).includes(':login:'))).toBe(true);
        expect(rows.some((r) => String(r.raw_author_key).includes(':email:'))).toBe(true);

        const nonZero = (col: string): boolean => rows.some((r) => Number(r[col]) > 0);
        for (const col of [
            'commits', 'lines_added', 'lines_removed', 'files_changed', 'prs_opened',
            'prs_merged', 'review_comments_given', 'avg_time_to_merge_hours', 'code_churn_rate',
            'ai_signature_score', 'avg_commit_size', 'commit_burst_count',
        ]) {
            expect(nonZero(col), `golden fixture leaves ${col} at zero everywhere`).toBe(true);
        }

        // Provenance is pinned by the frozen clock, not left to the wall clock.
        expect(new Set(rows.map((r) => r.first_seen))).toEqual(new Set([NOW]));
        expect(new Set(rows.map((r) => r.last_seen))).toEqual(new Set([NOW]));
    });

    /**
     * The fixture must stay reproducible run-to-run within TODAY's pipeline too — otherwise a
     * golden mismatch under IG1.2 could not be read as "the semantics changed". Two fresh
     * databases, same routes, same frozen clock, byte-identical cells.
     */
    it('is deterministic — two fresh runs of the same fixtures agree', async () => {
        const first = await runGoldenSync();

        db.close();
        db = makeDb();
        vi.setSystemTime(new Date(NOW));
        const second = await runGoldenSync();

        expect(second).toEqual(first);
    });
});
