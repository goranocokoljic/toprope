// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {WasteDetection} from '../pages/WasteDetection';
import type {WasteAlert} from '../api/types';

function unusedSeat(): WasteAlert {
    return {
        id: 'w-unused',
        developer_id: 'dev-1',
        developer_name: 'Alice Dev',
        team: 'frontend',
        alert_type: 'unused_seat',
        tool: 'copilot',
        details: {developer_name: 'Alice Dev', inactivity_days: 14, tool: 'copilot'},
        monthly_waste: 19,
        detected_at: '2026-05-01T00:00:00.000Z',
    };
}

function planRoi(): WasteAlert {
    return {
        id: 'w-roi',
        developer_id: 'dev-2',
        developer_name: 'Jane',
        team: 'platform',
        alert_type: 'plan_roi',
        tool: 'claude_code',
        details: {
            developer_name: 'Jane',
            tool: 'claude_code',
            old_plan: 'Pro',
            new_plan: 'Max',
            old_monthly_cost: 20,
            new_monthly_cost: 200,
            cost_delta: 180,
            usage_delta: 2,
            baseline_usage: 24,
            post_change_usage: 26,
            days_since_change: 42,
            note: 'Review suggested — worth confirming the upgrade is delivering value.',
        },
        // plan_roi carries no hard-dollar waste by design.
        monthly_waste: null,
        detected_at: '2026-05-10T00:00:00.000Z',
    };
}

let active: WasteAlert[];
let resolved: WasteAlert[];
let failResolve: boolean;
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

beforeEach(() => {
    active = [unusedSeat(), planRoi()];
    resolved = [];
    failResolve = false;

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();

        // POST /api/waste/:id/resolve — move the alert from active to resolved.
        const resolveMatch = u.match(/\/api\/waste\/([^/]+)\/resolve/);
        if (resolveMatch && method === 'POST') {
            if (failResolve) return json({error: 'boom'}, 500);
            const id = resolveMatch[1];
            const body = init?.body ? (JSON.parse(String(init.body)) as {reason: string}) : {reason: ''};
            const found = active.find((a) => a.id === id);
            if (!found) return json({error: 'not found'}, 404);
            active = active.filter((a) => a.id !== id);
            const moved: WasteAlert = {
                ...found,
                resolved_at: '2026-05-20T00:00:00.000Z',
                resolution: body.reason,
            };
            resolved = [moved, ...resolved];
            return json({data: moved});
        }
        if (u.includes('/api/waste/resolved')) {
            return json({data: resolved});
        }
        // GET /api/waste (paginated active list).
        if (u.includes('/api/waste')) {
            return json({data: active, pagination: {page: 1, limit: 100, total: active.length}});
        }
        return json({error: 'not found'}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderPage(): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <MemoryRouter>
                <WasteDetection />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('WasteDetection page', () => {
    it('shows each waste type with its monthly cost and a review-framed detail', async () => {
        renderPage();
        expect(await screen.findByText('Alice Dev')).toBeInTheDocument();
        // Monthly cost on the alert row.
        expect(screen.getAllByText('$19/mo').length).toBeGreaterThan(0);
        // The unused-seat detail line is present and non-accusatory.
        expect(screen.getByText(/No activity recorded in the last 14\+ days/i)).toBeInTheDocument();
    });

    it('computes total monthly waste and projected annual savings (12x)', async () => {
        renderPage();
        await screen.findByText('Alice Dev');
        // Monthly waste = $19 (plan_roi contributes nothing); annual = $228.
        expect(screen.getByText('$19')).toBeInTheDocument();
        expect(screen.getByText('$228')).toBeInTheDocument();
    });

    it('highlights Plan ROI alerts with before/after plan, cost delta, and usage delta', async () => {
        renderPage();
        await screen.findByText('Jane');
        const roiCard = screen.getByText('Plan ROI review').closest('li') as HTMLElement;
        // Before → after plan and the deltas, all within the highlighted card.
        expect(roiCard).toHaveTextContent('Pro');
        expect(roiCard).toHaveTextContent('Max');
        expect(within(roiCard).getByText('+$180/mo')).toBeInTheDocument();
        expect(within(roiCard).getByText('+2 interactions/day')).toBeInTheDocument();
    });

    it('resolves an alert with a reason and removes it from the active list', async () => {
        renderPage();
        const alice = await screen.findByText('Alice Dev');

        // Open the resolve control on the unused-seat card specifically (the Plan
        // ROI card renders first, so we scope to Alice's <li> rather than [0]).
        const card = alice.closest('li') as HTMLElement;
        fireEvent.click(within(card).getByRole('button', {name: /review.*resolve/i}));

        const select = within(card).getByLabelText('Resolution reason');
        fireEvent.change(select, {target: {value: 'downgrade_recommended'}});
        fireEvent.click(within(card).getByRole('button', {name: /^confirm$/i}));

        // The POST carries the chosen reason.
        await waitFor(() => {
            const post = fetchMock.mock.calls.find(
                (c) =>
                    /\/api\/waste\/w-unused\/resolve/.test(String(c[0])) &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
            );
            expect(post).toBeTruthy();
            const sent = JSON.parse(String(post?.[1]?.body)) as {reason: string};
            expect(sent.reason).toBe('downgrade_recommended');
        });

        // After invalidation the active list refetches without the resolved alert.
        await waitFor(() => expect(screen.queryByText('Alice Dev')).not.toBeInTheDocument());
    });

    it('shows resolved alerts with their reason in the audit trail tab', async () => {
        // Seed one already-resolved alert.
        resolved = [
            {
                ...unusedSeat(),
                id: 'w-old',
                developer_name: 'Bob Dev',
                resolved_at: '2026-05-15T00:00:00.000Z',
                resolution: 'reallocated',
            },
        ];
        renderPage();
        await screen.findByText('Waste Detection');

        fireEvent.click(screen.getByRole('button', {name: 'Resolved'}));

        const card = await screen.findByText('Resolved alerts');
        const section = card.closest('section') as HTMLElement;
        expect(within(section).getByText('Bob Dev')).toBeInTheDocument();
        expect(within(section).getByText('Seat reallocated')).toBeInTheDocument();
    });

    it('shows a positive confirmation when there is no active waste', async () => {
        active = [];
        renderPage();
        expect(await screen.findByText('No active waste detected')).toBeInTheDocument();
    });

    it('keeps the alert in the active list and shows an error when resolve fails', async () => {
        failResolve = true;
        renderPage();
        const alice = await screen.findByText('Alice Dev');
        const card = alice.closest('li') as HTMLElement;
        fireEvent.click(within(card).getByRole('button', {name: /review.*resolve/i}));
        fireEvent.click(within(card).getByRole('button', {name: /^confirm$/i}));

        // The failure surfaces inline and the alert is NOT removed from active.
        expect(await within(card).findByText(/couldn't save/i)).toBeInTheDocument();
        expect(screen.getByText('Alice Dev')).toBeInTheDocument();
    });

    it('rounds a fractional Plan ROI usage delta to one decimal', async () => {
        active = [
            {
                ...planRoi(),
                details: {...planRoi().details, usage_delta: 1.83},
            },
        ];
        renderPage();
        const roiCard = (await screen.findByText('Plan ROI review')).closest('li') as HTMLElement;
        expect(within(roiCard).getByText('+1.8 interactions/day')).toBeInTheDocument();
    });
});
