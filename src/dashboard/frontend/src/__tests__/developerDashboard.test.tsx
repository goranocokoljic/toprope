// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {DeveloperDashboard} from '../pages/DeveloperDashboard';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {MeJourney, MeOverview, MeTimeline, UserPreferences} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const MONTH_OVERVIEW: MeOverview = {
    range: '30d',
    from: '2026-05-03',
    to: '2026-06-02',
    active_days: 18,
    primary_tools: ['copilot', 'claude_code'],
    acceptance_rate: {current: 0.42, previous: 0.35, trend: 'up'},
    estimated_monthly_cost: 34,
};

const WEEK_OVERVIEW: MeOverview = {
    ...MONTH_OVERVIEW,
    range: 'custom',
    from: '2026-05-27',
    to: '2026-06-02',
    active_days: 4,
};

const JOURNEY: MeJourney = {
    tools: [
        {
            tool: 'copilot',
            started_on: '2026-03-01',
            last_active_on: '2026-05-28',
            current_plan: 'business',
            current_monthly_cost: 19,
            active: true,
        },
        {
            tool: 'windsurf',
            started_on: '2026-04-01',
            last_active_on: '2026-04-20',
            current_plan: null,
            current_monthly_cost: null,
            active: false,
        },
    ],
    events: [
        {
            date: '2026-03-01',
            type: 'started',
            tool: 'copilot',
            from_tool: null,
            from_plan: null,
            to_plan: null,
            old_monthly_cost: null,
            new_monthly_cost: null,
        },
        {
            date: '2026-04-15',
            type: 'plan_change',
            tool: 'claude_code',
            from_tool: null,
            from_plan: 'pro',
            to_plan: 'max',
            old_monthly_cost: 20,
            new_monthly_cost: 200,
        },
        {
            date: '2026-05-10',
            type: 'tool_switch',
            tool: 'windsurf',
            from_tool: 'copilot',
            from_plan: 'business',
            to_plan: 'pro',
            old_monthly_cost: 19,
            new_monthly_cost: 15,
        },
    ],
};

const TIMELINE: MeTimeline = {
    range: '90d',
    from: '2026-05-01',
    to: '2026-05-03',
    points: [
        {
            date: '2026-05-01',
            tool_activity: {is_active: true, interaction_count: 40, tools: ['copilot']},
            git_activity: {commits: 3, lines_added: 120, lines_removed: 10, prs_opened: 2, prs_merged: 1, ai_signature_score: 0.4},
        },
        {
            date: '2026-05-02',
            tool_activity: {is_active: true, interaction_count: 55, tools: ['copilot']},
            git_activity: {commits: 4, lines_added: 90, lines_removed: 5, prs_opened: 1, prs_merged: 2, ai_signature_score: 0.5},
        },
    ],
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
    monthOverview?: MeOverview;
    weekOverview?: MeOverview;
    journey?: MeJourney;
    timeline?: MeTimeline;
    failOverview?: boolean;
}

let fetchMock: Mock;

function installFetch(overrides: Overrides = {}): void {
    fetchMock = vi.fn(async (url: unknown) => {
        const parsed = new URL(String(url), 'http://localhost');
        const path = parsed.pathname;
        switch (path) {
            case '/api/me/overview': {
                if (overrides.failOverview) {
                    return new Response('nope', {status: 500});
                }
                // The month card uses range=30d; the week card uses a custom window.
                const isMonth = parsed.searchParams.get('range') === '30d';
                return jsonResponse(isMonth ? overrides.monthOverview ?? MONTH_OVERVIEW : overrides.weekOverview ?? WEEK_OVERVIEW);
            }
            case '/api/me/journey':
                return jsonResponse(overrides.journey ?? JOURNEY);
            case '/api/me/timeline':
                return jsonResponse(overrides.timeline ?? TIMELINE);
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
                    <DeveloperDashboard />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function timelineCalls(): string[] {
    return fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => new URL(u, 'http://localhost').pathname === '/api/me/timeline');
}

beforeEach(() => {
    installFetch();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

// --- Tests -----------------------------------------------------------------

describe('DeveloperDashboard — personal stat cards', () => {
    it('shows active days (week + month), primary tool, acceptance rate, and cost', async () => {
        renderPage();

        // Active days headline is the 30-day count; the hint carries the week count.
        expect(await screen.findByText('18')).toBeInTheDocument();
        expect(screen.getByText('4 this week · last 30 days')).toBeInTheDocument();

        // Primary tool is the most-used; the hint notes the others in play.
        // ('Copilot' also appears in the journey, so match at least one.)
        expect(screen.getAllByText('Copilot').length).toBeGreaterThan(0);
        expect(screen.getByText('+1 other tool in use')).toBeInTheDocument();

        // Acceptance rate with an upward points-delta (42% vs 35% → +7pp).
        expect(screen.getByText('42%')).toBeInTheDocument();
        expect(screen.getByText('7pp')).toBeInTheDocument();

        // Estimated personal AI cost.
        expect(screen.getByText('$34')).toBeInTheDocument();
    });

    it('never renders a competitive ranking or peer comparison', async () => {
        renderPage();
        await screen.findByText('18');
        expect(screen.queryByText(/rank/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/vs\.? (your )?team/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/leaderboard/i)).not.toBeInTheDocument();
    });
});

describe('DeveloperDashboard — adoption journey', () => {
    it('lists per-tool status and a chronological milestone timeline', async () => {
        renderPage();

        const tools = await screen.findByTestId('journey-tools');
        expect(within(tools).getByText('Copilot')).toBeInTheDocument();
        expect(within(tools).getByText('Windsurf')).toBeInTheDocument();

        const timeline = screen.getByTestId('journey-timeline');
        expect(within(timeline).getByText('Started using Copilot')).toBeInTheDocument();
        // Plan upgrade with a cost delta.
        expect(within(timeline).getByText('Claude Code: pro → max')).toBeInTheDocument();
        expect(within(timeline).getByText('+$180/mo')).toBeInTheDocument();
        // Tool switch.
        expect(within(timeline).getByText('Switched from Copilot to Windsurf')).toBeInTheDocument();
    });
});

describe('DeveloperDashboard — activity trend', () => {
    it('renders the trend chart and refetches when the range changes', async () => {
        renderPage();

        expect(await screen.findByTestId('trend-chart')).toBeInTheDocument();
        await waitFor(() => expect(timelineCalls().length).toBeGreaterThan(0));

        // Switching the range issues a fresh, differently-keyed timeline query.
        fireEvent.click(screen.getByRole('button', {name: '90d'}));
        await waitFor(() => expect(timelineCalls().some((u) => u.includes('range=90d'))).toBe(true));
    });
});

describe('DeveloperDashboard — cold-start & low-data', () => {
    it('shows a "building your history" panel when nothing is tracked yet', async () => {
        installFetch({
            monthOverview: {...MONTH_OVERVIEW, active_days: 0, primary_tools: []},
            journey: {tools: [], events: []},
        });
        renderPage();

        expect(await screen.findByTestId('developer-cold-start')).toBeInTheDocument();
        expect(screen.getByText('Building your history')).toBeInTheDocument();
        // The full dashboard's stat cards must not render in this state.
        expect(screen.queryByText('Acceptance rate')).not.toBeInTheDocument();
    });

    it('shows an encouraging low-data note for a young but non-empty history', async () => {
        // Start date relative to "now" (3 days ago) so the <14-day window holds
        // regardless of when the suite runs — no need to fake the clock, which
        // would also stall testing-library's timer-based waits.
        const startedOn = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
        installFetch({
            journey: {
                tools: [
                    {
                        tool: 'copilot',
                        started_on: startedOn,
                        last_active_on: startedOn,
                        current_plan: 'business',
                        current_monthly_cost: 19,
                        active: true,
                    },
                ],
                events: [
                    {
                        date: startedOn,
                        type: 'started',
                        tool: 'copilot',
                        from_tool: null,
                        from_plan: null,
                        to_plan: null,
                        old_monthly_cost: null,
                        new_monthly_cost: null,
                    },
                ],
            },
        });
        renderPage();

        const note = await screen.findByTestId('low-data-note');
        expect(note).toHaveTextContent("We're still building your history");
        // The dashboard still renders alongside the note (not a hard block).
        expect(screen.getByText('My adoption journey')).toBeInTheDocument();
    });
});

describe('DeveloperDashboard — error handling', () => {
    it('shows an error state with retry when the overview fails', async () => {
        installFetch({failOverview: true});
        renderPage();

        expect(await screen.findByText('Failed to load your dashboard')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Try again'})).toBeInTheDocument();
    });
});
