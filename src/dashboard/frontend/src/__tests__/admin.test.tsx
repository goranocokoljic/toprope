// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {AdminUsers} from '../pages/admin/AdminUsers';
import {AdminSubscriptions} from '../pages/admin/AdminSubscriptions';
import {AdminTeams} from '../pages/admin/AdminTeams';
import type {AdminDeveloper, AdminSubscription, AdminTeam, AdminUser} from '../api/types';

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

/** Open the create-user dialog from the header's primary affordance. */
function openCreateUserModal(): void {
    fireEvent.click(screen.getByRole('button', {name: '＋ New user'}));
}

/**
 * Drive the whole create flow: open the modal, fill the email, submit. The modal
 * closes on success, so a second create must open it again — the fields no
 * longer survive a create (they unmount with the dialog).
 */
function createUser(email: string): void {
    openCreateUserModal();
    fireEvent.change(screen.getByLabelText('Email'), {target: {value: email}});
    fireEvent.click(screen.getByRole('button', {name: 'Create user'}));
}

describe('AdminUsers page', () => {
    it('lists users from the API', async () => {
        renderPage(<AdminUsers />);
        expect(await screen.findByText('admin@test.com')).toBeInTheDocument();
    });

    it('paginates the user table at 25 rows per page and navigates pages', async () => {
        users = Array.from({length: 30}, (_, i) => ({
            id: `u-${String(i).padStart(2, '0')}`,
            email: `user${String(i).padStart(2, '0')}@test.com`,
            role: 'developer' as const,
            developer_id: null,
            developer_name: null,
            must_change_password: false,
            created_at: '2026-01-01T00:00:00.000Z',
            deactivated_at: null,
            active: true,
        }));
        renderPage(<AdminUsers />);
        await screen.findByText('user00@test.com');

        // Page 1 caps at 25 rows; the 26th user is off-page.
        expect(document.querySelectorAll('tbody tr')).toHaveLength(25);
        expect(screen.queryByText('user25@test.com')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(document.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(screen.getByText('user25@test.com')).toBeInTheDocument();
        expect(screen.queryByText('user00@test.com')).not.toBeInTheDocument();
    });

    it('renders NO create form until the admin asks for one, and the opener announces the dialog', async () => {
        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        // The page is the table, not a form pinned above it.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

        const opener = screen.getByRole('button', {name: '＋ New user'});
        expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
        fireEvent.click(opener);
        expect(screen.getByRole('dialog', {name: 'Create user'})).toBeInTheDocument();
        expect(screen.getByLabelText('Email')).toBeInTheDocument();
    });

    it('submitting posts the inline form’s shape, closes the modal, and the new row reads back', async () => {
        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');

        openCreateUserModal();
        fireEvent.change(screen.getByLabelText('Email'), {target: {value: 'new@test.com'}});
        fireEvent.change(screen.getByLabelText('Role'), {target: {value: 'admin'}});
        // Wait for the developer options to load before selecting (a select
        // rejects a value with no matching option).
        await screen.findByRole('option', {name: 'Alice Dev'});
        fireEvent.change(screen.getByLabelText('Linked developer'), {target: {value: 'dev-1'}});
        fireEvent.click(screen.getByRole('button', {name: 'Create user'}));

        // A successful write closes the dialog…
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        // …and the list refreshes: the created user reads back through the real
        // hook → API → row path, not a hand-built fixture.
        expect(await screen.findByText('new@test.com')).toBeInTheDocument();

        const post = [...fetchMock.mock.calls]
            .reverse()
            .find(
                (c) =>
                    String(c[0]).includes('/api/admin/users') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
            );
        expect(post).toBeTruthy();
        const sent = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
        expect(sent).toEqual({email: 'new@test.com', role: 'admin', developer_id: 'dev-1'});
    });

    it('trims the email and sends a null developer link when none is chosen', async () => {
        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        createUser('  padded@test.com  ');

        await waitFor(() => {
            const post = [...fetchMock.mock.calls]
                .reverse()
                .find(
                    (c) =>
                        String(c[0]).includes('/api/admin/users') &&
                        (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
                );
            expect(post).toBeTruthy();
            const sent = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
            expect(sent).toEqual({email: 'padded@test.com', role: 'developer', developer_id: null});
        });
    });

    it('gates the developer link until its options have loaded', async () => {
        let releaseDevelopers: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseDevelopers = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            if (String(url).includes('/api/admin/developers')) await gate;
            return base!(url, init);
        });

        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        openCreateUserModal();

        // While the options are in flight the select is inert and says so — an
        // enabled "— none —"-only list would read as "there are no developers".
        const select = screen.getByLabelText('Linked developer') as HTMLSelectElement;
        expect(select).toBeDisabled();
        expect(screen.getByRole('option', {name: 'Loading developers…'})).toBeInTheDocument();

        releaseDevelopers?.();
        await screen.findByRole('option', {name: 'Alice Dev'});
        expect(select).toBeEnabled();
        expect(screen.getByRole('option', {name: '— none —'})).toBeInTheDocument();
    });

    it('the one-time temp password survives the modal closing, shows once, and is dismissible', async () => {
        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        createUser('new@test.com');

        // The reveal outlives the dialog: it is on the page, not inside a
        // dismissed modal — and it is rendered exactly once.
        expect(await screen.findByText('temp-secret-xyz')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(screen.getAllByText('temp-secret-xyz')).toHaveLength(1);
        expect(screen.getByText(/shown once/i)).toBeInTheDocument();

        // Reopening the create modal must not re-render or duplicate the reveal.
        openCreateUserModal();
        expect(screen.getAllByText('temp-secret-xyz')).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
        expect(screen.queryByText('temp-secret-xyz')).not.toBeInTheDocument();
    });

    it('Save is gated on an email, Cancel closes with no write, and reopening starts empty', async () => {
        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');

        openCreateUserModal();
        // An empty (or whitespace-only) email cannot be submitted.
        expect(screen.getByRole('button', {name: 'Create user'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Email'), {target: {value: '   '}});
        expect(screen.getByRole('button', {name: 'Create user'})).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Email'), {target: {value: 'typed-then-abandoned@test.com'}});
        expect(screen.getByRole('button', {name: 'Create user'})).toBeEnabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        const posted = fetchMock.mock.calls.some(
            (c) =>
                String(c[0]).includes('/api/admin/users') &&
                (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
        );
        expect(posted).toBe(false);
        // Reopening remounts clean — the abandoned draft is gone (criterion 3).
        openCreateUserModal();
        expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
    });

    it('no close affordance works while the create is in flight — the POST cannot land invisibly', async () => {
        let releasePost: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releasePost = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (u.includes('/api/admin/users') && method === 'POST') await gate;
            return base!(url, init);
        });

        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        createUser('new@test.com');
        expect(await screen.findByRole('button', {name: 'Creating…'})).toBeInTheDocument();

        // Cancel, Esc, ×, and a genuine backdrop click are all inert mid-write.
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.getByRole('dialog', {name: 'Create user'})).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.getByRole('dialog', {name: 'Create user'})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.getByRole('dialog', {name: 'Create user'})).toBeInTheDocument();
        const backdrop = screen.getByTestId('create-user-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog', {name: 'Create user'})).toBeInTheDocument();
        // The reveal has not leaked out early either — it lands on success only.
        expect(screen.queryByText('temp-secret-xyz')).not.toBeInTheDocument();

        // Once the write settles the modal closes through the success path.
        releasePost?.();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await screen.findByText('temp-secret-xyz')).toBeInTheDocument();
    });

    it('surfaces a failed create inside the modal and keeps it open with the draft intact', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (u.includes('/api/admin/users') && method === 'POST') {
                // The client surfaces a 4xx body's `message` (see apiClient).
                return json({message: 'Email already registered'}, 409);
            }
            return base!(url, init);
        });

        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        createUser('dupe@test.com');

        expect(await screen.findByText(/Email already registered/)).toBeInTheDocument();
        // The dialog stays open with the admin's values — a failed write must not
        // discard the draft or leave the failure invisible behind a closed modal.
        expect(screen.getByRole('dialog', {name: 'Create user'})).toBeInTheDocument();
        expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('dupe@test.com');
        // No password is revealed for a user that was never created.
        expect(screen.queryByText('temp-secret-xyz')).not.toBeInTheDocument();
    });
});

describe('AdminSubscriptions page', () => {
    it('paginates the subscription table at 25 rows per page', async () => {
        subscriptions = Array.from({length: 30}, (_, i) => ({
            id: `s-${String(i).padStart(2, '0')}`,
            developer_id: `dev-${i}`,
            developer_name: `Dev ${String(i).padStart(2, '0')}`,
            developer_email: `dev${i}@test.com`,
            team: 'frontend',
            tool: 'copilot',
            plan: 'Business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            seat_assigned_at: '2026-02-01T00:00:00.000Z',
            seat_revoked_at: null,
            data_source: 'admin',
        }));
        renderPage(<AdminSubscriptions />);
        await screen.findByText('Dev 00');

        expect(document.querySelectorAll('tbody tr')).toHaveLength(25);
        expect(screen.queryByText('Dev 25')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(document.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(screen.getByText('Dev 25')).toBeInTheDocument();
        expect(screen.queryByText('Dev 00')).not.toBeInTheDocument();
    });

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

describe('AdminTeams page', () => {
    it('paginates the team table at 25 rows per page', async () => {
        const teams: AdminTeam[] = Array.from({length: 30}, (_, i) => ({
            name: `team-${String(i).padStart(2, '0')}`,
            department: 'Engineering',
            manager: 'Mae',
            created_at: '2026-01-01T00:00:00.000Z',
            archived_at: null,
            developer_count: 3,
        }));
        fetchMock.mockImplementation(async (url: unknown) => {
            if (String(url).includes('/api/admin/teams')) return json({data: teams});
            return json({error: 'not found'}, 404);
        });
        renderPage(<AdminTeams />);
        await screen.findByText('team-00');

        expect(document.querySelectorAll('tbody tr')).toHaveLength(25);
        expect(screen.queryByText('team-25')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(document.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(screen.getByText('team-29')).toBeInTheDocument();
        expect(screen.queryByText('team-00')).not.toBeInTheDocument();
    });
});
