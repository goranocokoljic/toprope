// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {App} from '../App';
import {ManagerOverview} from '../pages/ManagerOverview';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {
    CoverageData,
    OverviewData,
    OverviewTrend,
    ToolDistribution,
    UserPreferences,
    WasteTeamSummary,
} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const OVERVIEW: OverviewData = {
    total_developers: 20,
    active_developers: 12,
    total_subscriptions: 18,
    total_monthly_cost: 1234,
    active_tools: ['copilot', 'claude_code'],
    data_quality_distribution: {high: 8, medium: 5, low: 4, none: 3},
    active_waste_alert_count: 3,
    total_monthly_waste: 177,
};

const DISTRIBUTION: ToolDistribution = {
    tools: [
        {tool: 'copilot', seats: 10, developers: 8, monthly_cost: 190},
        {tool: 'claude_code', seats: 5, developers: 5, monthly_cost: 100},
    ],
    total_seats: 15,
    total_monthly_cost: 290,
};

const TREND: OverviewTrend = {
    range: '30d',
    from: '2026-05-01',
    to: '2026-05-05',
    points: [
        {date: '2026-05-01', active_developers: 3, interactions: 10, acceptances: 4},
        {date: '2026-05-02', active_developers: 5, interactions: 12, acceptances: 6},
    ],
};

const COVERAGE: CoverageData = {
    data_quality: {high: 8, medium: 5, low: 4, none: 3},
    connectors: [
        {connector: 'copilot', connected: true, status: 'success', last_sync: '2026-05-30T10:00:00.000Z'},
        {connector: 'claude_code', connected: false, status: null, last_sync: null},
        {connector: 'windsurf', connected: true, status: 'error', last_sync: '2026-05-29T09:00:00.000Z'},
    ],
    git_providers: [
        {provider: 'github', connected: true, developer_count: 7, last_sync: '2026-05-30T08:00:00.000Z'},
        {provider: 'bitbucket', connected: false, developer_count: 0, last_sync: null},
        {provider: 'gitlab', connected: false, developer_count: 0, last_sync: null},
    ],
};

const WASTE_SUMMARY: WasteTeamSummary[] = [
    {team: 'platform', alert_count: 3, total_monthly_waste: 177, alert_types: ['unused_seat']},
    {team: 'frontend', alert_count: 1, total_monthly_waste: 40, alert_types: ['duplicate']},
];

const PREFERENCES: UserPreferences = {default_time_range: '30d', dark_mode: false};

// --- Route-aware fetch mock ------------------------------------------------

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify({data: body}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });
}

let fetchMock: Mock;

function installFetch(): void {
    fetchMock = vi.fn(async (url: unknown) => {
        const path = new URL(String(url), 'http://localhost').pathname;
        switch (path) {
            case '/api/overview':
                return jsonResponse(OVERVIEW);
            case '/api/tools/distribution':
                return jsonResponse(DISTRIBUTION);
            case '/api/overview/trend':
                return jsonResponse(TREND);
            case '/api/coverage':
                return jsonResponse(COVERAGE);
            case '/api/waste/summary':
                return jsonResponse(WASTE_SUMMARY);
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
                    <ManagerOverview />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function renderApp(initialPath: string): void {
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

function trendCalls(): string[] {
    return fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => new URL(u, 'http://localhost').pathname === '/api/overview/trend');
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

describe('ManagerOverview — top-line metrics', () => {
    it('shows active developers, spend, utilization, and potential savings from the API', async () => {
        renderPage();

        expect(await screen.findByText('12 / 20')).toBeInTheDocument();
        expect(screen.getByText('$1,234')).toBeInTheDocument();
        // Utilization = active developers / paid seats = 12 / 18 → 67%.
        expect(screen.getByText('67%')).toBeInTheDocument();
        expect(screen.getByText('12 active / 18 paid seats')).toBeInTheDocument();
        // Potential savings = total monthly waste, with the active-alert count.
        expect(screen.getByText('$177')).toBeInTheDocument();
        expect(screen.getByText('3 active alerts')).toBeInTheDocument();
    });

    it('renders an em dash for utilization when there are no paid seats', async () => {
        fetchMock.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url), 'http://localhost').pathname;
            if (path === '/api/overview') {
                return jsonResponse({...OVERVIEW, total_subscriptions: 0});
            }
            if (path === '/api/me/preferences') return jsonResponse(PREFERENCES);
            if (path === '/api/tools/distribution') return jsonResponse(DISTRIBUTION);
            if (path === '/api/overview/trend') return jsonResponse(TREND);
            if (path === '/api/coverage') return jsonResponse(COVERAGE);
            if (path === '/api/waste/summary') return jsonResponse(WASTE_SUMMARY);
            return new Response('{}', {status: 404});
        });
        renderPage();

        expect(await screen.findByText('—')).toBeInTheDocument();
        expect(screen.getByText('no paid seats yet')).toBeInTheDocument();
    });

    it('clamps utilization at 100% but the hint explains over-subscription', async () => {
        fetchMock.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url), 'http://localhost').pathname;
            if (path === '/api/overview') {
                // More active developers than paid seats: headline clamps, hint owns the reason.
                return jsonResponse({...OVERVIEW, active_developers: 20, total_subscriptions: 18});
            }
            if (path === '/api/me/preferences') return jsonResponse(PREFERENCES);
            if (path === '/api/tools/distribution') return jsonResponse(DISTRIBUTION);
            if (path === '/api/overview/trend') return jsonResponse(TREND);
            if (path === '/api/coverage') return jsonResponse(COVERAGE);
            if (path === '/api/waste/summary') return jsonResponse(WASTE_SUMMARY);
            return new Response('{}', {status: 404});
        });
        renderPage();

        expect(await screen.findByText('100%')).toBeInTheDocument();
        expect(screen.getByText('20 active developers exceed 18 paid seats')).toBeInTheDocument();
    });
});

describe('ManagerOverview — tool distribution', () => {
    it('renders developers, seats, and cost per tool plus the total', async () => {
        renderPage();

        // Donut + table both populate from /api/tools/distribution.
        expect(await screen.findByTestId('distribution-chart')).toBeInTheDocument();
        const table = screen.getByRole('table');
        expect(within(table).getByText('Copilot')).toBeInTheDocument();
        expect(within(table).getByText('Claude Code')).toBeInTheDocument();
        expect(within(table).getByText('$190')).toBeInTheDocument();
        expect(within(table).getByText('$100')).toBeInTheDocument();
        // Donut center shows the org-wide monthly total.
        expect(screen.getByText('$290')).toBeInTheDocument();
    });
});

describe('ManagerOverview — adoption trend', () => {
    it('renders the trend chart and refetches when the time range changes', async () => {
        renderPage();

        expect(await screen.findByTestId('trend-chart')).toBeInTheDocument();
        // Initial fetch is the default 30d preset.
        await waitFor(() => expect(trendCalls().some((u) => u.includes('range=30d'))).toBe(true));

        // Switching the range issues a fresh, differently-keyed query. The page
        // now has two time-range selectors (adoption + maturity trends); scope to
        // the first, the adoption-trend one this test drives.
        const adoptionSelector = screen.getAllByTestId('time-range-selector')[0];
        fireEvent.click(within(adoptionSelector).getByRole('button', {name: '90d'}));
        await waitFor(() => expect(trendCalls().some((u) => u.includes('range=90d'))).toBe(true));
    });
});

describe('ManagerOverview — data coverage', () => {
    it('shows quality breakdown, connector status, and git provider coverage', async () => {
        renderPage();

        const panel = await screen.findByTestId('coverage-panel');
        // Quality breakdown is present with the four tiers.
        const quality = within(panel).getByTestId('coverage-quality');
        expect(quality).toHaveTextContent('High');
        expect(quality).toHaveTextContent('Medium');

        // Connector status reflects the backend's per-connector sync state.
        const connectors = within(panel).getByTestId('coverage-connectors');
        expect(within(connectors).getByText('Copilot')).toBeInTheDocument();
        const claude = within(connectors).getByText('Claude Code').closest('li');
        expect(claude).toHaveTextContent('not connected');

        // Git providers report developer counts (the honest Phase-1 unit).
        const git = within(panel).getByTestId('coverage-git');
        expect(within(git).getByText('GitHub')).toBeInTheDocument();
        expect(within(git).getByText('7 developers')).toBeInTheDocument();
    });
});

describe('ManagerOverview — quick links & needs attention', () => {
    it('surfaces the worst team by waste and links to the waste screen', async () => {
        renderPage();

        // The summary is waste-descending; the worst team leads.
        expect(await screen.findByText('platform')).toBeInTheDocument();
        expect(screen.getByText('$177/mo')).toBeInTheDocument();

        const teamsLink = screen.getByRole('link', {name: /Teams/});
        expect(teamsLink).toHaveAttribute('href', '/manager/teams');
        const wasteLink = screen.getByRole('link', {name: /Waste detection/});
        expect(wasteLink).toHaveAttribute('href', '/manager/waste');
    });

    it('shows an error state (not a false "all clear") when the waste summary fails', async () => {
        fetchMock.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url), 'http://localhost').pathname;
            if (path === '/api/waste/summary') {
                return new Response('nope', {status: 500});
            }
            if (path === '/api/overview') return jsonResponse(OVERVIEW);
            if (path === '/api/me/preferences') return jsonResponse(PREFERENCES);
            if (path === '/api/tools/distribution') return jsonResponse(DISTRIBUTION);
            if (path === '/api/overview/trend') return jsonResponse(TREND);
            if (path === '/api/coverage') return jsonResponse(COVERAGE);
            return new Response('{}', {status: 404});
        });
        renderPage();

        expect(await screen.findByText('Failed to load waste summary')).toBeInTheDocument();
        // The empty-state copy must NOT appear — a failed load is not "all clear".
        expect(screen.queryByText('No teams need attention right now.')).not.toBeInTheDocument();
    });

    it('quick links resolve to real routes (no dead links)', async () => {
        renderApp('/manager');

        // Wait for the ready state, then follow the Teams quick link.
        await screen.findByText('12 / 20');
        fireEvent.click(screen.getByRole('link', {name: /Teams/}));
        expect(await screen.findByRole('heading', {name: 'Teams'})).toBeInTheDocument();
    });
});
