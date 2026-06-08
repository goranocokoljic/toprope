// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {Anomalies} from '../pages/Anomalies';
import type {AnomalyAlert} from '../api/types';

function highCommits(): AnomalyAlert {
    return {
        id: 'a-commits',
        scope: 'team',
        scope_id: 'frontend',
        team: 'frontend',
        metric: 'commits',
        metric_label: 'commit activity',
        period: '2026-05-04',
        method: 'statistical',
        observed_value: 4,
        expected_value: 10,
        deviation: -3.1,
        change_pct: -60,
        direction: 'decrease',
        severity: 'high',
        basis: 'git_estimate',
        basis_label: 'git-based estimate',
        status: 'open',
        detected_at: '2026-05-11T00:00:00.000Z',
        description: 'Commit activity dropped 60%',
    };
}

function notableCost(): AnomalyAlert {
    return {
        ...highCommits(),
        id: 'a-cost',
        metric: 'cost',
        metric_label: 'subscription cost',
        method: 'percentage_change',
        observed_value: 580,
        expected_value: 400,
        change_pct: 45,
        direction: 'increase',
        severity: 'notable',
        description: 'Subscription cost rose 45%',
    };
}

let open: AnomalyAlert[];
let acknowledged: AnomalyAlert[];
let resolved: AnomalyAlert[];
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

function listFor(status: string): AnomalyAlert[] {
    if (status === 'acknowledged') return acknowledged;
    if (status === 'resolved') return resolved;
    return open;
}

beforeEach(() => {
    open = [highCommits(), notableCost()];
    acknowledged = [];
    resolved = [];

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();

        const ackMatch = u.match(/\/api\/anomalies\/([^/]+)\/acknowledge/);
        if (ackMatch && method === 'POST') {
            const id = ackMatch[1];
            const found = open.find((a) => a.id === id);
            if (found) {
                open = open.filter((a) => a.id !== id);
                acknowledged = [...acknowledged, {...found, status: 'acknowledged'}];
                return json({data: {...found, status: 'acknowledged'}});
            }
            return json({error: 'Not Found'}, 404);
        }

        const resolveMatch = u.match(/\/api\/anomalies\/([^/]+)\/resolve/);
        if (resolveMatch && method === 'POST') {
            const id = resolveMatch[1];
            const found = open.find((a) => a.id === id) ?? acknowledged.find((a) => a.id === id);
            if (found) {
                open = open.filter((a) => a.id !== id);
                acknowledged = acknowledged.filter((a) => a.id !== id);
                resolved = [...resolved, {...found, status: 'resolved'}];
                return json({data: {...found, status: 'resolved'}});
            }
            return json({error: 'Not Found'}, 404);
        }

        const listMatch = u.match(/\/api\/anomalies\?status=([^&]+)/);
        if (listMatch && method === 'GET') {
            return json({data: listFor(listMatch[1])});
        }

        return json({error: 'unexpected'}, 500);
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
                <Anomalies />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('Anomalies panel', () => {
    it('lists open anomalies with severity treatment, description, and honest basis label', async () => {
        renderPage();
        const cards = await screen.findAllByTestId('anomaly-card');
        expect(cards).toHaveLength(2);

        const commits = cards[0];
        expect(within(commits).getByText('High')).toBeInTheDocument();
        expect(within(commits).getByText('Commit activity dropped 60%')).toBeInTheDocument();
        expect(within(commits).getAllByText('git-based estimate').length).toBeGreaterThan(0);

        const cost = cards[1];
        expect(within(cost).getByText('Notable')).toBeInTheDocument();
        expect(within(cost).getByText('Subscription cost rose 45%')).toBeInTheDocument();
    });

    it('acknowledging drops the anomaly from the open list', async () => {
        renderPage();
        const cards = await screen.findAllByTestId('anomaly-card');
        const ackButton = within(cards[0]).getByRole('button', {name: 'Acknowledge'});
        fireEvent.click(ackButton);

        await waitFor(() => {
            expect(screen.getAllByTestId('anomaly-card')).toHaveLength(1);
        });
        expect(screen.queryByText('Commit activity dropped 60%')).not.toBeInTheDocument();
    });

    it('resolving drops the anomaly from the open list', async () => {
        renderPage();
        const cards = await screen.findAllByTestId('anomaly-card');
        const resolveButton = within(cards[1]).getByRole('button', {name: 'Resolve'});
        fireEvent.click(resolveButton);

        await waitFor(() => {
            expect(screen.getAllByTestId('anomaly-card')).toHaveLength(1);
        });
        expect(screen.queryByText('Subscription cost rose 45%')).not.toBeInTheDocument();
    });

    it('shows an empty state when there are no open anomalies', async () => {
        open = [];
        renderPage();
        expect(await screen.findByTestId('anomalies-empty')).toBeInTheDocument();
    });

    it('switching to the Resolved tab shows resolved anomalies', async () => {
        open = [];
        resolved = [{...highCommits(), status: 'resolved'}];
        renderPage();
        // Wait for the initial open list to settle, then switch tabs.
        await screen.findByTestId('anomalies-empty');
        fireEvent.click(screen.getByRole('button', {name: 'Resolved'}));
        await waitFor(() => {
            expect(screen.getByText('Commit activity dropped 60%')).toBeInTheDocument();
        });
    });
});
