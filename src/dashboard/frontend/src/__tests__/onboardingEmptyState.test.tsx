// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {OnboardingEmptyState} from '../components/OnboardingEmptyState';
import {AuthContext, type AuthContextValue} from '../auth/authContext';
import type {AuthUser, AuthorCandidate, UserRole} from '../api/types';

/**
 * The onboarding empty-state's visibility rule (DO1.7 / #257).
 *
 * The rule is the whole feature: this panel exists to rescue the cold-start dead
 * end (git authorship retained, zero developers) and must vanish the moment that
 * state no longer holds — a permanent "you have unmatched authors" banner on an
 * org that already onboarded people is noise, and showing it to a non-admin
 * offers an action the server would refuse.
 *
 * Every case below therefore asserts BOTH the visible signal and the request that
 * backs it, because "renders nothing" has two very different causes worth telling
 * apart: gated out before fetching, versus fetched and found nothing.
 */

let candidates: AuthorCandidate[];
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function candidate(key: string): AuthorCandidate {
    return {
        raw_author_key: key,
        provider: 'github',
        login: key.split(':').pop() ?? key,
        email: null,
        display_name: null,
        commit_count: 12,
        first_seen: '2026-01-05T00:00:00.000Z',
        last_seen: '2026-07-01T00:00:00.000Z',
        likely_bot: false,
    };
}

function authValue(role: UserRole | null): AuthContextValue {
    const user: AuthUser | null =
        role === null ? null : {email: 'someone@test.com', role, developer_id: null, must_change_password: false};
    return {
        user,
        loading: false,
        login: async () => undefined,
        logout: async () => undefined,
        changePassword: async () => undefined,
    };
}

/** Render the panel under a given viewer role and developer count. */
function renderPanel(opts: {role: UserRole | null; totalDevelopers: number}): void {
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    render(
        <QueryClientProvider client={client}>
            <AuthContext.Provider value={authValue(opts.role)}>
                <MemoryRouter>
                    <OnboardingEmptyState totalDevelopers={opts.totalDevelopers} />
                </MemoryRouter>
            </AuthContext.Provider>
        </QueryClientProvider>,
    );
}

/** Did anything ask the admin candidates route? */
function candidatesFetched(): boolean {
    return fetchMock.mock.calls.some(([url]) => String(url).includes('/api/admin/developers/candidates'));
}

beforeEach(() => {
    candidates = [candidate('github:login:jane-gh'), candidate('github:login:sam-gh')];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/admin/developers/candidates')) return json({data: candidates});
        return json({error: `unexpected fetch: ${url}`}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('OnboardingEmptyState visibility rule', () => {
    it('shows the panel, the unmatched count, and a link to the review queue', async () => {
        renderPanel({role: 'admin', totalDevelopers: 0});

        const panel = await screen.findByTestId('onboarding-empty-state');
        expect(panel).toHaveTextContent('You have unmatched authors');
        // The count is the point of the panel — a generic "you have some authors"
        // gives an admin no sense of whether this is one bot or the whole team.
        expect(panel).toHaveTextContent('2 git authors');

        const link = screen.getByRole('link', {name: /review 2 unmatched authors/i});
        expect(link).toHaveAttribute('href', '/admin/identities');
    });

    it('singularizes the copy for exactly one unmatched author', async () => {
        candidates = [candidate('github:login:jane-gh')];
        renderPanel({role: 'admin', totalDevelopers: 0});

        const panel = await screen.findByTestId('onboarding-empty-state');
        expect(panel).toHaveTextContent('1 git author');
        expect(panel).not.toHaveTextContent('1 git authors');
        expect(screen.getByRole('link', {name: /review 1 unmatched author/i})).toBeInTheDocument();
    });

    it('hides once any developer exists — and does not even ask for candidates', async () => {
        renderPanel({role: 'admin', totalDevelopers: 1});

        // Wait for a settle window so a late-arriving render can still fail this.
        await waitFor(() => expect(screen.queryByTestId('onboarding-empty-state')).not.toBeInTheDocument());
        expect(candidatesFetched()).toBe(false);
    });

    it('hides when there are zero developers but no retained authorship either', async () => {
        candidates = [];
        renderPanel({role: 'admin', totalDevelopers: 0});

        // Here the query DOES run — the panel is absent because the queue came
        // back empty, not because it was gated out. Asserting the fetch happened
        // is what distinguishes this from the developers-exist case above.
        await waitFor(() => expect(candidatesFetched()).toBe(true));
        expect(screen.queryByTestId('onboarding-empty-state')).not.toBeInTheDocument();
    });

    it('excludes likely bots from the count, and hides when every author is one', async () => {
        const bot = {...candidate('github:login:dependabot[bot]'), likely_bot: true, bot_reason: 'known bot'};
        // First: a mixed queue counts only the human.
        candidates = [bot, candidate('github:login:jane-gh')];
        renderPanel({role: 'admin', totalDevelopers: 0});
        const panel = await screen.findByTestId('onboarding-empty-state');
        expect(panel).toHaveTextContent('1 git author');
        expect(panel).not.toHaveTextContent('2 git authors');

        // Then: an all-bot queue is not something to onboard, so no panel at all.
        cleanup();
        candidates = [bot];
        renderPanel({role: 'admin', totalDevelopers: 0});
        await waitFor(() => expect(candidatesFetched()).toBe(true));
        expect(screen.queryByTestId('onboarding-empty-state')).not.toBeInTheDocument();
    });

    it('hides from a non-admin viewer, who could not act on it anyway', async () => {
        renderPanel({role: 'developer', totalDevelopers: 0});

        await waitFor(() => expect(screen.queryByTestId('onboarding-empty-state')).not.toBeInTheDocument());
        // The route is admin-gated: an ungated fetch here would 403 on every
        // manager's overview load.
        expect(candidatesFetched()).toBe(false);
    });

    it('renders nothing when the candidates request fails rather than guessing a count', async () => {
        fetchMock.mockImplementation(async () => json({error: 'boom'}, 500));
        renderPanel({role: 'admin', totalDevelopers: 0});

        await waitFor(() => expect(candidatesFetched()).toBe(true));
        expect(screen.queryByTestId('onboarding-empty-state')).not.toBeInTheDocument();
    });

    it('renders nothing outside an AuthProvider instead of throwing', () => {
        const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
        render(
            <QueryClientProvider client={client}>
                <MemoryRouter>
                    <OnboardingEmptyState totalDevelopers={0} />
                </MemoryRouter>
            </QueryClientProvider>,
        );
        expect(screen.queryByTestId('onboarding-empty-state')).not.toBeInTheDocument();
        expect(candidatesFetched()).toBe(false);
    });
});
