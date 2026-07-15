// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
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
let teams: AdminTeam[];
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
    // Two teams that differ in EVERY editable field — one fully populated, one
    // with nulls — so a cross-row pre-fill leak has a visible signal to catch.
    teams = [
        {
            name: 'frontend',
            department: 'Engineering',
            manager: 'mae@test.com',
            created_at: '2026-01-01T00:00:00.000Z',
            archived_at: null,
            developer_count: 3,
        },
        {
            name: 'platform',
            department: null,
            manager: null,
            created_at: '2026-01-02T00:00:00.000Z',
            archived_at: null,
            developer_count: 1,
        },
    ];

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
        // Teams: create appends, PATCH merges into the addressed row, so every
        // assertion below reads the row back through the real hook (seed → API →
        // row) rather than a hand-built fixture.
        if (u.includes('/api/admin/teams') && method === 'POST') {
            const created: AdminTeam = {
                name: String(body.name),
                department: (body.department as string) ?? null,
                manager: (body.manager as string) ?? null,
                created_at: '2026-02-01T00:00:00.000Z',
                archived_at: null,
                developer_count: 0,
            };
            teams = [...teams, created];
            return json({data: created}, 201);
        }
        if (u.includes('/api/admin/teams/') && method === 'PATCH') {
            const name = decodeURIComponent(u.split('/api/admin/teams/')[1]);
            const target = teams.find((t) => t.name === name);
            if (!target) return json({message: 'No such team'}, 404);
            const updated: AdminTeam = {
                ...target,
                ...('department' in body ? {department: (body.department as string) ?? null} : {}),
                ...('manager' in body ? {manager: (body.manager as string) ?? null} : {}),
                ...('archived' in body
                    ? {archived_at: body.archived ? '2026-03-01T00:00:00.000Z' : null}
                    : {}),
            };
            teams = teams.map((t) => (t.name === name ? updated : t));
            return json({data: updated});
        }
        if (u.includes('/api/admin/teams')) {
            return json({data: teams});
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

/** Wait for a page's table query to settle, so nothing below races the spinner. */
async function waitForTableLoaded(): Promise<void> {
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
}

/**
 * Open the assign-subscription dialog from the header's primary affordance, and
 * wait for the developer options to arrive — they load WITH the dialog now, and a
 * select rejects a value with no matching option.
 */
async function openAssignModal(): Promise<void> {
    fireEvent.click(screen.getByRole('button', {name: '＋ Assign subscription'}));
    await screen.findByRole('option', {name: 'Alice Dev'});
}

/** The assign POST, if the page sent one. */
function assignPost(): [unknown, RequestInit?] | undefined {
    return fetchMock.mock.calls.find(
        (c) =>
            String(c[0]).includes('/api/admin/subscriptions') &&
            (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
    ) as [unknown, RequestInit?] | undefined;
}

/** The `<tr>` for a team, so a row's own controls can be addressed unambiguously. */
function teamRow(name: string): HTMLElement {
    const cell = screen.getByText(name).closest('tr');
    if (!cell) throw new Error(`No row for team ${name}`);
    return cell;
}

/** Open the create-team dialog from the header's primary affordance. */
function openCreateTeamModal(): void {
    fireEvent.click(screen.getByRole('button', {name: '＋ New team'}));
}

/** Open a specific team row's edit dialog. */
function openEditTeamModal(name: string): void {
    fireEvent.click(within(teamRow(name)).getByRole('button', {name: 'Edit'}));
}

/** The team-create POST, if the page sent one. */
function teamPost(): [unknown, RequestInit?] | undefined {
    return fetchMock.mock.calls.find(
        (c) =>
            String(c[0]).endsWith('/api/admin/teams') &&
            (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
    ) as [unknown, RequestInit?] | undefined;
}

/** Every PATCH sent to a given team, in order. */
function teamPatches(name: string): [unknown, RequestInit?][] {
    return fetchMock.mock.calls.filter(
        (c) =>
            String(c[0]).includes(`/api/admin/teams/${encodeURIComponent(name)}`) &&
            (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
    ) as [unknown, RequestInit?][];
}

/** The parsed body of a recorded request. */
function sentBody(call: [unknown, RequestInit?] | undefined): Record<string, unknown> {
    return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
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

    it('assigns only via the modal: the button opens it, the POST keeps the inline form shape, and success closes it and refreshes the list', async () => {
        renderPage(<AdminSubscriptions />);
        await waitForTableLoaded();
        // Nothing renders over the table until the admin asks for it (criterion 1).
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Developer')).not.toBeInTheDocument();
        // The opener announces that it opens a dialog (epic criterion 2).
        expect(screen.getByRole('button', {name: '＋ Assign subscription'})).toHaveAttribute(
            'aria-haspopup',
            'dialog',
        );

        await openAssignModal();
        expect(screen.getByRole('dialog', {name: 'Assign or change subscription'})).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Developer'), {target: {value: 'dev-1'}});
        fireEvent.change(screen.getByLabelText('Plan'), {target: {value: '  business  '}});
        fireEvent.change(screen.getByLabelText('Monthly cost ($)'), {target: {value: '19'}});
        fireEvent.click(screen.getByRole('button', {name: 'Assign'}));

        await waitFor(() => expect(assignPost()).toBeTruthy());
        // Same request shape the inline form sent (criterion 2): trimmed plan,
        // numeric cost — not the raw strings.
        const sent = JSON.parse(String(assignPost()?.[1]?.body)) as Record<string, unknown>;
        expect(sent).toEqual({developer_id: 'dev-1', tool: 'copilot', plan: 'business', monthly_cost: 19});

        // Success closes the dialog and the list refreshes — the row is read back
        // through the real hook (seed → API → row), not a hand-built fixture.
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await screen.findByText('Alice Dev')).toBeInTheDocument();
        expect(screen.getByText('$19')).toBeInTheDocument();
    });

    it('sends an empty plan and cost as null, matching the inline form', async () => {
        renderPage(<AdminSubscriptions />);
        await waitForTableLoaded();
        await openAssignModal();

        fireEvent.change(screen.getByLabelText('Developer'), {target: {value: 'dev-1'}});
        fireEvent.change(screen.getByLabelText('Tool'), {target: {value: 'windsurf'}});
        // Plan and cost left blank (whitespace-only plan is still "blank").
        fireEvent.change(screen.getByLabelText('Plan'), {target: {value: '   '}});
        fireEvent.click(screen.getByRole('button', {name: 'Assign'}));

        await waitFor(() => expect(assignPost()).toBeTruthy());
        const sent = JSON.parse(String(assignPost()?.[1]?.body)) as Record<string, unknown>;
        expect(sent).toEqual({developer_id: 'dev-1', tool: 'windsurf', plan: null, monthly_cost: null});
    });

    it('gates Assign on a developer and a non-negative cost, and Cancel closes with no write', async () => {
        renderPage(<AdminSubscriptions />);
        await waitForTableLoaded();
        await openAssignModal();

        // No developer picked yet — the write the backend would reject can't be sent.
        expect(screen.getByRole('button', {name: 'Assign'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Developer'), {target: {value: 'dev-1'}});
        expect(screen.getByRole('button', {name: 'Assign'})).toBeEnabled();

        fireEvent.change(screen.getByLabelText('Monthly cost ($)'), {target: {value: '-5'}});
        expect(screen.getByRole('button', {name: 'Assign'})).toBeDisabled();
        expect(screen.getByText('Monthly cost must be a non-negative number.')).toBeInTheDocument();

        // Zero is a legitimate cost (a free seat) — the gate is on negatives, not
        // on falsiness. (Non-numeric text isn't asserted here: a number input
        // sanitizes it to '', so the isFinite guard is unreachable through the
        // real control.)
        fireEvent.change(screen.getByLabelText('Monthly cost ($)'), {target: {value: '0'}});
        expect(screen.getByRole('button', {name: 'Assign'})).toBeEnabled();
        expect(screen.queryByText('Monthly cost must be a non-negative number.')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(assignPost()).toBeFalsy();

        // Reopening remounts clean — the abandoned draft is gone (criterion 3).
        await openAssignModal();
        expect((screen.getByLabelText('Developer') as HTMLSelectElement).value).toBe('');
        expect((screen.getByLabelText('Monthly cost ($)') as HTMLInputElement).value).toBe('');
    });

    it('gates the developer select until its options load — an empty select must not read as "no developers"', async () => {
        let releaseDevelopers: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseDevelopers = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            if (String(url).includes('/api/admin/developers')) await gate;
            return base!(url, init);
        });

        renderPage(<AdminSubscriptions />);
        await waitForTableLoaded();
        fireEvent.click(screen.getByRole('button', {name: '＋ Assign subscription'}));

        const select = screen.getByLabelText('Developer');
        expect(select).toBeDisabled();
        expect(screen.getByRole('option', {name: 'Loading developers…'})).toBeInTheDocument();

        releaseDevelopers?.();
        await screen.findByRole('option', {name: 'Alice Dev'});
        expect(select).toBeEnabled();
        expect(screen.getByRole('option', {name: 'Select…'})).toBeInTheDocument();
    });

    it('no close affordance works while the assign is in flight — the POST cannot land invisibly', async () => {
        let releasePost: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releasePost = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (u.includes('/api/admin/subscriptions') && method === 'POST') await gate;
            return base!(url, init);
        });

        renderPage(<AdminSubscriptions />);
        await waitForTableLoaded();
        await openAssignModal();
        fireEvent.change(screen.getByLabelText('Developer'), {target: {value: 'dev-1'}});
        fireEvent.click(screen.getByRole('button', {name: 'Assign'}));
        expect(await screen.findByRole('button', {name: 'Saving…'})).toBeInTheDocument();

        // Cancel, Esc, ×, and a genuine backdrop click are all inert mid-write.
        const dialogName = 'Assign or change subscription';
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        const backdrop = screen.getByTestId('assign-subscription-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();

        // Once the write settles the modal closes through the success path.
        releasePost?.();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await screen.findByText('Alice Dev')).toBeInTheDocument();
    });

    it('surfaces a failed assign inside the modal and keeps it open with the draft intact', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (u.includes('/api/admin/subscriptions') && method === 'POST') {
                // The client surfaces a 4xx body's `message` (see apiClient).
                return json({message: 'Seat limit reached'}, 409);
            }
            return base!(url, init);
        });

        renderPage(<AdminSubscriptions />);
        await waitForTableLoaded();
        await openAssignModal();
        fireEvent.change(screen.getByLabelText('Developer'), {target: {value: 'dev-1'}});
        fireEvent.change(screen.getByLabelText('Plan'), {target: {value: 'business'}});
        fireEvent.click(screen.getByRole('button', {name: 'Assign'}));

        expect(await screen.findByText(/Seat limit reached/)).toBeInTheDocument();
        // The dialog stays open with the admin's values — a failed write must not
        // discard the draft or leave the failure invisible behind a closed modal.
        expect(screen.getByRole('dialog', {name: 'Assign or change subscription'})).toBeInTheDocument();
        expect((screen.getByLabelText('Plan') as HTMLInputElement).value).toBe('business');
    });
});

describe('AdminTeams page', () => {
    it('paginates the team table at 25 rows per page', async () => {
        teams = Array.from({length: 30}, (_, i) => ({
            name: `team-${String(i).padStart(2, '0')}`,
            department: 'Engineering',
            manager: 'Mae',
            created_at: '2026-01-01T00:00:00.000Z',
            archived_at: null,
            developer_count: 3,
        }));
        renderPage(<AdminTeams />);
        await screen.findByText('team-00');

        expect(document.querySelectorAll('tbody tr')).toHaveLength(25);
        expect(screen.queryByText('team-25')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(document.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(screen.getByText('team-29')).toBeInTheDocument();
        expect(screen.queryByText('team-00')).not.toBeInTheDocument();
    });

    it('renders no form until asked and leaves NO editable inputs in the row — both openers announce the dialog', async () => {
        renderPage(<AdminTeams />);
        await waitForTableLoaded();

        // The page is the table, not a create card pinned above it (criterion 1).
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
        // The inline row inputs are gone: the row renders its values as text, so
        // the ONLY editable control anywhere on the page is inside a dialog.
        expect(within(teamRow('frontend')).queryByRole('textbox')).not.toBeInTheDocument();
        expect(within(teamRow('frontend')).getByText('Engineering')).toBeInTheDocument();
        // ...and a row's Save button went with them — editing now commits from
        // the dialog's own Save.
        expect(within(teamRow('frontend')).queryByRole('button', {name: 'Save'})).not.toBeInTheDocument();

        // Both affordances announce that they open a dialog (epic criterion 2).
        expect(screen.getByRole('button', {name: '＋ New team'})).toHaveAttribute(
            'aria-haspopup',
            'dialog',
        );
        expect(within(teamRow('frontend')).getByRole('button', {name: 'Edit'})).toHaveAttribute(
            'aria-haspopup',
            'dialog',
        );
    });

    it('creates only via the modal: the POST keeps the inline form’s shape, and success closes it and refreshes the list', async () => {
        renderPage(<AdminTeams />);
        await waitForTableLoaded();
        openCreateTeamModal();
        expect(screen.getByRole('dialog', {name: 'Create team'})).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Name'), {target: {value: '  growth  '}});
        fireEvent.change(screen.getByLabelText('Department'), {target: {value: '  sales  '}});
        // Manager left blank — the inline form sent null, not ''.
        fireEvent.click(screen.getByRole('button', {name: 'Create team'}));

        await waitFor(() => expect(teamPost()).toBeTruthy());
        expect(sentBody(teamPost())).toEqual({name: 'growth', department: 'sales', manager: null});

        // Success closes the dialog and the new row reads back through the real
        // hook (seed → API → row), not a hand-built fixture.
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await screen.findByText('growth')).toBeInTheDocument();
        expect(within(teamRow('growth')).getByText('sales')).toBeInTheDocument();
    });

    it('edits only via the row’s modal: pre-filled, PATCHes the inline row’s shape, and the row reads back', async () => {
        renderPage(<AdminTeams />);
        await waitForTableLoaded();
        openEditTeamModal('frontend');

        // Pre-filled from the row (criterion 2) — and the name is not editable
        // here: it is the key the PATCH addresses.
        expect(screen.getByRole('dialog', {name: 'Edit team — frontend'})).toBeInTheDocument();
        expect((screen.getByLabelText('Department') as HTMLInputElement).value).toBe('Engineering');
        expect((screen.getByLabelText('Manager') as HTMLInputElement).value).toBe('mae@test.com');
        expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Department'), {target: {value: '  Platform Eng  '}});
        fireEvent.change(screen.getByLabelText('Manager'), {target: {value: '   '}});
        fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));

        await waitFor(() => expect(teamPatches('frontend')).toHaveLength(1));
        // Exactly the patch the inline row inputs sent: trimmed, blank → null,
        // and addressed to THIS team only.
        expect(sentBody(teamPatches('frontend')[0])).toEqual({
            department: 'Platform Eng',
            manager: null,
        });
        expect(teamPatches('platform')).toHaveLength(0);

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await waitFor(() =>
            expect(within(teamRow('frontend')).getByText('Platform Eng')).toBeInTheDocument(),
        );
        expect(screen.queryByText('mae@test.com')).not.toBeInTheDocument();
    });

    it('pre-fills each row independently — switching rows remounts clean fields', async () => {
        renderPage(<AdminTeams />);
        await waitForTableLoaded();

        // Edit one row, type something, abandon it.
        openEditTeamModal('frontend');
        fireEvent.change(screen.getByLabelText('Department'), {target: {value: 'Typed but abandoned'}});
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // The other row must show ITS OWN values — a shared mount would leak the
        // previous row's draft (the key={editing?.name ?? 'new'} remount lesson).
        openEditTeamModal('platform');
        expect(screen.getByRole('dialog', {name: 'Edit team — platform'})).toBeInTheDocument();
        expect((screen.getByLabelText('Department') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Manager') as HTMLInputElement).value).toBe('');
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // Back to the first row: the abandoned draft is gone, re-seeded from the row.
        openEditTeamModal('frontend');
        expect((screen.getByLabelText('Department') as HTMLInputElement).value).toBe('Engineering');

        // And create starts empty rather than carrying the last edited row.
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        openCreateTeamModal();
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Department') as HTMLInputElement).value).toBe('');

        expect(teamPatches('frontend')).toHaveLength(0);
        expect(teamPost()).toBeFalsy();
    });

    it('gates each Save on real input — a name to create, an actual change to edit', async () => {
        renderPage(<AdminTeams />);
        await waitForTableLoaded();

        openCreateTeamModal();
        expect(screen.getByRole('button', {name: 'Create team'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Name'), {target: {value: '   '}});
        expect(screen.getByRole('button', {name: 'Create team'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'growth'}});
        expect(screen.getByRole('button', {name: 'Create team'})).toBeEnabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // The inline row's dirty gate is preserved: an untouched edit can't send
        // a no-op PATCH.
        openEditTeamModal('frontend');
        expect(screen.getByRole('button', {name: 'Save changes'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Manager'), {target: {value: 'new@test.com'}});
        expect(screen.getByRole('button', {name: 'Save changes'})).toBeEnabled();
        // Typing back to the original value is no longer a change.
        fireEvent.change(screen.getByLabelText('Manager'), {target: {value: 'mae@test.com'}});
        expect(screen.getByRole('button', {name: 'Save changes'})).toBeDisabled();

        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(teamPatches('frontend')).toHaveLength(0);
    });

    it('no close affordance works while the edit is in flight — the PATCH cannot land invisibly', async () => {
        let releasePatch: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releasePatch = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).includes('/api/admin/teams/') && method === 'PATCH') await gate;
            return base!(url, init);
        });

        renderPage(<AdminTeams />);
        await waitForTableLoaded();
        openEditTeamModal('frontend');
        fireEvent.change(screen.getByLabelText('Department'), {target: {value: 'Platform Eng'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
        expect(await screen.findByRole('button', {name: 'Saving…'})).toBeInTheDocument();

        // Cancel, Esc, ×, and a genuine backdrop click are all inert mid-write.
        const dialogName = 'Edit team — frontend';
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        const backdrop = screen.getByTestId('team-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();

        // Once the write settles the modal closes through the success path.
        releasePatch?.();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await waitFor(() =>
            expect(within(teamRow('frontend')).getByText('Platform Eng')).toBeInTheDocument(),
        );
    });

    it('surfaces a failed edit inside the modal and keeps it open with the draft intact', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).includes('/api/admin/teams/') && method === 'PATCH') {
                return json({message: 'Team is archived'}, 409);
            }
            return base!(url, init);
        });

        renderPage(<AdminTeams />);
        await waitForTableLoaded();
        openEditTeamModal('frontend');
        fireEvent.change(screen.getByLabelText('Department'), {target: {value: 'Platform Eng'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));

        expect(await screen.findByText(/Team is archived/)).toBeInTheDocument();
        // The dialog stays open with the admin's values — a failed write must not
        // discard the draft or leave the failure invisible behind a closed modal.
        expect(screen.getByRole('dialog', {name: 'Edit team — frontend'})).toBeInTheDocument();
        expect((screen.getByLabelText('Department') as HTMLInputElement).value).toBe('Platform Eng');
    });

    it('archive and restore stay inline — a single action, not a form', async () => {
        renderPage(<AdminTeams />);
        await waitForTableLoaded();

        fireEvent.click(within(teamRow('platform')).getByRole('button', {name: 'Archive'}));
        await waitFor(() => expect(teamPatches('platform')).toHaveLength(1));
        expect(sentBody(teamPatches('platform')[0])).toEqual({archived: true});
        // No dialog was involved, and the row reflects the new state.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(await within(teamRow('platform')).findByText('Archived')).toBeInTheDocument();

        fireEvent.click(within(teamRow('platform')).getByRole('button', {name: 'Restore'}));
        await waitFor(() => expect(teamPatches('platform')).toHaveLength(2));
        expect(sentBody(teamPatches('platform')[1])).toEqual({archived: false});
        await waitFor(() =>
            expect(within(teamRow('platform')).queryByText('Archived')).not.toBeInTheDocument(),
        );
    });
});
