// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {act, cleanup, fireEvent, render, renderHook, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';

import {navSectionsForRole} from '../components/navConfig';
import {CoverageBadge} from '../components/CoverageBadge';
import {TrendIndicator} from '../components/TrendIndicator';
import {Sparkline} from '../components/Sparkline';
import {StatCard} from '../components/StatCard';
import {DataTable, type Column} from '../components/DataTable';
import {TimeRangeSelector} from '../components/TimeRangeSelector';
import {Skeleton, SkeletonStatCard} from '../components/Skeleton';
import {TrendChart} from '../charts/TrendChart';
import {ComparisonChart} from '../charts/ComparisonChart';
import {DistributionChart} from '../charts/DistributionChart';
import {useChartTheme} from '../charts/chartTheme';
import {useTimeRange} from '../hooks/useTimeRange';
import {presetValue, type TimeRangeValue} from '../timeRange/range';
import {ThemeProvider} from '../theme/ThemeProvider';
import {THEME_STORAGE_KEY} from '../theme/themeContext';
import type {UserPreferences} from '../api/types';

const NOW = new Date('2026-05-31T00:00:00.000Z');

afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

// --- Role-aware navigation -------------------------------------------------

describe('navSectionsForRole', () => {
    it('gives admins the manager + admin areas', () => {
        const titles = navSectionsForRole('admin').map((s) => s.title);
        expect(titles).toEqual(['Manager', 'Admin', 'Account']);
    });

    it('gives developers only the developer area (no admin/manager)', () => {
        const titles = navSectionsForRole('developer').map((s) => s.title);
        expect(titles).toEqual(['Developer', 'Account']);
        expect(titles).not.toContain('Admin');
        expect(titles).not.toContain('Manager');
    });

    it('falls back to both non-admin areas when the role is unknown', () => {
        const titles = navSectionsForRole(undefined).map((s) => s.title);
        expect(titles).toEqual(['Manager', 'Developer', 'Account']);
        expect(titles).not.toContain('Admin');
    });
});

// --- Coverage badge --------------------------------------------------------

describe('CoverageBadge', () => {
    it('reflects the data-day count and confidence tier', () => {
        const {rerender} = render(<CoverageBadge dataDays={20} />);
        expect(screen.getByText('20 days of data')).toBeInTheDocument();
        expect(screen.getByTitle('High confidence')).toBeInTheDocument();

        rerender(<CoverageBadge dataDays={1} />);
        expect(screen.getByText('1 day of data')).toBeInTheDocument();
        expect(screen.getByTitle('Low confidence')).toBeInTheDocument();

        rerender(<CoverageBadge dataDays={0} />);
        expect(screen.getByText('0 days of data')).toBeInTheDocument();
        expect(screen.getByTitle('No data')).toBeInTheDocument();
    });

    it('shows coverage out of the window span when given', () => {
        render(<CoverageBadge dataDays={9} spanDays={30} />);
        expect(screen.getByText('9 of 30 days')).toBeInTheDocument();
        expect(screen.getByTitle('Medium confidence')).toBeInTheDocument();
    });
});

// --- Trend indicator -------------------------------------------------------

describe('TrendIndicator', () => {
    it('colors a rise green and a fall red when up is good', () => {
        const {rerender} = render(<TrendIndicator value={5} suffix="%" />);
        const up = screen.getByLabelText('Up 5%');
        expect(up).toHaveClass('text-success');
        expect(up).toHaveAttribute('data-trend', 'up');

        rerender(<TrendIndicator value={-3} suffix="%" />);
        expect(screen.getByLabelText('Down 3%')).toHaveClass('text-danger');
    });

    it('inverts the color when down is good (e.g. cost/waste)', () => {
        render(<TrendIndicator value={-4} goodWhen="down" />);
        expect(screen.getByLabelText('Down 4')).toHaveClass('text-success');
    });

    it('renders a neutral flat state at zero', () => {
        render(<TrendIndicator value={0} />);
        const flat = screen.getByText('0');
        expect(flat).toHaveClass('text-muted');
        expect(flat).toHaveAttribute('data-trend', 'flat');
    });
});

// --- Sparkline -------------------------------------------------------------

describe('Sparkline', () => {
    it('renders an svg polyline for a series', () => {
        render(<Sparkline data={[1, 5, 2, 8, 4]} />);
        expect(screen.getByTestId('sparkline')).toBeInTheDocument();
    });

    it('renders nothing with fewer than two points', () => {
        const {container} = render(<Sparkline data={[1]} />);
        expect(container.querySelector('svg')).toBeNull();
    });
});

// --- StatCard --------------------------------------------------------------

describe('StatCard', () => {
    it('renders the value, trend, and sparkline together', () => {
        render(
            <StatCard
                label="Monthly waste"
                value="$1,200"
                hint="3 alerts"
                trend={{value: -150, goodWhen: 'down'}}
                sparkline={[10, 8, 6, 4]}
            />,
        );
        expect(screen.getByText('$1,200')).toBeInTheDocument();
        expect(screen.getByText('3 alerts')).toBeInTheDocument();
        expect(screen.getByLabelText('Down 150')).toHaveClass('text-success');
        expect(screen.getByTestId('sparkline')).toBeInTheDocument();
    });
});

// --- Skeletons -------------------------------------------------------------

describe('Skeletons', () => {
    it('render pulse placeholders', () => {
        render(<Skeleton className="h-4 w-10" />);
        expect(screen.getByTestId('skeleton')).toHaveClass('animate-pulse');
    });

    it('compose a stat-card placeholder', () => {
        render(<SkeletonStatCard />);
        expect(screen.getByRole('status', {name: 'Loading'})).toBeInTheDocument();
    });
});

// --- DataTable -------------------------------------------------------------

interface Row {
    name: string;
    cost: number;
}

const ROWS: Row[] = [
    {name: 'frontend', cost: 30},
    {name: 'backend', cost: 10},
    {name: 'platform', cost: 20},
];

const COLUMNS: Column<Row>[] = [
    {key: 'name', header: 'Team', accessor: (r) => r.name},
    {key: 'cost', header: 'Cost', accessor: (r) => r.cost, align: 'right'},
];

function bodyOrder(): string[] {
    return Array.from(document.querySelectorAll('tbody tr td:first-child')).map((td) => td.textContent ?? '');
}

describe('DataTable', () => {
    it('renders rows and sorts ascending/descending on header click', () => {
        render(<DataTable columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.name} />);
        // Unsorted: original order.
        expect(bodyOrder()).toEqual(['frontend', 'backend', 'platform']);

        const costHeader = screen.getByRole('button', {name: /Cost/});
        fireEvent.click(costHeader); // asc by cost: 10,20,30 → backend, platform, frontend
        expect(bodyOrder()).toEqual(['backend', 'platform', 'frontend']);

        fireEvent.click(costHeader); // desc by cost
        expect(bodyOrder()).toEqual(['frontend', 'platform', 'backend']);
    });

    it('does not mutate the caller rows array when sorting', () => {
        const rows = [...ROWS];
        render(<DataTable columns={COLUMNS} rows={rows} getRowKey={(r) => r.name} />);
        fireEvent.click(screen.getByRole('button', {name: /Cost/}));
        expect(rows).toEqual(ROWS);
    });

    it('shows an empty message when there are no rows', () => {
        render(<DataTable columns={COLUMNS} rows={[]} getRowKey={(r) => r.name} emptyMessage="Nothing here" />);
        expect(screen.getByText('Nothing here')).toBeInTheDocument();
    });
});

// --- TimeRangeSelector -----------------------------------------------------

describe('TimeRangeSelector', () => {
    it('emits a resolved window when a preset is chosen', () => {
        const onChange = vi.fn();
        const value = presetValue('30d', {now: NOW});
        render(<TimeRangeSelector value={value} onChange={onChange} now={NOW} />);

        fireEvent.click(screen.getByRole('button', {name: '90d'}));
        expect(onChange).toHaveBeenCalledTimes(1);
        const arg = onChange.mock.calls[0][0] as TimeRangeValue;
        expect(arg.kind).toBe('90d');
        expect(arg.to).toBe('2026-05-31');
    });

    it('validates that a custom range has from <= to and only emits when valid', () => {
        const onChange = vi.fn();
        render(<TimeRangeSelector value={presetValue('30d', {now: NOW})} onChange={onChange} now={NOW} />);

        fireEvent.click(screen.getByRole('button', {name: 'Custom'}));
        fireEvent.change(screen.getByLabelText('From date'), {target: {value: '2026-05-10'}});
        fireEvent.change(screen.getByLabelText('To date'), {target: {value: '2026-05-01'}});

        // Inverted range: error shown, no custom value emitted.
        expect(screen.getByRole('alert')).toHaveTextContent(/on or before/i);
        expect(onChange.mock.calls.every((c) => (c[0] as TimeRangeValue).kind !== 'custom')).toBe(true);

        // Fix the end date → now valid → emits the custom window.
        fireEvent.change(screen.getByLabelText('To date'), {target: {value: '2026-05-20'}});
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as TimeRangeValue;
        expect(last).toEqual({kind: 'custom', from: '2026-05-10', to: '2026-05-20'});
    });
});

// --- Chart wrappers --------------------------------------------------------

const TREND_DATA = [
    {date: '2026-05-01', a: 3, b: 1},
    {date: '2026-05-02', a: 5, b: 2},
];

describe('chart wrappers', () => {
    function renderInTheme(node: ReactNode, theme: 'light' | 'dark'): void {
        if (theme === 'dark') {
            window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
        }
        render(<ThemeProvider>{node}</ThemeProvider>);
    }

    it('TrendChart mounts in light and dark mode', () => {
        renderInTheme(<TrendChart data={TREND_DATA} xKey="date" series={[{key: 'a'}, {key: 'b'}]} />, 'light');
        expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
        cleanup();
        renderInTheme(<TrendChart data={TREND_DATA} xKey="date" series={[{key: 'a'}]} variant="area" />, 'dark');
        expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
        expect(document.documentElement).toHaveClass('dark');
    });

    it('ComparisonChart and DistributionChart render with data', () => {
        renderInTheme(
            <ComparisonChart
                data={[{team: 'a', n: 3}, {team: 'b', n: 5}]}
                categoryKey="team"
                series={[{key: 'n'}]}
            />,
            'light',
        );
        expect(screen.getByTestId('comparison-chart')).toBeInTheDocument();
        cleanup();
        renderInTheme(
            <DistributionChart data={[{label: 'copilot', value: 6}, {label: 'claude', value: 4}]} />,
            'light',
        );
        expect(screen.getByTestId('distribution-chart')).toBeInTheDocument();
        // Legend lists each non-zero slice.
        expect(screen.getByTestId('distribution-legend')).toHaveTextContent('copilot');
    });

    it('shows an empty state when there is no data', () => {
        renderInTheme(<TrendChart data={[]} xKey="date" series={[{key: 'a'}]} emptyMessage="Nothing" />, 'light');
        expect(screen.getByTestId('chart-empty')).toHaveTextContent('Nothing');
    });
});

describe('useChartTheme', () => {
    it('resolves a different accent for light vs dark', () => {
        function Probe(): JSX.Element {
            return <span data-testid="accent">{useChartTheme().accent}</span>;
        }
        render(
            <ThemeProvider>
                <Probe />
            </ThemeProvider>,
        );
        const light = screen.getByTestId('accent').textContent;
        cleanup();
        window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
        render(
            <ThemeProvider>
                <Probe />
            </ThemeProvider>,
        );
        const dark = screen.getByTestId('accent').textContent;
        expect(light).not.toBe(dark);
    });
});

// --- useTimeRange (persistence + smart default) ----------------------------

describe('useTimeRange', () => {
    let prefs: UserPreferences;
    let fetchMock: Mock;

    function wrapper({children}: {children: ReactNode}): JSX.Element {
        const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
        return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }

    beforeEach(() => {
        prefs = {default_time_range: '30d', dark_mode: false};
        fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (u.includes('/api/me/preferences')) {
                if (method === 'PATCH' && init?.body) {
                    prefs = {...prefs, ...(JSON.parse(String(init.body)) as Partial<UserPreferences>)};
                }
                return new Response(JSON.stringify({data: prefs}), {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                });
            }
            return new Response(JSON.stringify({error: 'not found'}), {status: 404});
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('adopts an explicit remembered preset once preferences load', async () => {
        prefs = {default_time_range: 'lifetime', dark_mode: false};
        const {result} = renderHook(() => useTimeRange({earliest: '2026-01-15', now: NOW}), {wrapper});
        await waitFor(() => expect(result.current.range.kind).toBe('lifetime'));
        expect(result.current.range.from).toBe('2026-01-15');
    });

    it('applies the smart default when the stored value is the registry default', async () => {
        prefs = {default_time_range: '30d', dark_mode: false}; // default == "no explicit choice"
        const {result} = renderHook(() => useTimeRange({earliest: '2024-01-01', now: NOW}), {wrapper});
        // History older than a year → smart default is lifetime, not the stored 30d.
        await waitFor(() => expect(result.current.range.kind).toBe('lifetime'));
    });

    it('persists a preset choice to preferences and ignores custom ranges', async () => {
        const {result} = renderHook(() => useTimeRange({now: NOW}), {wrapper});
        await waitFor(() => expect(result.current.isPending).toBe(false));

        act(() => result.current.setRange(presetValue('90d', {now: NOW})));
        await waitFor(() => {
            const patched = fetchMock.mock.calls.some(
                (c) =>
                    String(c[0]).includes('/api/me/preferences') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH' &&
                    JSON.parse(String(c[1]?.body)).default_time_range === '90d',
            );
            expect(patched).toBe(true);
        });
        expect(result.current.range.kind).toBe('90d');

        const patchesBefore = fetchMock.mock.calls.filter(
            (c) => (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
        ).length;
        act(() => result.current.setRange({kind: 'custom', from: '2026-05-01', to: '2026-05-10'}));
        const patchesAfter = fetchMock.mock.calls.filter(
            (c) => (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
        ).length;
        // Custom is session-local: no new PATCH.
        expect(patchesAfter).toBe(patchesBefore);
        expect(result.current.range.kind).toBe('custom');
    });
});
