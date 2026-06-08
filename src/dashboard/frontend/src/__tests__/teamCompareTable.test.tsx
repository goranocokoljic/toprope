// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {TeamCompareTable} from '../pages/TeamCompareTable';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {CompareTable, CompareTableTeam, UserPreferences} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const PREFERENCES: UserPreferences = {default_time_range: '30d', dark_mode: false};

/** A team row with all metrics present, varying by the values passed. */
function team(
    name: string,
    tier: CompareTableTeam['tier'],
    metrics: CompareTableTeam['metrics'],
): CompareTableTeam {
    const breakdown = {high: 0, medium: 0, low: 0, none: 0};
    if (tier !== 'none') breakdown[tier] = 2;
    return {name, department: 'Engineering', manager: null, tier, tier_breakdown: breakdown, metrics};
}

function fullMetrics(over: Partial<NonNullable<CompareTableTeam['metrics']>>): CompareTableTeam['metrics'] {
    return {
        developer_count: 4,
        active_developer_count: 2,
        utilization_rate: 0.5,
        total_subscription_cost: 100,
        cost_per_pr: 25,
        avg_code_churn: 0.2,
        total_prs_merged: 4,
        ai_maturity_score: 60,
        ai_maturity_basis: 'git_estimate',
        wasted_spend: 0,
        unused_seat_count: 0,
        ...over,
    };
}

// Two periods worth of data. alpha/bravo have rows in both; charlie never does
// (null metrics) so we exercise the "all teams listed, one row each" + missing
// metric rendering and sorting paths.
const TABLES: Record<string, CompareTable> = {
    '2026-Q2': {
        period: '2026-Q2',
        available_periods: ['2026-Q2', '2026-Q1'],
        teams: [
            team('alpha', 'high', fullMetrics({utilization_rate: 0.9, ai_maturity_score: 80})),
            team('bravo', 'medium', fullMetrics({utilization_rate: 0.2, ai_maturity_score: 40})),
            team('charlie', 'none', null),
        ],
    },
    '2026-Q1': {
        period: '2026-Q1',
        available_periods: ['2026-Q2', '2026-Q1'],
        teams: [
            team('alpha', 'high', fullMetrics({utilization_rate: 0.3, ai_maturity_score: 50})),
            team('bravo', 'medium', fullMetrics({utilization_rate: 0.5, ai_maturity_score: 55})),
            team('charlie', 'none', null),
        ],
    },
};

// --- Route-aware fetch mock ------------------------------------------------

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify({data: body}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });
}

let fetchMock: Mock;

function routeFetch(url: unknown): Response {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname;
    if (path === '/api/teams/compare-table') {
        // Default to the latest period when none requested (server behavior).
        const period = parsed.searchParams.get('period') ?? '2026-Q2';
        return jsonResponse(TABLES[period] ?? TABLES['2026-Q2']);
    }
    if (path === '/api/me/preferences') {
        return jsonResponse(PREFERENCES);
    }
    return new Response(JSON.stringify({error: 'not found'}), {status: 404});
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
                    <TeamCompareTable />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

/** Team names in current row order (team names are the only links in the table). */
function rowOrder(): string[] {
    return screen.getAllByRole('link').map((a) => a.textContent ?? '');
}

function tableCalls(): URL[] {
    return fetchMock.mock.calls
        .map((c) => new URL(String(c[0]), 'http://localhost'))
        .filter((u) => u.pathname === '/api/teams/compare-table');
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

describe('TeamCompareTable', () => {
    it('lists every overseen team once, defaulting to the latest period', async () => {
        renderPage();
        // All three teams render as rows (one each), in name order initially.
        await waitFor(() => expect(rowOrder()).toEqual(['alpha', 'bravo', 'charlie']));
        // Latest period is selected by default.
        const select = screen.getByLabelText('Period') as HTMLSelectElement;
        expect(select.value).toBe('2026-Q2');
    });

    it('shows each team data-quality tier and an em dash for a team with no row', async () => {
        renderPage();
        expect(await screen.findByText('High — API')).toBeInTheDocument();
        expect(screen.getByText('Medium — git')).toBeInTheDocument();
        // charlie has no metrics → its tier reads "No data".
        expect(screen.getByText('No data')).toBeInTheDocument();
    });

    it('labels AI maturity as a git-based estimate', async () => {
        renderPage();
        // alpha (80) and bravo (40) both carry the honesty label.
        await waitFor(() => expect(screen.getAllByText('Git-based estimate').length).toBe(2));
        expect(screen.getByText('80 / 100')).toBeInTheDocument();
    });

    it('sorts by a metric column, ascending then descending, deterministically', async () => {
        renderPage();
        await waitFor(() => expect(rowOrder()).toEqual(['alpha', 'bravo', 'charlie']));

        const utilHeader = screen.getByRole('button', {name: /Utilization/});
        // Ascending: bravo 20%, alpha 90%, then missing (charlie) LAST.
        fireEvent.click(utilHeader);
        expect(rowOrder()).toEqual(['bravo', 'alpha', 'charlie']);
        // Descending: alpha 90%, bravo 20%, missing STILL last (not flipped to front).
        fireEvent.click(utilHeader);
        expect(rowOrder()).toEqual(['alpha', 'bravo', 'charlie']);
    });

    it('sorts multiple no-data teams to the end deterministically, in both directions', async () => {
        // Two teams have metrics, two have none — the large-org case the sentinel
        // must survive without a NaN comparison (regression for the -Infinity bug).
        const table: CompareTable = {
            period: '2026-Q1',
            available_periods: ['2026-Q1'],
            teams: [
                team('alpha', 'high', fullMetrics({utilization_rate: 0.3})),
                team('bravo', 'high', fullMetrics({utilization_rate: 0.9})),
                team('delta', 'none', null),
                team('gamma', 'none', null),
            ],
        };
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(table)));
        renderPage();
        await waitFor(() => expect(rowOrder()).toEqual(['alpha', 'bravo', 'delta', 'gamma']));

        const utilHeader = screen.getByRole('button', {name: /Utilization/});
        // Ascending: 0.3, 0.9, then the two no-data teams last (stable name order).
        fireEvent.click(utilHeader);
        expect(rowOrder()).toEqual(['alpha', 'bravo', 'delta', 'gamma']);
        // Descending: non-null flip, but the no-data teams STAY last (not flipped
        // to the front) and keep their stable relative order — no NaN reshuffle.
        fireEvent.click(utilHeader);
        expect(rowOrder()).toEqual(['bravo', 'alpha', 'delta', 'gamma']);
    });

    it('sorts by AI maturity independently of utilization', async () => {
        renderPage();
        await waitFor(() => expect(rowOrder()).toEqual(['alpha', 'bravo', 'charlie']));

        const maturityHeader = screen.getByRole('button', {name: /AI maturity/});
        fireEvent.click(maturityHeader); // asc: bravo 40, alpha 80, charlie (none) last
        expect(rowOrder()).toEqual(['bravo', 'alpha', 'charlie']);
    });

    it('changes the underlying aggregates when the period changes', async () => {
        renderPage();
        // Q2: alpha maturity 80.
        expect(await screen.findByText('80 / 100')).toBeInTheDocument();

        const select = screen.getByLabelText('Period');
        fireEvent.change(select, {target: {value: '2026-Q1'}});

        // Q1: alpha maturity 50 — the table re-rendered against the new period.
        expect(await screen.findByText('50 / 100')).toBeInTheDocument();
        await waitFor(() => expect(tableCalls().some((u) => u.searchParams.get('period') === '2026-Q1')).toBe(true));
    });
});
