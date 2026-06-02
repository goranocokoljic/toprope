// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, render, screen, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {MyTools} from '../pages/MyTools';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {MeJourney, MeTools, UserPreferences} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const TOOLS: MeTools = {
    range: '30d',
    from: '2026-05-03',
    to: '2026-06-02',
    tools: [
        {
            tool: 'copilot',
            active_days: 18,
            interactions: 1280,
            acceptances: 512,
            acceptance_rate: 0.4,
            // Heavily skewed to one feature — the under-utilization case.
            feature_usage: [
                {feature: 'completions', count: 1200},
                {feature: 'chat', count: 80},
            ],
            activity: [
                {date: '2026-05-30', interactions: 40},
                {date: '2026-05-31', interactions: 55},
                {date: '2026-06-01', interactions: 60},
            ],
            estimated_monthly_cost: 19,
        },
        {
            tool: 'windsurf',
            active_days: 3,
            interactions: 30,
            acceptances: 12,
            acceptance_rate: 0.4,
            feature_usage: [],
            activity: [{date: '2026-06-01', interactions: 30}],
            estimated_monthly_cost: 0,
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
        {
            tool: 'windsurf',
            started_on: '2026-04-01',
            last_active_on: '2026-04-20',
            current_plan: null,
            current_monthly_cost: null,
            active: false,
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
    tools?: MeTools;
    journey?: MeJourney;
    failTools?: boolean;
}

let fetchMock: Mock;

function installFetch(overrides: Overrides = {}): void {
    fetchMock = vi.fn(async (url: unknown) => {
        const path = new URL(String(url), 'http://localhost').pathname;
        switch (path) {
            case '/api/me/tools':
                if (overrides.failTools) {
                    return new Response('nope', {status: 500});
                }
                return jsonResponse(overrides.tools ?? TOOLS);
            case '/api/me/journey':
                return jsonResponse(overrides.journey ?? JOURNEY);
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
                    <MyTools />
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

describe('MyTools — per-tool detail', () => {
    it('renders a card per tool with stats, plan, and cost', async () => {
        renderPage();

        expect(await screen.findByText('Copilot')).toBeInTheDocument();
        expect(screen.getByText('Windsurf')).toBeInTheDocument();
        // Active subscription plan badge.
        expect(screen.getByText('business')).toBeInTheDocument();
        // Per-tool cost.
        expect(screen.getByText('$19')).toBeInTheDocument();
        // Acceptance rate rendered as a percentage.
        expect(screen.getAllByText('40%').length).toBeGreaterThan(0);
    });

    it('shows the per-feature usage breakdown with plain-language labels', async () => {
        renderPage();

        const breakdowns = await screen.findAllByTestId('feature-breakdown');
        const copilot = breakdowns[0];
        // Raw keys map to human labels (completions → Autocomplete).
        expect(within(copilot).getByText('Autocomplete')).toBeInTheDocument();
        expect(within(copilot).getByText('Chat')).toBeInTheDocument();
        expect(within(copilot).getByText('1,200')).toBeInTheDocument();
    });

    it('surfaces a gentle utilization note when a paid tool is used for one feature', async () => {
        renderPage();
        const note = await screen.findByTestId('utilization-note');
        expect(note).toHaveTextContent(/Most of your Copilot usage is Autocomplete/i);
    });

    it('shows an empty-feature note for a tool with no feature data', async () => {
        renderPage();
        // Windsurf has no feature data in the fixture.
        expect(await screen.findByTestId('feature-empty')).toBeInTheDocument();
    });

    it('never renders a competitive ranking or peer comparison', async () => {
        renderPage();
        await screen.findByText('Copilot');
        expect(screen.queryByText(/rank/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/leaderboard/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/vs\.? (your )?team/i)).not.toBeInTheDocument();
    });
});

describe('MyTools — empty & error states', () => {
    it('shows an empty state when no tools are tracked', async () => {
        installFetch({tools: {...TOOLS, tools: []}});
        renderPage();
        expect(await screen.findByTestId('my-tools-empty')).toBeInTheDocument();
        expect(screen.getByText('No tool activity yet')).toBeInTheDocument();
    });

    it('shows an error state with retry when the tools query fails', async () => {
        installFetch({failTools: true});
        renderPage();
        expect(await screen.findByText('Failed to load your tools')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Try again'})).toBeInTheDocument();
    });
});
