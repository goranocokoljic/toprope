/**
 * Multi-provider equivalence for review verdicts (Task 5.2 / #123).
 *
 * The same logical review history — Bob requests changes, then Bob approves —
 * expressed in each provider's native API shape must normalize to the identical
 * GitPRReview sequence, so the PR/review metrics engine works identically
 * across GitHub, Bitbucket, and GitLab.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import {GitHubProvider} from '../../../src/connectors/git/providers/github';
import {BitbucketProvider} from '../../../src/connectors/git/providers/bitbucket';
import {GitLabProvider} from '../../../src/connectors/git/providers/gitlab';
import type {GitPRReview} from '../../../src/connectors/git/providers/types';

const T1 = '2026-05-04T10:00:00Z';
const T2 = '2026-05-05T15:00:00Z';

function stubFetch(body: unknown): void {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({}),
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(''),
        } as unknown as Response),
    );
}

/** Strip the author, which providers populate from different fields. */
function essence(reviews: GitPRReview[]): Array<{state: string; submittedAt: string; prId: string}> {
    return reviews.map((r) => ({state: r.state, submittedAt: r.submittedAt, prId: r.prId}));
}

const EXPECTED = [
    {state: 'changes_requested', submittedAt: T1, prId: '7'},
    {state: 'approved', submittedAt: T2, prId: '7'},
];

describe('getPRReviews — cross-provider normalization', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('GitHub: review states normalize to the canonical sequence', async () => {
        stubFetch([
            {user: {login: 'bob'}, state: 'CHANGES_REQUESTED', submitted_at: T1},
            {user: {login: 'bob'}, state: 'APPROVED', submitted_at: T2},
            // PENDING reviews have no submitted_at and are not yet events
            {user: {login: 'carol'}, state: 'PENDING', submitted_at: null},
        ]);
        const provider = new GitHubProvider({
            type: 'github',
            org: 'test-org',
            auth: {type: 'token', api_token: 't'},
        });

        const reviews = await provider.getPRReviews('repo', '7');
        expect(essence(reviews)).toEqual(EXPECTED);
    });

    it('GitHub: COMMENTED and DISMISSED states are skipped — only explicit verdicts are events, matching the other providers', async () => {
        stubFetch([
            {user: {login: 'bob'}, state: 'COMMENTED', submitted_at: T1},
            {user: {login: 'bob'}, state: 'DISMISSED', submitted_at: T2},
        ]);
        const provider = new GitHubProvider({
            type: 'github',
            org: 'test-org',
            auth: {type: 'token', api_token: 't'},
        });

        const reviews = await provider.getPRReviews('repo', '7');
        expect(reviews).toHaveLength(0);
    });

    it('Bitbucket: activity entries lacking a date are skipped, not crashed on', async () => {
        stubFetch({
            values: [
                {approval: {user: {nickname: 'bob'}}}, // no date
                {changes_requested: {date: T1, user: {nickname: 'bob'}}},
            ],
        });
        const provider = new BitbucketProvider({
            type: 'bitbucket',
            workspace: 'ws',
            auth: {type: 'access_token', token: 't'},
        });

        const reviews = await provider.getPRReviews('repo', '7');
        expect(essence(reviews)).toEqual([{state: 'changes_requested', submittedAt: T1, prId: '7'}]);
    });

    it('GitLab: extended system-note wording still matches (startsWith, not equality)', async () => {
        stubFetch([
            {system: true, body: 'requested changes from @bob', created_at: T1, author: {username: 'bob', name: 'Bob'}, type: null},
            {system: true, body: 'approved this merge request via the API', created_at: T2, author: {username: 'bob', name: 'Bob'}, type: null},
        ]);
        const provider = new GitLabProvider({
            type: 'gitlab',
            group: 'grp',
            auth: {type: 'personal_access_token', token: 't'},
        });

        const reviews = await provider.getPRReviews('grp/repo', '7');
        expect(essence(reviews)).toEqual(EXPECTED);
    });

    it('Bitbucket: activity entries normalize to the canonical sequence (newest-first feed)', async () => {
        stubFetch({
            values: [
                // Bitbucket's activity feed is newest-first and mixes in
                // comment/update entries that are not review verdicts.
                {approval: {date: T2, user: {nickname: 'bob'}}},
                {comment: {id: 1}},
                {changes_requested: {date: T1, user: {nickname: 'bob'}}},
                {update: {state: 'OPEN'}},
            ],
        });
        const provider = new BitbucketProvider({
            type: 'bitbucket',
            workspace: 'ws',
            auth: {type: 'access_token', token: 't'},
        });

        const reviews = await provider.getPRReviews('repo', '7');
        expect(essence(reviews)).toEqual(EXPECTED);
    });

    it('GitLab: system notes normalize to the canonical sequence', async () => {
        stubFetch([
            {system: true, body: 'requested changes', created_at: T1, author: {username: 'bob', name: 'Bob'}, type: null},
            {system: true, body: 'approved this merge request', created_at: T2, author: {username: 'bob', name: 'Bob'}, type: null},
            // Plain discussion + system noise are not review verdicts
            {system: false, body: 'nice work', created_at: T2, author: {username: 'carol', name: 'Carol'}, type: 'DiffNote'},
            {system: true, body: 'mentioned in commit abc123', created_at: T2, author: {username: 'bob', name: 'Bob'}, type: null},
        ]);
        const provider = new GitLabProvider({
            type: 'gitlab',
            group: 'grp',
            auth: {type: 'personal_access_token', token: 't'},
        });

        const reviews = await provider.getPRReviews('grp/repo', '7');
        expect(essence(reviews)).toEqual(EXPECTED);
    });

    it('all three providers produce the identical normalized sequence', async () => {
        const results: Array<ReturnType<typeof essence>> = [];

        stubFetch([
            {user: {login: 'bob'}, state: 'CHANGES_REQUESTED', submitted_at: T1},
            {user: {login: 'bob'}, state: 'APPROVED', submitted_at: T2},
        ]);
        results.push(
            essence(
                await new GitHubProvider({
                    type: 'github',
                    org: 'o',
                    auth: {type: 'token', api_token: 't'},
                }).getPRReviews('repo', '7'),
            ),
        );

        stubFetch({
            values: [
                {approval: {date: T2, user: {nickname: 'bob'}}},
                {changes_requested: {date: T1, user: {nickname: 'bob'}}},
            ],
        });
        results.push(
            essence(
                await new BitbucketProvider({
                    type: 'bitbucket',
                    workspace: 'w',
                    auth: {type: 'access_token', token: 't'},
                }).getPRReviews('repo', '7'),
            ),
        );

        stubFetch([
            {system: true, body: 'requested changes', created_at: T1, author: {username: 'bob', name: 'Bob'}, type: null},
            {system: true, body: 'approved this merge request', created_at: T2, author: {username: 'bob', name: 'Bob'}, type: null},
        ]);
        results.push(
            essence(
                await new GitLabProvider({
                    type: 'gitlab',
                    group: 'g',
                    auth: {type: 'personal_access_token', token: 't'},
                }).getPRReviews('g/repo', '7'),
            ),
        );

        expect(results[0]).toEqual(EXPECTED);
        expect(results[1]).toEqual(results[0]);
        expect(results[2]).toEqual(results[0]);
    });
});
