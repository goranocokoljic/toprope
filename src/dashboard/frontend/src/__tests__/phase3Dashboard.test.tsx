// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {MaturityTrendCard} from '../components/MaturityTrendCard';
import {SummariesPanel} from '../components/SummariesPanel';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {MaturityTrend, SummaryDetail, SummaryListItem, UserPreferences} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const PREFERENCES: UserPreferences = {default_time_range: '30d', dark_mode: false};

const ORG_TREND: MaturityTrend = {
    team: 'org',
    range: '30d',
    from: '2026-01-01',
    to: '2026-06-30',
    points: [
        {period: '2026-Q1', start: '2026-01-01', end: '2026-03-31', score: 48, basis: 'git_estimate', score_delta: null},
        {period: '2026-Q2', start: '2026-04-01', end: '2026-06-30', score: 61, basis: 'git_estimate', score_delta: 13},
    ],
};

const WEEKLY: SummaryListItem = {
    id: 'summary:org:org:weekly:2026-W22',
    scope: 'org',
    scope_name: 'org',
    period_type: 'weekly',
    period_value: '2026-W22',
    model_used: 'local-large',
    generated_at: '2026-06-01T08:00:00.000Z',
    regenerated_count: 0,
    is_stale: 0,
    basis: 'git_estimate',
    tier: 'medium',
    data_basis: 'git analysis + expense data; no direct tool usage',
};

const MONTHLY: SummaryListItem = {
    ...WEEKLY,
    id: 'summary:org:org:monthly:2026-05',
    period_type: 'monthly',
    period_value: '2026-05',
    generated_at: '2026-06-01T09:00:00.000Z',
    is_stale: 1, // stale: underlying data changed
};

const SUMMARIES: SummaryListItem[] = [MONTHLY, WEEKLY];

function detailFor(item: SummaryListItem, text: string): SummaryDetail {
    return {...item, summary_text: text, input_hash: 'h'};
}

// --- Route-aware fetch mock ------------------------------------------------

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify({data: body}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });
}

let fetchMock: Mock;
let lastRegenerateBody: unknown;
let lastGenerateBody: unknown;

function installFetch(): void {
    lastRegenerateBody = undefined;
    lastGenerateBody = undefined;
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = new URL(String(url), 'http://localhost');
        const path = u.pathname;
        const method = init?.method ?? 'GET';

        if (path === '/api/me/preferences') return jsonResponse(PREFERENCES);
        if (path === '/api/maturity/org/trend') return jsonResponse(ORG_TREND);
        if (path === '/api/summaries' && method === 'GET') return jsonResponse(SUMMARIES);

        if (path === '/api/summaries/generate' && method === 'POST') {
            lastGenerateBody = JSON.parse(String(init?.body));
            return jsonResponse(
                detailFor(
                    {...WEEKLY, id: 'summary:org:org:quarterly:2026-Q2', period_type: 'quarterly', period_value: '2026-Q2'},
                    'Fresh quarterly narrative.',
                ),
            );
        }
        // /api/summaries/:id and /api/summaries/:id/regenerate
        const regen = /^\/api\/summaries\/([^/]+)\/regenerate$/.exec(path);
        if (regen && method === 'POST') {
            lastRegenerateBody = init?.body ? JSON.parse(String(init.body)) : {};
            const id = decodeURIComponent(regen[1]);
            const base = SUMMARIES.find((s) => s.id === id) ?? WEEKLY;
            return jsonResponse(detailFor({...base, is_stale: 0, regenerated_count: 1}, 'Regenerated narrative text.'));
        }
        const detail = /^\/api\/summaries\/([^/]+)$/.exec(path);
        if (detail && method === 'GET') {
            const id = decodeURIComponent(detail[1]);
            const base = SUMMARIES.find((s) => s.id === id) ?? WEEKLY;
            return jsonResponse(detailFor(base, `Full text for ${base.period_value}.`));
        }

        return new Response(JSON.stringify({error: 'not found'}), {status: 404});
    });
    vi.stubGlobal('fetch', fetchMock);
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

function renderWithProviders(node: JSX.Element): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter>{node}</MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function maturityCalls(): string[] {
    return fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => new URL(u, 'http://localhost').pathname === '/api/maturity/org/trend');
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

// --- Maturity trend --------------------------------------------------------

describe('MaturityTrendCard', () => {
    it('renders the chart with git-based-estimate and MEDIUM confidence labels', async () => {
        renderWithProviders(<MaturityTrendCard scope="org" title="AI maturity trend" subtitle="Org-wide." />);

        expect(await screen.findByTestId('maturity-trend-chart')).toBeInTheDocument();
        expect(screen.getByText('Git-based estimate')).toBeInTheDocument();
        expect(screen.getByText('MEDIUM confidence')).toBeInTheDocument();
    });

    it('refetches when the time range changes', async () => {
        renderWithProviders(<MaturityTrendCard scope="org" title="AI maturity trend" subtitle="Org-wide." />);

        await waitFor(() => expect(maturityCalls().some((u) => u.includes('range=30d'))).toBe(true));
        fireEvent.click(screen.getByRole('button', {name: '90d'}));
        await waitFor(() => expect(maturityCalls().some((u) => u.includes('range=90d'))).toBe(true));
    });
});

// --- Summaries panel -------------------------------------------------------

describe('SummariesPanel (org, full)', () => {
    it('surfaces the latest weekly + monthly and flags a stale summary', async () => {
        renderWithProviders(<SummariesPanel scope="org" />);

        // Latest weekly + monthly headings appear (prominent + history → use getAllByText).
        expect((await screen.findAllByText('Weekly · 2026-W22')).length).toBeGreaterThan(0);
        expect(screen.getAllByText('Monthly · 2026-05').length).toBeGreaterThan(0);
        // The monthly summary is stale and must carry the actionable badge.
        expect(screen.getAllByText('Underlying data changed — regenerate').length).toBeGreaterThan(0);
    });

    it('shows full narrative text for the prominent (expanded) summaries', async () => {
        renderWithProviders(<SummariesPanel scope="org" />);

        // Prominent cards mount expanded, so their detail text loads without a click.
        expect(await screen.findByText('Full text for 2026-W22.')).toBeInTheDocument();
        expect(screen.getByText('Full text for 2026-05.')).toBeInTheDocument();
    });

    it('regenerates a summary with an optional focus and updates the text', async () => {
        renderWithProviders(<SummariesPanel scope="org" />);

        await screen.findByText('Full text for 2026-W22.');
        // The first expanded prominent card is the weekly one.
        const input = screen.getAllByPlaceholderText('e.g. focus on cost efficiency')[0];
        fireEvent.change(input, {target: {value: 'focus on cost'}});
        fireEvent.click(screen.getAllByRole('button', {name: 'Regenerate'})[0]);

        await waitFor(() => expect(lastRegenerateBody).toEqual({focus: 'focus on cost'}));
        expect(await screen.findByText('Regenerated narrative text.')).toBeInTheDocument();
    });

    it('generates a quarterly report on demand', async () => {
        renderWithProviders(<SummariesPanel scope="org" />);

        await screen.findByText('Generate a report on demand');
        fireEvent.change(screen.getByLabelText('Period'), {target: {value: '2026-Q2'}});
        fireEvent.click(screen.getByRole('button', {name: 'Generate'}));

        await waitFor(() =>
            expect(lastGenerateBody).toEqual({level: 'quarterly', period: '2026-Q2', scope: 'org'}),
        );
        expect(await screen.findByText(/Generated Quarterly · 2026-Q2/)).toBeInTheDocument();
    });
});

describe('SummariesPanel (team, compact)', () => {
    it('shows only the single latest summary for the team', async () => {
        renderWithProviders(<SummariesPanel scope="team:backend" compact />);

        const card = await screen.findByTestId('summary-card');
        // Newest first → the monthly summary leads the list.
        expect(within(card).getByText('Monthly · 2026-05')).toBeInTheDocument();
        // Compact mode shows no on-demand generation form.
        expect(screen.queryByText('Generate a report on demand')).not.toBeInTheDocument();
        // The team scope token must reach the API (not just rely on the mock).
        const summaryCall = fetchMock.mock.calls
            .map((c) => new URL(String(c[0]), 'http://localhost'))
            .find((u) => u.pathname === '/api/summaries');
        expect(summaryCall?.searchParams.get('scope')).toBe('team:backend');
    });
});
