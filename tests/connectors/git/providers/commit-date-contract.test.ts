/**
 * #290 — every provider `createGitProvider` can build pins the commit AUTHOR DATE, and reports the
 * commit it cannot date through `onDrop` rather than losing it.
 *
 * WHY A TABLE AND NOT THREE HAND-WRITTEN TESTS. #275 pinned GitHub alone, in GitHub's own file,
 * and the two unpinned providers then sat in the `GitProvider.getCommits` docstring as a written-
 * down exception list for four issues. The failure they carry is not local: `raw_author_daily`'s
 * validator THROWS on a day it cannot key on, inside the run's single all-providers write
 * transaction, so ONE such commit from ONE provider rolls back every other provider's window and
 * re-throws identically on every subsequent run — a permanent stall of the whole git connector.
 * A per-provider test cannot fail for the provider nobody wrote one for, which is exactly how the
 * gap survived. This table is driven off `GIT_PROVIDER_TYPES` — the same list `createGitProvider`
 * switches on — so a fourth provider with no fixture FAILS rather than being silently skipped.
 *
 * The providers are the REAL classes over the shared `fetch` stub, not mocks: a mock provider would
 * assert only that the fixture sets the field.
 *
 * BOTH drop reasons are covered for all three, because the distinction is the operator's next step
 * (a truncated response vs. a real commit with a timestamp this pipeline cannot key on) and a
 * classifier that collapsed them would still pass a reason-agnostic assertion.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import {createGitProvider} from '../../../../src/connectors/git/providers/factory';
import {
    GIT_PROVIDER_TYPES,
    NO_AUTHOR_DATE_DROP_REASON,
    UNATTRIBUTABLE_DATE_DROP_REASON,
    type GitProviderConfig,
    type GitProviderType,
} from '../../../../src/connectors/git/providers/types';
import {
    AUTHOR_EMAIL,
    BITBUCKET_CONFIG,
    COMMIT_DATE,
    GITHUB_CONFIG,
    GITLAB_CONFIG,
    REPO,
    SHAS,
    bitbucketRoutes,
    githubRoutes,
    gitlabRoutes,
    makeCountingFetch,
    type Route,
} from './provider-fetch-fixtures';

const SINCE = '2024-01-01T00:00:00.000Z';
const UNTIL = '2024-02-01T00:00:00.000Z';

/** The one commit each fixture below expects to survive — a normal, datable commit. */
const GOOD_SHA = SHAS[0];
const BAD_SHA = 'sha-bad-date';

/**
 * An ISO 8601 EXPANDED year, which is what `git commit --date=@999999999999` really produces and
 * what every one of these providers will hand back verbatim. Deliberately not `'not-a-date'`: an
 * expanded year round-trips cleanly through `toISOString()` and `Date.parse`, so it defeats a
 * parse-based guard and is caught only by the anchored day-shape pin — the input class that ONLY
 * the real gate handles.
 */
const EXPANDED_YEAR_DATE = '+033658-09-27T01:46:39.000Z';

/**
 * The commit-LIST route each provider must be handed to see one good commit and one whose date is
 * `badDate` (omitted entirely when `badDate` is `undefined` — the truncated-response case).
 *
 * PREPENDED to the shared builder's routes, not merged into them: `makeCountingFetch` picks the
 * FIRST matching route, so an override needs only to restate the endpoint under test while every
 * other endpoint (repo list, per-commit diff/diffstat, PR list) keeps the canonical fixture. For
 * GitHub the commit DETAIL endpoint is overridden too, for the bad sha only — its generic detail
 * route echoes a good date for any sha, which would otherwise rescue the commit through the
 * detail-preferred branch and make the test vacuous.
 */
function badDateRoutes(type: GitProviderType, badDate: string | undefined): Route[] {
    const gitlabRow = (id: string, date: string | undefined): Record<string, unknown> => ({
        id,
        author_name: 'Alice',
        author_email: AUTHOR_EMAIL,
        ...(date === undefined ? {} : {authored_date: date}),
        message: 'feat: work',
    });
    const bitbucketRow = (hash: string, date: string | undefined): Record<string, unknown> => ({
        hash,
        author: {raw: `Alice <${AUTHOR_EMAIL}>`, user: {nickname: 'alice-bb'}},
        ...(date === undefined ? {} : {date}),
        message: 'feat: work',
    });
    const githubRow = (sha: string, date: string | undefined): Record<string, unknown> => ({
        sha,
        commit: {
            author: {name: 'Alice', email: AUTHOR_EMAIL, ...(date === undefined ? {} : {date})},
            message: 'feat: work',
        },
        author: {login: 'alice-gh'},
    });

    switch (type) {
        case 'github':
            return [
                {
                    match: /\/repos\/test-org\/repo1\/commits\?/,
                    body: [githubRow(GOOD_SHA, COMMIT_DATE), githubRow(BAD_SHA, badDate)],
                },
                {
                    match: new RegExp(`/repos/test-org/repo1/commits/${BAD_SHA}$`),
                    body: {
                        ...githubRow(BAD_SHA, badDate),
                        stats: {additions: 1, deletions: 0, total: 1},
                        files: [],
                    },
                },
            ];
        case 'bitbucket':
            return [
                {
                    match: /\/repositories\/test-ws\/repo1\/commits\?/,
                    body: {
                        values: [
                            bitbucketRow(GOOD_SHA, COMMIT_DATE),
                            bitbucketRow(BAD_SHA, badDate),
                        ],
                    },
                },
            ];
        case 'gitlab':
            return [
                {
                    match: /\/repository\/commits\?/,
                    body: [gitlabRow(GOOD_SHA, COMMIT_DATE), gitlabRow(BAD_SHA, badDate)],
                },
            ];
        default:
            // Tests are excluded from `tsconfig.json`, so an unhandled member of the union is NOT
            // a compile error here — it falls off the end, returns `undefined`, and the caller's
            // spread throws a bare `TypeError: undefined is not iterable`. That is the illegible
            // failure the gate test below exists to replace, so name it here too.
            throw new Error(`badDateRoutes has no fixture for provider type: ${String(type)}`);
    }
}

const BASE_ROUTES: Record<GitProviderType, () => Route[]> = {
    github: githubRoutes,
    bitbucket: bitbucketRoutes,
    gitlab: gitlabRoutes,
};

const CONFIGS: Record<GitProviderType, GitProviderConfig> = {
    github: GITHUB_CONFIG,
    bitbucket: BITBUCKET_CONFIG,
    gitlab: GITLAB_CONFIG,
};

describe('#290 commit-date pin conformance across every provider type', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        // `restoreAllMocks` does NOT undo `stubGlobal`, and `unstubGlobals` is not set in
        // vitest.config.ts — without this the last stubbed `fetch` leaks into the next test.
        vi.unstubAllGlobals();
    });

    /**
     * The gate that makes the tables self-maintaining, and the only RUNTIME enforcement here: a
     * provider type added to `GIT_PROVIDER_TYPES` with no entry would otherwise make the lookups
     * below `undefined` and the per-type tests throw a bare `TypeError` — a failure, but one that
     * reads as a broken test rather than as "your new provider is unpinned".
     */
    it('has a config and routes for every provider type createGitProvider supports', () => {
        expect(Object.keys(BASE_ROUTES).sort()).toEqual([...GIT_PROVIDER_TYPES].sort());
        expect(Object.keys(CONFIGS).sort()).toEqual([...GIT_PROVIDER_TYPES].sort());
    });

    it.each(GIT_PROVIDER_TYPES)(
        '%s: reports an unattributable author date through onDrop and still returns the other commits',
        async (type) => {
            const {fetchMock} = makeCountingFetch([
                ...badDateRoutes(type, EXPANDED_YEAR_DATE),
                ...BASE_ROUTES[type](),
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const commits = await createGitProvider(CONFIGS[type]).getCommits(
                REPO,
                SINCE,
                UNTIL,
                undefined,
                onDrop,
            );

            // The bad commit never reaches the caller — the store's throw is one frame past here.
            expect(commits.map((c) => c.sha)).toEqual([GOOD_SHA]);
            // …and the loss is REPORTED, exactly once, naming the sha the provider's own list used.
            expect(onDrop.mock.calls.map((c) => c[0])).toEqual([
                {sha: BAD_SHA, reason: UNATTRIBUTABLE_DATE_DROP_REASON},
            ]);
        },
    );

    it.each(GIT_PROVIDER_TYPES)(
        '%s: reports a MISSING author date under the truncated-response reason, not the unusable one',
        async (type) => {
            const {fetchMock} = makeCountingFetch([
                ...badDateRoutes(type, undefined),
                ...BASE_ROUTES[type](),
            ]);
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const commits = await createGitProvider(CONFIGS[type]).getCommits(
                REPO,
                SINCE,
                UNTIL,
                undefined,
                onDrop,
            );

            expect(commits.map((c) => c.sha)).toEqual([GOOD_SHA]);
            // The distinction the two reasons exist to draw: absent means a truncated body, and
            // sending the operator to look up a real commit with an odd timestamp is the precise
            // opposite of the truth.
            expect(onDrop.mock.calls.map((c) => c[0])).toEqual([
                {sha: BAD_SHA, reason: NO_AUTHOR_DATE_DROP_REASON},
            ]);
        },
    );

    it.each(GIT_PROVIDER_TYPES)(
        '%s: a normal commit set produces no drops at all',
        async (type) => {
            // The positive control. Without it every assertion above would still pass for a
            // provider that dropped EVERY commit, or for one whose fixture stopped matching.
            const {fetchMock} = makeCountingFetch(BASE_ROUTES[type]());
            vi.stubGlobal('fetch', fetchMock);

            const onDrop = vi.fn();
            const commits = await createGitProvider(CONFIGS[type]).getCommits(
                REPO,
                SINCE,
                UNTIL,
                undefined,
                onDrop,
            );

            expect(commits.map((c) => c.sha)).toEqual(SHAS);
            expect(onDrop).not.toHaveBeenCalled();
        },
    );
});
