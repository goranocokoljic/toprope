// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {AdminReconciliation} from '../pages/admin/AdminReconciliation';
import type {ReconciliationResult} from '../api/types';

let results: ReconciliationResult[];
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

beforeEach(() => {
    results = [
        {
            id: 'r1',
            run_at: '2026-06-15T00:00:00.000Z',
            period: '2026-06',
            result_type: 'expense_no_subscription',
            developer_id: 'dev-3',
            developer_name: 'Carol Dev',
            developer_email: 'carol@test.com',
            team: 'frontend',
            tool: 'cursor',
            expense_amount: 20,
            registry_amount: null,
            details: null,
            status: 'open',
            resolution: null,
            resolved_at: null,
        },
    ];

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (u.includes('/api/admin/reconciliation/run') && method === 'POST') {
            return json({
                data: {
                    period: '2026-06',
                    run_at: '2026-06-15T00:00:00.000Z',
                    tolerance: 1,
                    created: 1,
                    skipped: 0,
                    byType: {expense_no_subscription: 1, subscription_no_expense: 0, cost_discrepancy: 0},
                },
            });
        }
        if (u.includes('/resolve') && method === 'POST') {
            results = results.map((r) =>
                r.id === 'r1' ? {...r, status: 'resolved', resolution: String(body.resolution)} : r,
            );
            return json({data: results[0]});
        }
        if (u.includes('/api/admin/reconciliation') && method === 'GET') {
            // Honor the status filter so the open list empties after resolve.
            const status = new URL(u, 'http://x').searchParams.get('status') ?? 'open';
            const filtered =
                status === 'all' ? results : results.filter((r) => r.status === status);
            return json({data: filtered});
        }
        return json({error: 'not found'}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderPage(node: JSX.Element): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <MemoryRouter>{node}</MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('AdminReconciliation page', () => {
    it('lists open reconciliation results from the API', async () => {
        renderPage(<AdminReconciliation />);
        expect(await screen.findByText('Carol Dev')).toBeInTheDocument();
        expect(screen.getByText('Expense, no subscription')).toBeInTheDocument();
    });

    it('runs reconciliation via POST', async () => {
        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');
        fireEvent.click(screen.getByRole('button', {name: /^run$/i}));
        await waitFor(() => {
            const post = fetchMock.mock.calls.find(
                (c) =>
                    String(c[0]).includes('/api/admin/reconciliation/run') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
            );
            expect(post).toBeTruthy();
        });
    });

    it('resolves a result with a note', async () => {
        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');
        const note = screen.getByPlaceholderText('reason / action');
        fireEvent.change(note, {target: {value: 'registered the seat'}});
        fireEvent.click(screen.getByRole('button', {name: /^resolve$/i}));

        await waitFor(() => {
            const post = fetchMock.mock.calls.find(
                (c) =>
                    String(c[0]).includes('/resolve') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
            );
            expect(post).toBeTruthy();
            const sent = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
            expect(sent.resolution).toBe('registered the seat');
        });
    });
});
