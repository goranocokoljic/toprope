// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import type {ReactNode} from 'react';

import {classifyDataState, SIGNIFICANCE_DAYS} from '../components/dataState';
import {confidenceTier} from '../components/coverage';
import {EmptyState} from '../components/EmptyState';
import {ErrorState} from '../components/ErrorState';
import {ColdStartPanel} from '../components/ColdStartPanel';
import {PartialCoverage} from '../components/PartialCoverage';
import {ManagerOverview} from '../pages/ManagerOverview';
import {ThemeProvider} from '../theme/ThemeProvider';
import {THEME_STORAGE_KEY} from '../theme/themeContext';
import type {OverviewData} from '../api/types';

afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

// --- classifyDataState: the cold-start vs genuine-empty discriminator -------

describe('classifyDataState', () => {
    it('treats transient states (error, loading) as highest priority', () => {
        expect(classifyDataState({error: new Error('boom'), isLoading: true, connected: true})).toBe('error');
        expect(classifyDataState({isLoading: true, connected: true, dataDays: 30, hasSignal: true})).toBe('loading');
    });

    it('is cold-start when nothing is connected', () => {
        expect(classifyDataState({connected: false})).toBe('cold-start');
    });

    it('is cold-start when connected but below the significance window', () => {
        // Connected, some signal, but only a few days collected — we cannot yet
        // conclude anything, so it must not read as a settled empty.
        expect(classifyDataState({connected: true, dataDays: SIGNIFICANCE_DAYS - 1, hasSignal: false})).toBe(
            'cold-start',
        );
    });

    it('is genuine-empty only once enough days are collected with no signal', () => {
        // The key honesty case: enough history AND zero activity → truly unused.
        expect(classifyDataState({connected: true, dataDays: SIGNIFICANCE_DAYS, hasSignal: false})).toBe('empty');
    });

    it('is ready when connected, past the window, with signal', () => {
        expect(classifyDataState({connected: true, dataDays: 30, hasSignal: true})).toBe('ready');
    });

    it('honors a custom significance window', () => {
        expect(classifyDataState({connected: true, dataDays: 5, hasSignal: false, significanceDays: 3})).toBe('empty');
    });

    it('without a collection window, never claims "empty" — a silent scope is still collecting', () => {
        // No dataDays: we can't prove the significance window elapsed, so a
        // connected-but-silent scope must read as cold-start, not genuine-empty.
        expect(classifyDataState({connected: true, hasSignal: false})).toBe('cold-start');
        expect(classifyDataState({connected: true, hasSignal: true})).toBe('ready');
    });
});

// --- confidenceTier thresholds ---------------------------------------------

describe('confidenceTier', () => {
    it('maps day counts to tiers against the 14-day threshold', () => {
        expect(confidenceTier(0).level).toBe('none');
        expect(confidenceTier(3).level).toBe('low');
        expect(confidenceTier(10).level).toBe('medium');
        expect(confidenceTier(SIGNIFICANCE_DAYS).level).toBe('high');
    });
});

// --- Cold-start vs genuine-empty are distinct ------------------------------

describe('ColdStartPanel vs EmptyState', () => {
    it('render as semantically distinct states', () => {
        const {rerender} = render(<ColdStartPanel collectedDays={4} />);
        const cold = screen.getByTestId('cold-start');
        expect(cold).toBeInTheDocument();
        // Cold-start is explicit that collection is in progress.
        expect(cold).toHaveTextContent(/Collecting your data/i);
        expect(cold).toHaveTextContent(/4 of 14 days collected/i);
        expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();

        rerender(<EmptyState message="This seat has no activity." />);
        const empty = screen.getByTestId('empty-state');
        expect(empty).toBeInTheDocument();
        // No "collecting"/"in progress" language — it's a settled fact.
        expect(empty).not.toHaveTextContent(/collecting/i);
        expect(screen.queryByTestId('cold-start')).not.toBeInTheDocument();
    });

    it('cold-start shows connectors and a setup checklist', () => {
        render(
            <ColdStartPanel
                connectors={[
                    {name: 'copilot', connected: true},
                    {name: 'windsurf', connected: false},
                ]}
                checklist={[
                    {label: 'Connect a tool', done: true},
                    {label: 'First sync collected', done: false},
                ]}
            />,
        );
        expect(screen.getByTestId('cold-start-connectors')).toHaveTextContent('copilot');
        expect(screen.getByTestId('cold-start-connectors')).toHaveTextContent('windsurf');
        const checklist = screen.getByTestId('cold-start-checklist');
        expect(checklist).toHaveTextContent('Connect a tool');
        expect(checklist).toHaveTextContent('First sync collected');
    });

    it('does not claim to be "collecting" when nothing is connected yet', () => {
        const {rerender} = render(
            <ColdStartPanel connectors={[{name: 'copilot', connected: false}]} />,
        );
        expect(screen.getByTestId('cold-start')).toHaveTextContent(/Connect a tool to get started/i);
        expect(screen.getByTestId('cold-start')).not.toHaveTextContent(/Collecting/i);

        // Once a connector is wired, it switches to the collecting framing.
        rerender(<ColdStartPanel connectors={[{name: 'copilot', connected: true}]} />);
        expect(screen.getByTestId('cold-start')).toHaveTextContent(/Collecting your data/i);
    });
});

// --- ErrorState: non-alarming, with a suggested action ----------------------

describe('ErrorState', () => {
    it('is an alert with a suggestion and an optional retry', () => {
        const onRetry = vi.fn();
        render(<ErrorState detail="HTTP 500" onRetry={onRetry} />);
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent(/usually temporary/i);
        expect(alert).toHaveTextContent('HTTP 500');
        fireEvent.click(screen.getByRole('button', {name: /try again/i}));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('omits the retry button when no handler is given', () => {
        render(<ErrorState detail="offline" />);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
});

// --- PartialCoverage: honest full-vs-thin split -----------------------------

describe('PartialCoverage', () => {
    it('summarizes how many scopes have full data and lists thin ones first', () => {
        render(
            <PartialCoverage
                scopes={[
                    {name: 'alice', dataDays: 30},
                    {name: 'bob', dataDays: 2},
                    {name: 'carol', dataDays: 20},
                ]}
            />,
        );
        const panel = screen.getByTestId('partial-coverage');
        // 2 of 3 are high-confidence (>= 14 days); bob is thin.
        expect(panel).toHaveTextContent('2 of 3');
        expect(panel).toHaveTextContent('1 still building');
        // Thin-first ordering: bob (2 days) appears before the others.
        const names = Array.from(panel.querySelectorAll('li')).map((li) => li.textContent ?? '');
        expect(names[0]).toContain('bob');
    });
});

// --- Light / dark rendering -------------------------------------------------

describe('data states render in light and dark mode', () => {
    function renderInTheme(node: ReactNode, theme: 'light' | 'dark'): void {
        if (theme === 'dark') {
            window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
        }
        render(<ThemeProvider>{node}</ThemeProvider>);
    }

    it('mount without crashing in both themes', () => {
        renderInTheme(<ColdStartPanel collectedDays={1} />, 'light');
        expect(screen.getByTestId('cold-start')).toBeInTheDocument();
        cleanup();

        renderInTheme(<ErrorState detail="x" onRetry={() => undefined} />, 'dark');
        expect(screen.getByTestId('error-state')).toBeInTheDocument();
        expect(document.documentElement).toHaveClass('dark');
    });
});

// --- ManagerOverview wiring: loading / error / cold-start -------------------

const READY_OVERVIEW: OverviewData = {
    total_developers: 20,
    active_developers: 12,
    total_subscriptions: 18,
    total_monthly_cost: 1234,
    active_tools: ['copilot'],
    data_quality_distribution: {high: 8, medium: 5, low: 4, none: 3},
    active_waste_alert_count: 3,
    total_monthly_waste: 177,
};

// Connected (devs registered, a tool active) but nothing collected yet.
const COLD_OVERVIEW: OverviewData = {
    ...READY_OVERVIEW,
    active_developers: 0,
    data_quality_distribution: {high: 0, medium: 0, low: 0, none: 20},
};

describe('ManagerOverview data states', () => {
    let fetchMock: Mock;

    function renderPage(): void {
        const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
        // The ready state renders charts (need ThemeProvider) and quick-link
        // <Link>s (need a Router), so wrap with both.
        render(
            <QueryClientProvider client={client}>
                <ThemeProvider>
                    <MemoryRouter>
                        <ManagerOverview />
                    </MemoryRouter>
                </ThemeProvider>
            </QueryClientProvider>,
        );
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shows loading skeletons before data arrives', () => {
        fetchMock = vi.fn(() => new Promise(() => undefined)); // never resolves
        vi.stubGlobal('fetch', fetchMock);
        renderPage();
        expect(screen.getAllByRole('status', {name: 'Loading'}).length).toBeGreaterThan(0);
        expect(screen.getByRole('status', {name: 'Loading chart'})).toBeInTheDocument();
    });

    it('shows a non-alarming error state with retry when the API fails', async () => {
        fetchMock = vi.fn(async () => new Response('nope', {status: 500}));
        vi.stubGlobal('fetch', fetchMock);
        renderPage();
        expect(await screen.findByText('Failed to load overview')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: /try again/i})).toBeInTheDocument();
    });

    it('shows the cold-start panel when connected but no data is collected yet', async () => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({data: COLD_OVERVIEW}), {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        renderPage();
        expect(await screen.findByTestId('cold-start')).toBeInTheDocument();
        // The hollow stat grid must NOT be shown alongside cold-start.
        expect(screen.queryByText('Monthly spend')).not.toBeInTheDocument();
    });

    it('marks an actively-syncing connector as connected using the backend tool id', async () => {
        // The backend writes the Claude Code tool string as 'claude_code'
        // (underscore). The connector chip must reflect that as connected, not
        // mislabel it as unconnected.
        const overview: OverviewData = {...COLD_OVERVIEW, active_tools: ['claude_code']};
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({data: overview}), {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        renderPage();
        const connectors = await screen.findByTestId('cold-start-connectors');
        const claude = within(connectors).getByText('Claude Code').closest('span');
        expect(claude).toHaveTextContent(/connected/i);
        expect(claude).not.toHaveTextContent(/not connected/i);
    });

    it('shows the normal stat grid once data has been collected', async () => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({data: READY_OVERVIEW}), {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        renderPage();
        expect(await screen.findByText('12 / 20')).toBeInTheDocument();
        expect(screen.queryByTestId('cold-start')).not.toBeInTheDocument();
    });
});
