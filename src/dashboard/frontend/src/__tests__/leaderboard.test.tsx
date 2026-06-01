// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {Leaderboard} from '../pages/Leaderboard';
import {RequireLeaderboard} from '../components/RequireLeaderboard';
import {navSectionsForRole} from '../components/navConfig';
import type {Leaderboard as LeaderboardData, LeaderboardAvailability} from '../api/types';

const AVAILABLE: LeaderboardAvailability = {available: true};
const UNAVAILABLE: LeaderboardAvailability = {available: false};

function board(metric: LeaderboardData['metric']): LeaderboardData {
    return {
        team: 'eng',
        metric,
        from: '2026-05-01',
        to: '2026-05-30',
        entries: [
            {
                rank: 1,
                developer_id: 'd1',
                name: 'Alice',
                value: 100,
                interactions: 100,
                acceptances: 50,
                acceptance_rate: 0.5,
                commits: 2,
                lines_added: 20,
            },
            {
                rank: 2,
                developer_id: 'd2',
                name: 'Bob',
                value: 20,
                interactions: 20,
                acceptances: 18,
                acceptance_rate: 0.9,
                commits: 10,
                lines_added: 100,
            },
        ],
    };
}

let availability: LeaderboardAvailability;
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

beforeEach(() => {
    availability = {...AVAILABLE};
    fetchMock = vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes('/api/leaderboard/availability')) {
            return json({data: availability});
        }
        const metricMatch = /metric=(\w+)/.exec(u);
        if (u.includes('/api/leaderboard/')) {
            return json({data: board((metricMatch?.[1] as LeaderboardData['metric']) ?? 'activity')});
        }
        if (u.includes('/api/teams')) {
            const data = [{name: 'eng'}, {name: 'ops'}];
            return json({data, pagination: {page: 1, limit: 100, total: data.length}});
        }
        return json({error: 'not found'}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderWith(node: JSX.Element): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <MemoryRouter>{node}</MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('navSectionsForRole — leaderboard gating', () => {
    it('omits the leaderboard entry by default (unavailable)', () => {
        const manager = navSectionsForRole('admin').find((s) => s.title === 'Manager');
        expect(manager?.items.some((i) => i.label === 'Leaderboard')).toBe(false);
    });

    it('includes the leaderboard entry only when available', () => {
        const manager = navSectionsForRole('admin', true).find((s) => s.title === 'Manager');
        expect(manager?.items.some((i) => i.label === 'Leaderboard')).toBe(true);
    });

    it('never shows the leaderboard to a developer even when available', () => {
        const sections = navSectionsForRole('developer', true);
        const labels = sections.flatMap((s) => s.items.map((i) => i.label));
        expect(labels).not.toContain('Leaderboard');
    });
});

describe('RequireLeaderboard route guard', () => {
    it('renders the child when the leaderboard is available', async () => {
        availability = {...AVAILABLE};
        renderWith(
            <RequireLeaderboard>
                <div>board contents</div>
            </RequireLeaderboard>,
        );
        expect(await screen.findByText('board contents')).toBeInTheDocument();
    });

    it('renders NotFound (no trace) when the leaderboard is disabled', async () => {
        availability = {...UNAVAILABLE};
        renderWith(
            <RequireLeaderboard>
                <div>board contents</div>
            </RequireLeaderboard>,
        );
        expect(await screen.findByText('Page not found')).toBeInTheDocument();
        expect(screen.queryByText('board contents')).not.toBeInTheDocument();
    });
});

describe('Leaderboard page', () => {
    it('ranks developers for the selected team', async () => {
        renderWith(<Leaderboard />);
        const select = await screen.findByRole('combobox', {name: /team/i});
        await screen.findByRole('option', {name: 'eng'});
        fireEvent.change(select, {target: {value: 'eng'}});

        // Both ranked developers render.
        expect(await screen.findByText('Alice')).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('refetches with the chosen metric when the metric selector changes', async () => {
        renderWith(<Leaderboard />);
        const teamSelect = await screen.findByRole('combobox', {name: /team/i});
        await screen.findByRole('option', {name: 'eng'});
        fireEvent.change(teamSelect, {target: {value: 'eng'}});
        await screen.findByText('Alice');

        const metricSelect = screen.getByRole('combobox', {name: /rank by/i});
        fireEvent.change(metricSelect, {target: {value: 'acceptance'}});

        await waitFor(() => {
            const called = fetchMock.mock.calls.some((c) => String(c[0]).includes('metric=acceptance'));
            expect(called).toBe(true);
        });
    });
});
