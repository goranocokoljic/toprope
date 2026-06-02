// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, render, screen, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {MyActivity} from '../pages/MyActivity';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {MeActivity, MeJourney, MeTimeline, UserPreferences} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const ACTIVITY: MeActivity = {
    range: '30d',
    from: '2026-05-03',
    to: '2026-06-02',
    totals: {
        commits: 120,
        lines_added: 5400,
        lines_removed: 1600,
        files_changed: 230,
        prs_opened: 18,
        prs_merged: 15,
        avg_churn_rate: 0.22,
    },
    providers: [
        {provider: 'github', commits: 90, lines_added: 4000, lines_removed: 1000, files_changed: 180, prs_opened: 12, prs_merged: 10},
        {provider: 'multi', commits: 30, lines_added: 1400, lines_removed: 600, files_changed: 50, prs_opened: 6, prs_merged: 5},
    ],
};

const TIMELINE: MeTimeline = {
    range: '30d',
    from: '2026-05-31',
    to: '2026-06-02',
    points: [
        {
            date: '2026-05-31',
            tool_activity: {is_active: true, interaction_count: 40, tools: ['copilot']},
            git_activity: {commits: 3, lines_added: 120, lines_removed: 10, prs_opened: 2, prs_merged: 1, ai_signature_score: 0.4},
        },
        {
            date: '2026-06-01',
            tool_activity: {is_active: true, interaction_count: 55, tools: ['copilot']},
            git_activity: {commits: 4, lines_added: 90, lines_removed: 5, prs_opened: 1, prs_merged: 2, ai_signature_score: 0.5},
        },
    ],
};

const JOURNEY: MeJourney = {
    tools: [
        {
            tool: 'copilot',
            started_on: '2026-03-01',
            last_active_on: '2026-06-01',
            current_plan: 'business',
            current_monthly_cost: 19,
            active: true,
        },
    ],
    events: [],
};

const PREFERENCES: UserPreferences = {default_time_range: '30d', dark_mode: false};

// --- Route-aware fetch mock ------------------------------------------------

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify({data: body}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });
}

interface Overrides {
    activity?: MeActivity;
    timeline?: MeTimeline;
    failActivity?: boolean;
    failTimeline?: boolean;
}

let fetchMock: Mock;

function installFetch(overrides: Overrides = {}): void {
    fetchMock = vi.fn(async (url: unknown) => {
        const path = new URL(String(url), 'http://localhost').pathname;
        switch (path) {
            case '/api/me/activity':
                if (overrides.failActivity) {
                    return new Response('nope', {status: 500});
                }
                return jsonResponse(overrides.activity ?? ACTIVITY);
            case '/api/me/timeline':
                if (overrides.failTimeline) {
                    return new Response('nope', {status: 500});
                }
                return jsonResponse(overrides.timeline ?? TIMELINE);
            case '/api/me/journey':
                return jsonResponse(JOURNEY);
            case '/api/me/preferences':
                return jsonResponse(PREFERENCES);
            default:
                return new Response(JSON.stringify({error: 'not found'}), {status: 404});
        }
    });
    vi.stubGlobal('fetch', fetchMock);
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

function renderPage(): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter>
                    <MyActivity />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    installFetch();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

// --- Tests -----------------------------------------------------------------

describe('MyActivity — git metrics', () => {
    it('shows commits, PRs merged, lines changed, and churn', async () => {
        renderPage();

        expect(await screen.findByText('120')).toBeInTheDocument(); // commits
        expect(screen.getByText('15')).toBeInTheDocument(); // PRs merged
        expect(screen.getByText('7,000')).toBeInTheDocument(); // lines changed = 5400 + 1600
        expect(screen.getByText('22%')).toBeInTheDocument(); // churn rate
    });

    it('renders the git activity trend chart', async () => {
        renderPage();
        expect(await screen.findByTestId('git-trend')).toBeInTheDocument();
    });
});

describe('MyActivity — churn explanation & correlation copy', () => {
    it('explains churn in plain language', async () => {
        renderPage();
        expect(await screen.findByText('What code churn means')).toBeInTheDocument();
        expect(screen.getByText(/rewritten or deleted again/i)).toBeInTheDocument();
    });

    it('frames AI-vs-output as correlation, not causation', async () => {
        renderPage();
        const caveat = await screen.findByTestId('correlation-caveat');
        expect(caveat).toHaveTextContent(/correlation, not proof that one causes the other/i);
        expect(screen.getByTestId('correlation-trend')).toBeInTheDocument();
    });
});

describe('MyActivity — multi-provider breakdown', () => {
    it('lists per-provider activity and explains the merged multi bucket', async () => {
        renderPage();

        const table = await screen.findByTestId('provider-table');
        expect(within(table).getByText('GitHub')).toBeInTheDocument();
        expect(within(table).getByText('Multiple providers')).toBeInTheDocument();
        // The merged-bucket explanation only appears when a multi row is present.
        expect(screen.getByText(/active on more than one provider/i)).toBeInTheDocument();
    });
});

describe('MyActivity — empty & error states', () => {
    it('shows an empty state when there is no git activity', async () => {
        installFetch({
            activity: {
                ...ACTIVITY,
                totals: {commits: 0, lines_added: 0, lines_removed: 0, files_changed: 0, prs_opened: 0, prs_merged: 0, avg_churn_rate: null},
                providers: [],
            },
        });
        renderPage();
        expect(await screen.findByTestId('my-activity-empty')).toBeInTheDocument();
        expect(screen.getByText('No git activity yet')).toBeInTheDocument();
    });

    it('shows an error state with retry when the activity query fails', async () => {
        installFetch({failActivity: true});
        renderPage();
        expect(await screen.findByText('Failed to load your activity')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Try again'})).toBeInTheDocument();
    });

    it('surfaces a timeline failure in the chart cards rather than rendering them empty', async () => {
        // Activity (stats) succeed but the timeline fails — the charts must show
        // an error, not an empty "no activity" message that contradicts the stats.
        installFetch({failTimeline: true});
        renderPage();
        // Stats still render from the activity query.
        expect(await screen.findByText('120')).toBeInTheDocument();
        // Both chart cards show the trend error instead of an empty chart.
        expect(screen.getAllByText('Couldn’t load your activity trend').length).toBe(2);
        expect(screen.queryByTestId('git-trend')).not.toBeInTheDocument();
        expect(screen.queryByTestId('correlation-trend')).not.toBeInTheDocument();
    });

    it('never renders a competitive ranking or peer comparison', async () => {
        renderPage();
        await screen.findByText('120');
        expect(screen.queryByText(/rank/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/leaderboard/i)).not.toBeInTheDocument();
    });
});
