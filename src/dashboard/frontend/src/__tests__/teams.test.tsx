// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {App} from '../App';
import {TeamsList} from '../pages/TeamsList';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {
    PaginatedResponse,
    TeamDetail as TeamDetailData,
    TeamListItem,
    TeamProviders,
    TeamTrend,
    UserPreferences,
    WasteAlert,
    WasteTeamSummary,
} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const TEAMS: TeamListItem[] = [
    {
        name: 'frontend',
        department: 'Engineering',
        manager: 'Mae',
        developer_count: 4,
        active_count: 3,
        tool_mix: ['copilot', 'claude_code'],
        total_monthly_cost: 200,
        utilization_rate: 0.75, // → Healthy
    },
    {
        name: 'backend',
        department: 'Engineering',
        manager: 'Ada',
        developer_count: 5,
        active_count: 1,
        tool_mix: ['copilot'],
        total_monthly_cost: 100,
        utilization_rate: 0.2, // → Low
    },
];

const WASTE_SUMMARY: WasteTeamSummary[] = [
    {team: 'backend', alert_count: 2, total_monthly_waste: 80, alert_types: ['unused_seat']},
];

const TEAM_DETAIL: TeamDetailData = {
    name: 'frontend',
    department: 'Engineering',
    manager: 'Mae',
    developer_count: 2,
    total_monthly_cost: 200,
    total_monthly_waste: 80,
    developers: [
        {
            id: 'dev-1',
            name: 'Alice Dev',
            email: 'alice@example.com',
            tools: ['copilot'],
            activity_summary: {active_days_30d: 12, total_interactions_30d: 340},
            subscription_cost: 100,
            has_waste: false,
        },
        {
            id: 'dev-2',
            name: 'Bob Dev',
            email: null,
            tools: [],
            activity_summary: {active_days_30d: 0, total_interactions_30d: 0},
            subscription_cost: 0,
            has_waste: true,
        },
    ],
    tool_breakdown: [{tool: 'copilot', developers: 1, monthly_cost: 100}],
};

const TEAM_TREND: TeamTrend = {
    team: 'frontend',
    range: '30d',
    from: '2026-05-01',
    to: '2026-05-05',
    points: [
        {date: '2026-05-01', active_developers: 2, interactions: 20, acceptances: 8},
        {date: '2026-05-02', active_developers: 3, interactions: 25, acceptances: 10},
    ],
};

const TEAM_PROVIDERS: TeamProviders = {
    team: 'frontend',
    providers: [{provider: 'github', developer_count: 2, snapshot_count: 40}],
};

const TEAM_WASTE: WasteAlert[] = [
    {
        id: 'w1',
        developer_id: 'dev-2',
        developer_name: 'Bob Dev',
        team: 'frontend',
        alert_type: 'unused_seat',
        tool: 'copilot',
        details: {},
        monthly_waste: 80,
        detected_at: '2026-05-20T00:00:00.000Z',
    },
];

const PREFERENCES: UserPreferences = {default_time_range: '30d', dark_mode: false};

// --- Route-aware fetch mock ------------------------------------------------

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify({data: body}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });
}

function paginated<T>(rows: T[]): PaginatedResponse<T> {
    return {data: rows, pagination: {page: 1, limit: 100, total: rows.length}};
}

let fetchMock: Mock;

/** Default happy-path router; individual tests can override via mockImplementation. */
function routeFetch(url: unknown): Response {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname;
    switch (path) {
        case '/api/teams':
            return new Response(JSON.stringify(paginated(TEAMS)), {
                status: 200,
                headers: {'Content-Type': 'application/json'},
            });
        case '/api/teams/frontend':
            return jsonResponse(TEAM_DETAIL);
        case '/api/teams/frontend/trend':
            return jsonResponse(TEAM_TREND);
        case '/api/teams/frontend/providers':
            return jsonResponse(TEAM_PROVIDERS);
        case '/api/waste':
            return new Response(JSON.stringify(paginated(TEAM_WASTE)), {
                status: 200,
                headers: {'Content-Type': 'application/json'},
            });
        case '/api/waste/summary':
            return jsonResponse(WASTE_SUMMARY);
        case '/api/me/preferences':
            return jsonResponse(PREFERENCES);
        default:
            return new Response(JSON.stringify({error: 'not found'}), {status: 404});
    }
}

function installFetch(): void {
    fetchMock = vi.fn(async (url: unknown) => routeFetch(url));
    vi.stubGlobal('fetch', fetchMock);
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

function renderList(): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter>
                    <TeamsList />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function renderDetail(initialPath = '/manager/teams/frontend'): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter initialEntries={[initialPath]}>
                    <App />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function teamRowOrder(): string[] {
    return Array.from(document.querySelectorAll('tbody tr td:first-child')).map((td) => td.textContent ?? '');
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

// --- Teams list ------------------------------------------------------------

describe('TeamsList', () => {
    it('renders each team with utilization, cost, tool mix, and merged waste', async () => {
        renderList();

        const table = await screen.findByRole('table');
        // Both teams present.
        expect(within(table).getByRole('link', {name: 'frontend'})).toHaveAttribute(
            'href',
            '/manager/teams/frontend',
        );
        expect(within(table).getByRole('link', {name: 'backend'})).toHaveAttribute(
            'href',
            '/manager/teams/backend',
        );

        // Utilization tiers from documented thresholds: 0.75 → Healthy, 0.2 → Low.
        expect(within(table).getByText('75%')).toBeInTheDocument();
        expect(within(table).getByText('Healthy')).toBeInTheDocument();
        expect(within(table).getByText('20%')).toBeInTheDocument();
        expect(within(table).getByText('Low')).toBeInTheDocument();

        // Waste merged from the summary: backend has $80/mo, frontend has none.
        expect(within(table).getByText('$80/mo')).toBeInTheDocument();
        expect(within(table).getByText('None')).toBeInTheDocument();

        // Tool mix labels render.
        expect(within(table).getAllByText('Copilot').length).toBeGreaterThan(0);
        expect(within(table).getByText('Claude Code')).toBeInTheDocument();
    });

    it('sorts by a column when its header is clicked', async () => {
        renderList();
        await screen.findByRole('table');

        // Default sort is by team name ascending: backend, frontend.
        expect(teamRowOrder()).toEqual(['backend', 'frontend']);

        // Sort by monthly cost ascending: backend (100) then frontend (200).
        fireEvent.click(screen.getByRole('button', {name: /Monthly cost/}));
        expect(teamRowOrder()).toEqual(['backend', 'frontend']);
        // Descending flips it.
        fireEvent.click(screen.getByRole('button', {name: /Monthly cost/}));
        expect(teamRowOrder()).toEqual(['frontend', 'backend']);
    });

    it('shows an empty state when there are no teams', async () => {
        fetchMock.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url), 'http://localhost').pathname;
            if (path === '/api/teams') {
                return new Response(JSON.stringify(paginated([])), {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });
            }
            return routeFetch(url);
        });
        renderList();

        expect(await screen.findByText('No teams yet')).toBeInTheDocument();
    });

    it('does not read a failed waste load as "no waste"', async () => {
        fetchMock.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url), 'http://localhost').pathname;
            if (path === '/api/waste/summary') {
                return new Response('nope', {status: 500});
            }
            return routeFetch(url);
        });
        renderList();

        await screen.findByRole('table');
        // Waste column reads "unknown", never a confident "None".
        expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
        expect(screen.queryByText('None')).not.toBeInTheDocument();
    });
});

// --- Team detail -----------------------------------------------------------

describe('TeamDetail', () => {
    it('renders scoped summary cards, trend, developers, tools, providers, and waste', async () => {
        renderDetail();

        // Header + scoped summary. The heading shows the URL param during load,
        // so wait on a data-derived value before asserting the rest synchronously.
        expect(await screen.findByText('1 / 2')).toBeInTheDocument(); // active = 1 of 2
        expect(screen.getByRole('heading', {name: 'frontend'})).toBeInTheDocument();
        // Potential savings card mirrors total_monthly_waste.
        expect(screen.getByText('$80')).toBeInTheDocument();

        // Developer list shows aggregate activity, framed as health (not a ranking).
        const table = screen.getByRole('table');
        expect(within(table).getByRole('link', {name: 'Alice Dev'})).toHaveAttribute(
            'href',
            '/manager/developers/dev-1',
        );
        expect(within(table).getByText('Active')).toBeInTheDocument();
        expect(within(table).getByText('Inactive')).toBeInTheDocument();
        expect(within(table).getByText('340')).toBeInTheDocument();

        // Tool breakdown (adoption + cost per tool).
        expect(screen.getByText('Tool breakdown')).toBeInTheDocument();
        expect(screen.getByText('$100/mo')).toBeInTheDocument();

        // Git provider label (loaded by an independent query).
        expect(await screen.findByText('GitHub')).toBeInTheDocument();

        // Inline waste alert + link to the waste screen (also an independent query).
        expect(await screen.findByText('Unused seat')).toBeInTheDocument();
        expect(screen.getByRole('link', {name: /View waste detection/})).toHaveAttribute('href', '/manager/waste');

        // Trend chart renders.
        expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
    });

    it('frames the developer list as utilization health, not a ranking', async () => {
        renderDetail();
        expect(await screen.findByText(/not a performance ranking/i)).toBeInTheDocument();
    });

    it('refetches the team trend when the time range changes', async () => {
        renderDetail();
        await screen.findByTestId('trend-chart');

        const trendCalls = (): string[] =>
            fetchMock.mock.calls
                .map((c) => String(c[0]))
                .filter((u) => new URL(u, 'http://localhost').pathname === '/api/teams/frontend/trend');

        await waitFor(() => expect(trendCalls().some((u) => u.includes('range=30d'))).toBe(true));
        fireEvent.click(screen.getByRole('button', {name: '90d'}));
        await waitFor(() => expect(trendCalls().some((u) => u.includes('range=90d'))).toBe(true));
    });

    it('shows a not-found state for an unknown team', async () => {
        fetchMock.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url), 'http://localhost').pathname;
            if (path === '/api/teams/ghost') {
                return new Response(JSON.stringify({error: 'Not Found'}), {status: 404});
            }
            return routeFetch(url);
        });
        renderDetail('/manager/teams/ghost');

        expect(await screen.findByText('Team not found')).toBeInTheDocument();
    });
});

// --- Navigation ------------------------------------------------------------

describe('Teams navigation', () => {
    it('navigates from the teams list to a team detail screen', async () => {
        renderDetail('/manager/teams');

        const link = await screen.findByRole('link', {name: 'frontend'});
        fireEvent.click(link);

        // The detail screen loads its scoped summary for the clicked team.
        expect(await screen.findByRole('heading', {name: 'frontend'})).toBeInTheDocument();
        expect(await screen.findByText('Team utilization health')).toBeInTheDocument();
    });
});
