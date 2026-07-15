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

/** Open the run dialog from the header's primary affordance. */
function openRunModal(): void {
    fireEvent.click(screen.getByRole('button', {name: 'Run reconciliation'}));
    expect(screen.getByRole('dialog', {name: 'Run reconciliation'})).toBeInTheDocument();
}

/** The body of the run POST the dialog fired, or undefined if it never fired. */
function runBody(): Record<string, unknown> | undefined {
    const call = fetchMock.mock.calls.find(
        (c) =>
            String(c[0]).includes('/api/admin/reconciliation/run') &&
            (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
    ) as [unknown, RequestInit | undefined] | undefined;
    if (!call) return undefined;
    return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

describe('AdminReconciliation page', () => {
    it('lists open reconciliation results from the API', async () => {
        renderPage(<AdminReconciliation />);
        expect(await screen.findByText('Carol Dev')).toBeInTheDocument();
        expect(screen.getByText('Expense, no subscription')).toBeInTheDocument();
    });

    it('paginates results at 25 per page and resets to page 1 when the status filter changes', async () => {
        results = Array.from({length: 30}, (_, i) => ({
            id: `r-${String(i).padStart(2, '0')}`,
            run_at: '2026-06-15T00:00:00.000Z',
            period: '2026-06',
            result_type: 'expense_no_subscription' as const,
            developer_id: `dev-${i}`,
            developer_name: `Dev ${String(i).padStart(2, '0')}`,
            developer_email: `dev${i}@test.com`,
            team: 'frontend',
            tool: 'cursor',
            expense_amount: 20,
            registry_amount: null,
            details: null,
            status: 'open' as const,
            resolution: null,
            resolved_at: null,
        }));
        renderPage(<AdminReconciliation />);
        await screen.findByText('Dev 00');

        // Page 1 caps at 25 rows.
        expect(document.querySelectorAll('tbody tr')).toHaveLength(25);
        expect(screen.queryByText('Dev 25')).not.toBeInTheDocument();

        // Go to page 2, then flip the status filter → the new query's data is a
        // fresh reference, so the shared hook snaps back to page 1.
        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(screen.getByText('Dev 25')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'All'}));
        await waitFor(() => expect(screen.getByText('Dev 00')).toBeInTheDocument());
        expect(document.querySelectorAll('tbody tr')).toHaveLength(25);
        expect(screen.queryByText('Dev 25')).not.toBeInTheDocument();
    });

    it('renders NO run form until the admin asks for one, and the opener announces the dialog', async () => {
        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');

        // The form-above-table is gone: the results table is the primary content.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('2026-06')).not.toBeInTheDocument();

        const opener = screen.getByRole('button', {name: 'Run reconciliation'});
        expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
        fireEvent.click(opener);
        expect(screen.getByRole('dialog', {name: 'Run reconciliation'})).toBeInTheDocument();
    });

    it('runs reconciliation from the modal, sending the period and tolerance', async () => {
        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');
        openRunModal();

        fireEvent.change(screen.getByPlaceholderText('2026-06'), {target: {value: '2026-06'}});
        fireEvent.change(screen.getByPlaceholderText('1'), {target: {value: '2.5'}});
        fireEvent.click(screen.getByRole('button', {name: /^run$/i}));

        await waitFor(() => {
            const sent = runBody();
            expect(sent).toBeTruthy();
            expect(sent?.period).toBe('2026-06');
            expect(sent?.tolerance).toBe(2.5);
        });

        // Success closes the dialog, but the run summary outlives it — it is the
        // outcome of the run and has to stay readable beside the rows.
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(screen.getByText('Reconciled 2026-06: 1 new, 0 already tracked.')).toBeInTheDocument();
    });

    it('omits blank run parameters, as the inline form did', async () => {
        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');
        openRunModal();
        fireEvent.click(screen.getByRole('button', {name: /^run$/i}));

        await waitFor(() => expect(runBody()).toBeTruthy());
        const sent = runBody();
        expect(sent?.period).toBeUndefined();
        expect(sent?.tolerance).toBeUndefined();
    });

    it('blocks Run on an invalid period or tolerance', async () => {
        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');
        openRunModal();

        fireEvent.change(screen.getByPlaceholderText('2026-06'), {target: {value: '2026-13'}});
        expect(screen.getByText('Period must be in YYYY-MM format.')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: /^run$/i})).toBeDisabled();

        fireEvent.change(screen.getByPlaceholderText('2026-06'), {target: {value: '2026-06'}});
        fireEvent.change(screen.getByPlaceholderText('1'), {target: {value: '-1'}});
        expect(screen.getByText('Tolerance must be a non-negative number.')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: /^run$/i})).toBeDisabled();

        // The disabled Run sends nothing. (FormModal also re-checks the gate in
        // requestSubmit; that backstop is covered in formModal.test.tsx.)
        fireEvent.click(screen.getByRole('button', {name: /^run$/i}));
        expect(runBody()).toBeUndefined();
    });

    it('retracts the previous run summary when a later run fails', async () => {
        // Succeed once, then fail — the inline form's summary was gated on the
        // mutation's own isSuccess, so it vanished the moment a rerun started.
        // The page owns that state now, so it must retract it explicitly.
        let runs = 0;
        const inner = fetchMock;
        fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
            if (String(url).includes('/reconciliation/run') && ++runs > 1) {
                return json({error: 'boom'}, 500);
            }
            return inner(url, init) as Promise<Response>;
        });
        vi.stubGlobal('fetch', fetchMock);

        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');

        openRunModal();
        fireEvent.click(screen.getByRole('button', {name: /^run$/i}));
        expect(await screen.findByText('Reconciled 2026-06: 1 new, 0 already tracked.')).toBeInTheDocument();

        openRunModal();
        fireEvent.click(screen.getByRole('button', {name: /^run$/i}));

        // The failed rerun must not leave the old success standing beside its error.
        await screen.findByText(/reconciliation\/run failed with 500/i);
        expect(screen.queryByText(/already tracked/)).not.toBeInTheDocument();
    });

    it('reopens the run modal with clean fields', async () => {
        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');

        openRunModal();
        fireEvent.change(screen.getByPlaceholderText('2026-06'), {target: {value: '2026-01'}});
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        openRunModal();
        expect(screen.getByPlaceholderText('2026-06')).toHaveValue('');
    });

    it('cannot be dismissed while the run is in flight, and stays open on failure', async () => {
        // Hold the run open so the dialog is observably pending.
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const inner = fetchMock;
        fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
            if (String(url).includes('/reconciliation/run')) {
                await gate;
                return json({error: 'reconcile failed'}, 500);
            }
            return inner(url, init) as Promise<Response>;
        });
        vi.stubGlobal('fetch', fetchMock);

        renderPage(<AdminReconciliation />);
        await screen.findByText('Carol Dev');
        openRunModal();
        fireEvent.click(screen.getByRole('button', {name: /^run$/i}));

        // In flight: every close affordance is inert (#236 criterion 4).
        await screen.findByRole('button', {name: 'Running…'});
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.getByRole('dialog', {name: 'Run reconciliation'})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.getByRole('dialog', {name: 'Run reconciliation'})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.getByRole('dialog', {name: 'Run reconciliation'})).toBeInTheDocument();

        release?.();

        // A failed run keeps the dialog open with the error, and reports no summary.
        await screen.findByText(/reconciliation\/run failed with 500/i);
        expect(screen.getByRole('dialog', {name: 'Run reconciliation'})).toBeInTheDocument();
        expect(screen.queryByText(/already tracked/)).not.toBeInTheDocument();

        // Once settled, the guard lifts.
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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
