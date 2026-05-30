// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {Root} from '../Root';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {AuthUser} from '../api/types';

const OVERVIEW = {
    total_developers: 20,
    active_developers: 12,
    total_subscriptions: 18,
    total_monthly_cost: 1234,
    active_tools: ['copilot'],
    data_quality_distribution: {high: 8, medium: 5, low: 4, none: 3},
    active_waste_alert_count: 3,
    total_monthly_waste: 177,
};

const ADMIN: AuthUser = {
    email: 'admin@test.com',
    role: 'admin',
    developer_id: null,
    must_change_password: false,
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {'Content-Type': 'application/json'},
    });
}

// Mutable session state the mocked API reads/writes, so login/logout actually
// flip what GET /api/auth/me returns — the way the real backend would.
let session: AuthUser | null = null;
let loginAs: AuthUser = ADMIN;
let fetchMock: Mock;

function installFetch(): void {
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();

        if (u.includes('/api/auth/me')) {
            return session ? jsonResponse({data: session}) : jsonResponse({error: 'Unauthorized'}, 401);
        }
        if (u.includes('/api/auth/login') && method === 'POST') {
            session = loginAs;
            return jsonResponse({
                data: {
                    role: loginAs.role,
                    developer_id: loginAs.developer_id,
                    must_change_password: loginAs.must_change_password,
                },
            });
        }
        if (u.includes('/api/auth/logout')) {
            session = null;
            return jsonResponse({data: {ok: true}});
        }
        if (u.includes('/api/auth/change-password')) {
            session = session ? {...session, must_change_password: false} : null;
            return jsonResponse({data: {ok: true}});
        }
        if (u.includes('/api/overview')) {
            return jsonResponse({data: OVERVIEW});
        }
        return jsonResponse({error: 'Not Found'}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
}

function renderRoot(): void {
    render(
        <QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
            <ThemeProvider>
                <MemoryRouter initialEntries={['/']}>
                    <Root />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    session = null;
    loginAs = ADMIN;
    installFetch();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

describe('auth gating', () => {
    it('shows the login screen when there is no session', async () => {
        renderRoot();
        expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
        expect(screen.queryByText('Organization Overview')).not.toBeInTheDocument();
    });

    it('logs in and reveals the protected app', async () => {
        renderRoot();
        await screen.findByText('Sign in to your account');

        fireEvent.change(screen.getByLabelText('Email'), {target: {value: 'admin@test.com'}});
        fireEvent.change(screen.getByLabelText('Password'), {target: {value: 'correct-horse'}});
        fireEvent.click(screen.getByRole('button', {name: 'Sign in'}));

        expect(await screen.findByText('Organization Overview')).toBeInTheDocument();
        // The signed-in user and a logout control appear in the shell.
        expect(screen.getByText('admin@test.com')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Log out'})).toBeInTheDocument();
    });

    it('forces a password change for a flagged session before the app loads', async () => {
        session = {...ADMIN, must_change_password: true};
        renderRoot();
        expect(await screen.findByText(/must set a new password/i)).toBeInTheDocument();
        expect(screen.queryByText('Organization Overview')).not.toBeInTheDocument();
    });

    it('logs out and returns to the login screen', async () => {
        session = ADMIN;
        renderRoot();
        await screen.findByText('Organization Overview');

        fireEvent.click(screen.getByRole('button', {name: 'Log out'}));
        expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
    });
});
