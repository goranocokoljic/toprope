// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {AdminUsers} from '../pages/admin/AdminUsers';
import {AdminSubscriptions} from '../pages/admin/AdminSubscriptions';
import type {AdminDeveloper, AdminSubscription, AdminUser} from '../api/types';

const DEVELOPERS: AdminDeveloper[] = [
    {id: 'dev-1', name: 'Alice Dev', email: 'alice@test.com', team: 'frontend', external_ids: {}, created_at: '2026-01-01T00:00:00.000Z'},
];

let users: AdminUser[];
let subscriptions: AdminSubscription[];
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

beforeEach(() => {
    users = [
        {
            id: 'u1',
            email: 'admin@test.com',
            role: 'admin',
            developer_id: null,
            developer_name: null,
            must_change_password: false,
            created_at: '2026-01-01T00:00:00.000Z',
            deactivated_at: null,
            active: true,
        },
    ];
    subscriptions = [];

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (u.includes('/api/admin/developers')) {
            return json({data: DEVELOPERS});
        }
        if (u.includes('/api/admin/users') && method === 'POST') {
            const created: AdminUser & {temp_password: string} = {
                id: 'u2',
                email: String(body.email).toLowerCase(),
                role: body.role as 'admin' | 'developer',
                developer_id: (body.developer_id as string) || null,
                developer_name: null,
                must_change_password: true,
                created_at: '2026-02-01T00:00:00.000Z',
                deactivated_at: null,
                active: true,
                temp_password: 'temp-secret-xyz',
            };
            users = [...users, created];
            return json({data: created}, 201);
        }
        if (u.includes('/api/admin/users')) {
            return json({data: users});
        }
        if (u.includes('/api/admin/subscriptions') && method === 'POST') {
            const created: AdminSubscription = {
                id: 's2',
                developer_id: String(body.developer_id),
                developer_name: 'Alice Dev',
                developer_email: 'alice@test.com',
                team: 'frontend',
                tool: String(body.tool),
                plan: (body.plan as string) ?? null,
                billing_model: 'company_managed',
                monthly_cost: (body.monthly_cost as number) ?? null,
                seat_assigned_at: '2026-02-01T00:00:00.000Z',
                seat_revoked_at: null,
                data_source: 'admin',
            };
            subscriptions = [...subscriptions, created];
            return json({data: created}, 201);
        }
        if (u.includes('/api/admin/subscriptions')) {
            return json({data: subscriptions});
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

describe('AdminUsers page', () => {
    it('lists users from the API', async () => {
        renderPage(<AdminUsers />);
        expect(await screen.findByText('admin@test.com')).toBeInTheDocument();
    });

    it('creating a user surfaces the one-time temporary password', async () => {
        renderPage(<AdminUsers />);
        const email = await screen.findByPlaceholderText('user@company.com');
        fireEvent.change(email, {target: {value: 'new@test.com'}});
        fireEvent.click(screen.getByRole('button', {name: /create user/i}));

        // The temp password banner appears once the POST resolves.
        expect(await screen.findByText('temp-secret-xyz')).toBeInTheDocument();
        await waitFor(() => {
            const posted = fetchMock.mock.calls.some(
                (c) =>
                    String(c[0]).includes('/api/admin/users') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
            );
            expect(posted).toBe(true);
        });
    });
});

describe('AdminSubscriptions page', () => {
    it('assigns a subscription via POST', async () => {
        renderPage(<AdminSubscriptions />);
        // The developer select is labelled "Developer"; wait for its option to
        // load before selecting (a select rejects a value with no matching option).
        const devSelect = (await screen.findByRole('combobox', {name: 'Developer'})) as HTMLSelectElement;
        await screen.findByRole('option', {name: 'Alice Dev'});
        fireEvent.change(devSelect, {target: {value: 'dev-1'}});
        fireEvent.click(screen.getByRole('button', {name: /^assign$/i}));

        await waitFor(() => {
            const post = fetchMock.mock.calls.find(
                (c) =>
                    String(c[0]).includes('/api/admin/subscriptions') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
            );
            expect(post).toBeTruthy();
            const sent = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
            expect(sent.developer_id).toBe('dev-1');
            expect(sent.tool).toBe('copilot');
        });
    });
});
