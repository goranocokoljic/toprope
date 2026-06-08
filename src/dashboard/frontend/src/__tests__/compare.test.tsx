// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {TeamCompare} from '../pages/TeamCompare';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {PaginatedResponse, TeamComparison, TeamListItem, UserPreferences} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const TEAMS: TeamListItem[] = ['frontend', 'backend', 'platform', 'data', 'mobile'].map((name, i) => ({
    name,
    department: 'Engineering',
    manager: null,
    developer_count: 4 + i,
    active_count: 2,
    tool_mix: ['copilot'],
    total_monthly_cost: 100,
    utilization_rate: 0.5,
}));

const COMPARISON: TeamComparison = {
    range: '30d',
    from: '2026-05-01',
    to: '2026-05-30',
    teams: [
        {
            name: 'frontend',
            department: 'Engineering',
            manager: null,
            tier: 'high',
            tier_breakdown: {high: 2, medium: 0, low: 0, none: 0},
            metrics: {
                developer_count: 4,
                active_developer_count: 3,
                utilization_rate: 0.75,
                total_subscription_cost: 200,
                cost_per_pr: 50,
                avg_code_churn: 0.3,
                total_prs_merged: 4,
                ai_maturity_score: 80,
                ai_maturity_basis: 'git_estimate',
                tool_mix: ['copilot', 'claude_code'],
            },
            trend: [
                {date: '2026-05-01', active_developers: 2},
                {date: '2026-05-02', active_developers: 3},
            ],
        },
        {
            name: 'backend',
            department: 'Engineering',
            manager: null,
            tier: 'medium',
            tier_breakdown: {high: 0, medium: 2, low: 0, none: 0},
            metrics: {
                developer_count: 5,
                active_developer_count: 1,
                utilization_rate: 0.2,
                total_subscription_cost: 0,
                cost_per_pr: 0,
                avg_code_churn: 0.1,
                total_prs_merged: 3,
                ai_maturity_score: 60,
                ai_maturity_basis: 'git_estimate',
                tool_mix: [],
            },
            trend: [{date: '2026-05-01', active_developers: 1}],
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

function paginated<T>(rows: T[]): PaginatedResponse<T> {
    return {data: rows, pagination: {page: 1, limit: 100, total: rows.length}};
}

let fetchMock: Mock;

function routeFetch(url: unknown): Response {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname;
    switch (path) {
        case '/api/teams':
            return new Response(JSON.stringify(paginated(TEAMS)), {
                status: 200,
                headers: {'Content-Type': 'application/json'},
            });
        case '/api/compare':
            return jsonResponse({...COMPARISON, range: parsed.searchParams.get('range') ?? COMPARISON.range});
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

function renderPage(): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter>
                    <TeamCompare />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function compareCalls(): string[] {
    return fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => new URL(u, 'http://localhost').pathname === '/api/compare');
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

describe('TeamCompare', () => {
    it('prompts to pick teams until at least two are selected', async () => {
        renderPage();
        // Selector renders a chip per team.
        expect(await screen.findByRole('button', {name: 'frontend'})).toBeInTheDocument();
        expect(screen.getByText('Select teams to compare')).toBeInTheDocument();
        // No comparison request fires with nothing selected.
        expect(compareCalls()).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', {name: 'frontend'}));
        // Still under the minimum after one pick.
        expect(screen.getByText('Select teams to compare')).toBeInTheDocument();
    });

    it('renders side-by-side metrics, tiers, and an overlaid trend once two teams are picked', async () => {
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'frontend'}));
        fireEvent.click(screen.getByRole('button', {name: 'backend'}));

        // The comparison table renders, with both teams as columns.
        expect(await screen.findByText('Side-by-side metrics')).toBeInTheDocument();
        const table = screen.getByRole('table');
        expect(within(table).getByText('AI maturity score')).toBeInTheDocument();
        expect(within(table).getByText('Utilization')).toBeInTheDocument();

        // Each team's data-quality tier is labeled (high vs medium).
        expect(within(table).getByText('High — API')).toBeInTheDocument();
        expect(within(table).getByText('Medium — git')).toBeInTheDocument();

        // Maturity is honestly labeled a git-based estimate.
        expect(within(table).getAllByText('Git-based estimate').length).toBeGreaterThan(0);

        // The overlaid trend chart renders.
        expect(screen.getByTestId('compare-trend-chart')).toBeInTheDocument();
    });

    it('prevents selecting a 5th team — at the cap, other chips are disabled', async () => {
        renderPage();
        for (const name of ['frontend', 'backend', 'platform', 'data']) {
            fireEvent.click(await screen.findByRole('button', {name}));
        }
        // Four selected → the fifth chip is disabled so the UI can't request 5.
        expect(screen.getByRole('button', {name: 'mobile'})).toBeDisabled();
        // A selected chip stays enabled so it can be deselected to swap.
        expect(screen.getByRole('button', {name: 'frontend'})).toBeEnabled();
    });

    it('refetches the comparison when the time range changes', async () => {
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'frontend'}));
        fireEvent.click(screen.getByRole('button', {name: 'backend'}));

        await waitFor(() => expect(compareCalls().some((u) => u.includes('range=30d'))).toBe(true));
        const selector = screen.getByTestId('time-range-selector');
        fireEvent.click(within(selector).getByRole('button', {name: '90d'}));
        await waitFor(() => expect(compareCalls().some((u) => u.includes('range=90d'))).toBe(true));
    });
});
