// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {App} from '../App';
import {Header} from '../components/Header';
import {useOverview} from '../hooks/useOverview';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {OverviewData} from '../api/types';

const OVERVIEW: OverviewData = {
    total_developers: 20,
    active_developers: 12,
    total_subscriptions: 18,
    total_monthly_cost: 1234,
    active_tools: ['copilot'],
    data_quality_distribution: {high: 8, medium: 5, low: 4, none: 3},
    active_waste_alert_count: 3,
    total_monthly_waste: 177,
};

let fetchMock: Mock;

function overviewCallCount(): number {
    return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/overview')).length;
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

beforeEach(() => {
    fetchMock = vi.fn(
        async () =>
            new Response(JSON.stringify({data: OVERVIEW}), {
                status: 200,
                headers: {'Content-Type': 'application/json'},
            }),
    );
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

describe('dashboard smoke', () => {
    it('loads, calls /api/overview, and renders the fetched result', async () => {
        render(
            <QueryClientProvider client={makeClient()}>
                <ThemeProvider>
                    <MemoryRouter initialEntries={['/manager']}>
                        <App />
                    </MemoryRouter>
                </ThemeProvider>
            </QueryClientProvider>,
        );

        // Value derived from the fetched payload (active / total developers).
        expect(await screen.findByText('12 / 20')).toBeInTheDocument();
        // Sample chart renders with the fetched data.
        expect(screen.getByTestId('data-quality-chart')).toBeInTheDocument();
        expect(overviewCallCount()).toBe(1);
    });

    it('caches the overview query across consumers (no duplicate requests)', async () => {
        const client = makeClient();
        function Probe(): JSX.Element {
            const {data} = useOverview();
            return <span>{data ? String(data.total_developers) : 'loading'}</span>;
        }

        render(
            <QueryClientProvider client={client}>
                <Probe />
                <Probe />
            </QueryClientProvider>,
        );

        await waitFor(() => expect(screen.getAllByText('20').length).toBe(2));
        // Two consumers, one shared cache entry → exactly one network request.
        expect(overviewCallCount()).toBe(1);
    });

    it('toggles dark mode programmatically via the theme control', () => {
        render(
            <ThemeProvider>
                <Header />
            </ThemeProvider>,
        );

        expect(document.documentElement.classList.contains('dark')).toBe(false);
        fireEvent.click(screen.getByRole('button', {name: /mode/i}));
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
});
