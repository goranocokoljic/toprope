// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, render, screen, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Route, Routes} from 'react-router-dom';

import {DeveloperDetail} from '../pages/DeveloperDetail';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {DeveloperIdentity, DeveloperJourney} from '../api/types';

const IDENTITY: DeveloperIdentity = {
    id: 'dev-1',
    name: 'Alice Dev',
    email: 'alice@test.com',
    team: 'frontend',
};

const JOURNEY: DeveloperJourney = {
    bounds: {first_activity: '2026-03-01', last_activity: '2026-05-20'},
    tier: 'medium',
    trajectory: [
        {week_start: '2026-03-02', active_days: 2, interactions: 0, commits: 4, ai_signature_score: 0.4},
        {week_start: '2026-03-09', active_days: 3, interactions: 0, commits: 6, ai_signature_score: 0.5},
        {week_start: '2026-03-16', active_days: 4, interactions: 0, commits: 9, ai_signature_score: 0.6},
    ],
    annotations: [
        {type: 'first_active_week', week_start: '2026-03-02', label: 'First active week'},
        {type: 'sustained_ramp', week_start: '2026-03-02', label: 'Sustained ramp'},
    ],
    tools: [
        {
            tool: 'copilot',
            started_on: '2026-03-01',
            last_active_on: '2026-05-20',
            current_plan: 'business',
            current_monthly_cost: 19,
            active: true,
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
    ],
};

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify({data: body}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });
}

interface Overrides {
    notFound?: boolean;
}

let fetchMock: Mock;

function installFetch(overrides: Overrides = {}): void {
    fetchMock = vi.fn(async (url: unknown) => {
        const path = new URL(String(url), 'http://localhost').pathname;
        if (overrides.notFound) {
            return new Response(JSON.stringify({error: 'Not Found'}), {status: 404});
        }
        if (path === '/api/developers/dev-1') {
            return jsonResponse(IDENTITY);
        }
        if (path === '/api/developers/dev-1/journey') {
            return jsonResponse(JOURNEY);
        }
        return new Response(JSON.stringify({error: 'not found'}), {status: 404});
    });
    vi.stubGlobal('fetch', fetchMock);
}

function renderPage(): void {
    render(
        <QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
            <ThemeProvider>
                <MemoryRouter initialEntries={['/manager/developers/dev-1']}>
                    <Routes>
                        <Route path="manager/developers/:id" element={<DeveloperDetail />} />
                    </Routes>
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

describe('Manager DeveloperDetail (Task 4.11)', () => {
    it('heads the page with the developer identity and renders the manager-framed journey', async () => {
        renderPage();

        expect(await screen.findByRole('heading', {name: 'Alice Dev'})).toBeInTheDocument();
        expect(screen.getByText('frontend · adoption journey')).toBeInTheDocument();
        // Manager framing — journey/health, explicitly not a ranking.
        expect(screen.getByText(/not a ranking/i)).toBeInTheDocument();
        expect(screen.getByText('Adoption journey')).toBeInTheDocument();
    });

    it('surfaces the tier, trajectory, annotations, and transitions', async () => {
        renderPage();

        // Git-only journey is labelled medium (an estimate), never silently measured.
        expect(await screen.findByText('Medium — git')).toBeInTheDocument();
        expect(screen.getByTestId('journey-trajectory')).toBeInTheDocument();
        const annotations = screen.getByTestId('journey-annotations');
        expect(within(annotations).getByText(/First active week/)).toBeInTheDocument();
        expect(within(annotations).getByText(/Sustained ramp/)).toBeInTheDocument();
        expect(within(screen.getByTestId('journey-timeline')).getByText('Started using Copilot')).toBeInTheDocument();
    });

    it('shows a not-found state for an unknown developer', async () => {
        installFetch({notFound: true});
        renderPage();

        expect(await screen.findByText('Developer not found')).toBeInTheDocument();
    });
});
