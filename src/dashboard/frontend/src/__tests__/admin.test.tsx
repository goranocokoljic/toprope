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
import {AdminIdentities} from '../pages/admin/AdminIdentities';
import type {AdminDeveloper, AdminSubscription, AdminTeam, AdminUser} from '../api/types';

let users: AdminUser[];
let subscriptions: AdminSubscription[];
let teams: AdminTeam[];
let developers: AdminDeveloper[];
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
    // Two developers that differ in EVERY editable field — one with a fully
    // populated identity map, one with none — so a cross-row pre-fill leak has a
    // visible signal to catch. Their teams differ too, and both are real teams
    // below (the move select only offers teams that exist).
    developers = [
        {
            id: 'dev-1',
            name: 'Alice Dev',
            email: 'alice@test.com',
            team: 'frontend',
            external_ids: {
                github: 'alice-gh',
                copilot: 'alice-cp',
                claude: 'alice@claude.test',
                windsurf: 'alice@windsurf.test',
                cursor: 'alice@cursor.test',
                bitbucket: 'alice-bb',
                gitlab: 'alice-gl',
                git_emails: 'alice@work.com, alice@home.com',
            },
            created_at: '2026-01-01T00:00:00.000Z',
        },
        {
            id: 'dev-2',
            name: 'Bob Dev',
            email: null,
            team: 'platform',
            external_ids: {},
            created_at: '2026-01-02T00:00:00.000Z',
        },
    ];
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

        // Developers: both writes merge into the addressed row, so every
        // assertion below reads the row back through the real hook (seed → API →
        // row) rather than a hand-built fixture. Order matters — the two PATCH
        // routes share the GET's path prefix.
        if (u.includes('/api/admin/developers/') && u.endsWith('/identities') && method === 'PATCH') {
            const id = decodeURIComponent(u.split('/api/admin/developers/')[1].replace(/\/identities$/, ''));
            const target = developers.find((d) => d.id === id);
            if (!target) return json({message: 'No such developer'}, 404);
            // Mirrors the backend: git_emails arrives as an array and reads back
            // as the joined string the editor re-seeds from.
            const {git_emails: emails, ...ids} = body as Record<string, unknown>;
            const updated: AdminDeveloper = {
                ...target,
                external_ids: {
                    ...(ids as Record<string, string>),
                    ...(Array.isArray(emails) ? {git_emails: emails.join(', ')} : {}),
                },
            };
            developers = developers.map((d) => (d.id === id ? updated : d));
            return json({data: updated});
        }
        if (u.includes('/api/admin/developers/') && method === 'PATCH') {
            const id = decodeURIComponent(u.split('/api/admin/developers/')[1]);
            const target = developers.find((d) => d.id === id);
            if (!target) return json({message: 'No such developer'}, 404);
            const updated: AdminDeveloper = {...target, team: String(body.team)};
            developers = developers.map((d) => (d.id === id ? updated : d));
            return json({data: updated});
        }
        if (u.includes('/api/admin/developers')) {
            return json({data: developers});
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
 * Drive the whole create flow: open the modal, wait for the roster, fill the
 * email, submit. The modal closes on success, so a second create must open it
 * again — the fields no longer survive a create (they unmount with the dialog).
 *
 * The roster await is not ceremony: Save is gated until the developer list
 * lands, because `developerId` is '' until then and '' is also the legitimate
 * "— none —", so an early submit would silently create an unlinked user. Tests
 * that intend to drive the GATE itself call `openCreateUserModal` directly.
 */
async function createUser(email: string): Promise<void> {
    openCreateUserModal();
    await screen.findByRole('option', {name: 'Alice Dev'});
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

/** Every create-user POST the page sent, in order. */
function userPosts(): [unknown, RequestInit?][] {
    return fetchMock.mock.calls.filter(
        (c) =>
            String(c[0]).includes('/api/admin/users') && (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
    ) as [unknown, RequestInit?][];
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

/** The `<tr>` for a developer, so a row's own controls can be addressed unambiguously. */
function developerRow(name: string): HTMLElement {
    const cell = screen.getByText(name).closest('tr');
    if (!cell) throw new Error(`No row for developer ${name}`);
    return cell;
}

/** Open a specific developer row's identity dialog, and wait for the team options. */
async function openEditIdentityModal(name: string): Promise<void> {
    fireEvent.click(within(developerRow(name)).getByRole('button', {name: 'Edit'}));
    // The teams load WITH the dialog, and a select can't hold a value with no
    // matching option — wait for them before driving the move control.
    await screen.findByRole('option', {name: 'frontend'});
}

/** Every identity PATCH sent for a developer, in order. */
function identityPatches(id: string): [unknown, RequestInit?][] {
    return fetchMock.mock.calls.filter(
        (c) =>
            String(c[0]).endsWith(`/api/admin/developers/${id}/identities`) &&
            (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
    ) as [unknown, RequestInit?][];
}

/** Every team-move PATCH sent for a developer, in order. */
function movePatches(id: string): [unknown, RequestInit?][] {
    return fetchMock.mock.calls.filter(
        (c) =>
            String(c[0]).endsWith(`/api/admin/developers/${id}`) &&
            (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
    ) as [unknown, RequestInit?][];
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
        await createUser('  padded@test.com  ');

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

    it('cannot create while the roster is still loading — the link is create-time-only', async () => {
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
        fireEvent.change(screen.getByLabelText('Email'), {target: {value: 'racer@test.com'}});

        // developerId is '' until the roster lands, and '' is ALSO "— none —" —
        // so submitting here would silently create an unlinked user, and no row
        // control can link one afterwards. Save must wait for the roster.
        const save = screen.getByRole('button', {name: 'Create user'});
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(userPosts()).toHaveLength(0);

        releaseDevelopers?.();
        await screen.findByRole('option', {name: 'Alice Dev'});
        expect(save).toBeEnabled();
    });

    it('keeps the developer link gated when the roster FAILS to load — not an enabled "— none —"', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/api/admin/developers') && method === 'GET') {
                return json({message: 'boom'}, 500);
            }
            return base!(url, init);
        });

        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        openCreateUserModal();

        // A failed query settles to isPending === false with no data. Gating on
        // isPending alone would flip the select to an ENABLED list whose only
        // option is "— none —" — indistinguishable from "there are no
        // developers", which is what invites the unintended unlinked create.
        const select = await screen.findByLabelText('Linked developer');
        expect(await screen.findByRole('option', {name: 'Couldn’t load developers'})).toBeInTheDocument();
        expect(select).toBeDisabled();
        expect(screen.queryByRole('option', {name: '— none —'})).not.toBeInTheDocument();
        // Positive control: the roster really did fail, so nothing loaded.
        expect(screen.queryByRole('option', {name: 'Alice Dev'})).not.toBeInTheDocument();
    });

    it('the one-time temp password survives the modal closing, shows once, and is dismissible', async () => {
        renderPage(<AdminUsers />);
        await screen.findByText('admin@test.com');
        await createUser('new@test.com');

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
        // Settle the roster first, so this test isolates the EMAIL gate — Save is
        // independently gated while the developer list is in flight (see the
        // create-time-only link test above).
        await screen.findByRole('option', {name: 'Alice Dev'});

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
        await createUser('new@test.com');
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
        await createUser('dupe@test.com');

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

    it('keeps the developer select gated when the roster FAILS to load — not an enabled "Select…"', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/api/admin/developers') && method === 'GET') {
                return json({message: 'boom'}, 500);
            }
            return base!(url, init);
        });

        renderPage(<AdminSubscriptions />);
        await waitForTableLoaded();
        fireEvent.click(screen.getByRole('button', {name: '＋ Assign subscription'}));

        const select = await screen.findByLabelText('Developer');
        expect(await screen.findByRole('option', {name: 'Couldn’t load developers'})).toBeInTheDocument();
        expect(select).toBeDisabled();
        expect(screen.queryByRole('option', {name: 'Select…'})).not.toBeInTheDocument();
        expect(screen.queryByRole('option', {name: 'Alice Dev'})).not.toBeInTheDocument();
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

        // The other row must show ITS OWN values — a leaked draft here would mean
        // the fields survived the close. (The conditional render unmounts the body
        // on every close, so this passes on that alone; the key={editing?.name}
        // remount is defence-in-depth for a row⇄row swap with no close between.)
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

    it('no close affordance works while the create is in flight — the POST cannot land invisibly', async () => {
        let releasePost: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releasePost = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/api/admin/teams') && method === 'POST') await gate;
            return base!(url, init);
        });

        renderPage(<AdminTeams />);
        await waitForTableLoaded();
        openCreateTeamModal();
        fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'growth'}});
        fireEvent.click(screen.getByRole('button', {name: 'Create team'}));
        // The create path has its OWN pending wiring: assert it here rather than
        // trusting the edit path's guard to speak for both modes.
        expect(await screen.findByRole('button', {name: 'Creating…'})).toBeInTheDocument();

        const dialogName = 'Create team';
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

        // A second click while pending must not fire a duplicate POST.
        fireEvent.click(screen.getByRole('button', {name: 'Creating…'}));

        releasePost?.();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(
            fetchMock.mock.calls.filter(
                (c) =>
                    String(c[0]).endsWith('/api/admin/teams') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
            ),
        ).toHaveLength(1);
        expect(await screen.findByText('growth')).toBeInTheDocument();
    });

    it('surfaces a failed create inside the modal and keeps it open with the draft intact', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/api/admin/teams') && method === 'POST') {
                return json({message: 'Team already exists'}, 409);
            }
            return base!(url, init);
        });

        renderPage(<AdminTeams />);
        await waitForTableLoaded();
        openCreateTeamModal();
        fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'frontend'}});
        fireEvent.click(screen.getByRole('button', {name: 'Create team'}));

        // The inline create card surfaced its write error; the modal must too.
        expect(await screen.findByText(/Team already exists/)).toBeInTheDocument();
        expect(screen.getByRole('dialog', {name: 'Create team'})).toBeInTheDocument();
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('frontend');
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

describe('AdminIdentities page', () => {
    it('paginates the developer table at 25 rows per page', async () => {
        developers = Array.from({length: 30}, (_, i) => ({
            id: `dev-${String(i).padStart(2, '0')}`,
            name: `Dev ${String(i).padStart(2, '0')}`,
            email: `dev${i}@test.com`,
            team: 'frontend',
            external_ids: {},
            created_at: '2026-01-01T00:00:00.000Z',
        }));
        renderPage(<AdminIdentities />);
        await screen.findByText('Dev 00');

        expect(document.querySelectorAll('tbody tr')).toHaveLength(25);
        expect(screen.queryByText('Dev 25')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(document.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(screen.getByText('Dev 29')).toBeInTheDocument();
        expect(screen.queryByText('Dev 00')).not.toBeInTheDocument();
    });

    it('renders the developer list — not an editor card — and no editor until a row asks for one', async () => {
        renderPage(<AdminIdentities />);
        await waitForTableLoaded();

        // The page is the table (criterion 1). The old "Select a developer" box
        // whose only job was to reveal the editor is gone...
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Developer')).not.toBeInTheDocument();
        // ...and so is every field it revealed: the ONLY editable control
        // anywhere on the page is inside a dialog.
        expect(screen.queryByLabelText('GitHub username')).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', {name: 'Save identities'})).not.toBeInTheDocument();
        expect(screen.queryByRole('button', {name: 'Move developer'})).not.toBeInTheDocument();

        // Both developers are listed, with their link counts read off the row.
        expect(within(developerRow('Alice Dev')).getByText('frontend')).toBeInTheDocument();
        expect(within(developerRow('Alice Dev')).getByText('8 linked')).toBeInTheDocument();
        expect(within(developerRow('Bob Dev')).getByText('None')).toBeInTheDocument();

        // The row's edit affordance announces that it opens a dialog (epic criterion 2).
        expect(within(developerRow('Alice Dev')).getByRole('button', {name: 'Edit'})).toHaveAttribute(
            'aria-haspopup',
            'dialog',
        );
    });

    it('edits only via the row modal: pre-filled, PATCHes the card shape, and success closes it and refreshes the row', async () => {
        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Alice Dev');

        // Every field the card carried is pre-filled from the row (criterion 2).
        expect(screen.getByRole('dialog', {name: 'Identities — Alice Dev'})).toBeInTheDocument();
        expect((screen.getByLabelText('Copilot username') as HTMLInputElement).value).toBe('alice-cp');
        expect((screen.getByLabelText('Claude Code email') as HTMLInputElement).value).toBe('alice@claude.test');
        expect((screen.getByLabelText('Windsurf email') as HTMLInputElement).value).toBe('alice@windsurf.test');
        expect((screen.getByLabelText('Cursor email') as HTMLInputElement).value).toBe('alice@cursor.test');
        expect((screen.getByLabelText('GitHub username') as HTMLInputElement).value).toBe('alice-gh');
        expect((screen.getByLabelText('Bitbucket username') as HTMLInputElement).value).toBe('alice-bb');
        expect((screen.getByLabelText('GitLab username') as HTMLInputElement).value).toBe('alice-gl');
        expect((screen.getByLabelText('Git commit emails (comma-separated)') as HTMLInputElement).value).toBe(
            'alice@work.com, alice@home.com',
        );
        expect((screen.getByLabelText('Team') as HTMLSelectElement).value).toBe('frontend');

        fireEvent.change(screen.getByLabelText('GitHub username'), {target: {value: 'alice-renamed'}});
        fireEvent.change(screen.getByLabelText('Git commit emails (comma-separated)'), {
            target: {value: 'a@x.com,  b@y.com   c@z.com'},
        });
        // Also drop a link, so the row's count MUST change if the save landed —
        // an edit that leaves all 8 populated would read the same before and
        // after, and the read-back assertion below could not fail.
        fireEvent.change(screen.getByLabelText('Bitbucket username'), {target: {value: ''}});
        fireEvent.click(screen.getByRole('button', {name: 'Save identities'}));

        await waitFor(() => expect(identityPatches('dev-1')).toHaveLength(1));
        // Exactly the shape the card's Save sent: every id field, and the email
        // box split on commas AND whitespace into individual addresses.
        expect(sentBody(identityPatches('dev-1')[0])).toEqual({
            github: 'alice-renamed',
            copilot: 'alice-cp',
            claude: 'alice@claude.test',
            windsurf: 'alice@windsurf.test',
            cursor: 'alice@cursor.test',
            bitbucket: '',
            gitlab: 'alice-gl',
            git_emails: ['a@x.com', 'b@y.com', 'c@z.com'],
        });
        // Addressed to THIS developer only, and not through the move route.
        expect(identityPatches('dev-2')).toHaveLength(0);
        expect(movePatches('dev-1')).toHaveLength(0);

        // Success closes the dialog and the row reads back through the real hook
        // (seed → API → row): the cleared bitbucket drops 8 links to 7.
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await waitFor(() =>
            expect(within(developerRow('Alice Dev')).getByText('7 linked')).toBeInTheDocument(),
        );
    });

    it('every field writes to its own identity key — no crossed wiring', async () => {
        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Bob Dev');

        // Bob starts with nothing linked, so each key's value can only have come
        // from the box typed into it. Pre-fill assertions prove the READ side;
        // this proves the WRITE side, where a copy-pasted onChange would send
        // e.g. the Cursor box's value as `windsurf` and go unnoticed.
        const typed: [string, string][] = [
            ['Copilot username', 'v-copilot'],
            ['Claude Code email', 'v-claude'],
            ['Windsurf email', 'v-windsurf'],
            ['Cursor email', 'v-cursor'],
            ['GitHub username', 'v-github'],
            ['Bitbucket username', 'v-bitbucket'],
            ['GitLab username', 'v-gitlab'],
            ['Git commit emails (comma-separated)', 'v-email@x.com'],
        ];
        for (const [label, value] of typed) {
            fireEvent.change(screen.getByLabelText(label), {target: {value}});
        }
        fireEvent.click(screen.getByRole('button', {name: 'Save identities'}));

        await waitFor(() => expect(identityPatches('dev-2')).toHaveLength(1));
        expect(sentBody(identityPatches('dev-2')[0])).toEqual({
            copilot: 'v-copilot',
            claude: 'v-claude',
            windsurf: 'v-windsurf',
            cursor: 'v-cursor',
            github: 'v-github',
            bitbucket: 'v-bitbucket',
            gitlab: 'v-gitlab',
            git_emails: ['v-email@x.com'],
        });
        // All 8 now read back on the row that had none.
        await waitFor(() =>
            expect(within(developerRow('Bob Dev')).getByText('8 linked')).toBeInTheDocument(),
        );
    });

    it('clearing the email box sends an empty set and the row reflects the lost link', async () => {
        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Alice Dev');

        fireEvent.change(screen.getByLabelText('Git commit emails (comma-separated)'), {target: {value: '   '}});
        fireEvent.click(screen.getByRole('button', {name: 'Save identities'}));

        await waitFor(() => expect(identityPatches('dev-1')).toHaveLength(1));
        // An empty box clears the set — not a [''] with one blank member.
        expect(sentBody(identityPatches('dev-1')[0]).git_emails).toEqual([]);
        await waitFor(() =>
            expect(within(developerRow('Alice Dev')).getByText('7 linked')).toBeInTheDocument(),
        );
    });

    it('pre-fills each row independently — switching developers remounts clean fields', async () => {
        renderPage(<AdminIdentities />);
        await waitForTableLoaded();

        // Edit one row, type something, abandon it.
        await openEditIdentityModal('Alice Dev');
        fireEvent.change(screen.getByLabelText('GitHub username'), {target: {value: 'typed but abandoned'}});
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // The other developer must show THEIR OWN values — a leaked draft here
        // would mean the fields survived the close.
        await openEditIdentityModal('Bob Dev');
        expect(screen.getByRole('dialog', {name: 'Identities — Bob Dev'})).toBeInTheDocument();
        expect((screen.getByLabelText('GitHub username') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Copilot username') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Git commit emails (comma-separated)') as HTMLInputElement).value).toBe('');
        // ...including the team, which is Bob's, not Alice's.
        expect((screen.getByLabelText('Team') as HTMLSelectElement).value).toBe('platform');
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // Back to the first row: the abandoned draft is gone, re-seeded from the row.
        await openEditIdentityModal('Alice Dev');
        expect((screen.getByLabelText('GitHub username') as HTMLInputElement).value).toBe('alice-gh');

        // Abandoning a draft never wrote anything.
        expect(identityPatches('dev-1')).toHaveLength(0);
        expect(identityPatches('dev-2')).toHaveLength(0);
    });

    it('moves a developer as its own request — gated until the team actually changes', async () => {
        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Alice Dev');

        // Preserved from the card: an unchanged team can't send a no-op move.
        expect(screen.getByRole('button', {name: 'Move developer'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Team'), {target: {value: 'platform'}});
        expect(screen.getByRole('button', {name: 'Move developer'})).toBeEnabled();
        // Selecting the original team back is no longer a change.
        fireEvent.change(screen.getByLabelText('Team'), {target: {value: 'frontend'}});
        expect(screen.getByRole('button', {name: 'Move developer'})).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Team'), {target: {value: 'platform'}});
        fireEvent.click(screen.getByRole('button', {name: 'Move developer'}));

        await waitFor(() => expect(movePatches('dev-1')).toHaveLength(1));
        // The move is its own PATCH — it never rides along with the identity map.
        expect(sentBody(movePatches('dev-1')[0])).toEqual({team: 'platform'});
        expect(identityPatches('dev-1')).toHaveLength(0);

        // A successful write closes the modal and the row reads back (epic criterion 5).
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await waitFor(() =>
            expect(within(developerRow('Alice Dev')).getByText('platform')).toBeInTheDocument(),
        );
    });

    it('offers only active teams as move targets, plus the developer own archived team', async () => {
        teams = [
            ...teams,
            {
                name: 'legacy',
                department: null,
                manager: null,
                created_at: '2026-01-01T00:00:00.000Z',
                archived_at: '2026-02-01T00:00:00.000Z',
                developer_count: 1,
            },
        ];
        developers = developers.map((d) => (d.id === 'dev-2' ? {...d, team: 'legacy'} : d));

        renderPage(<AdminIdentities />);
        await waitForTableLoaded();

        // An archived team is not a move target for someone else...
        await openEditIdentityModal('Alice Dev');
        expect(screen.queryByRole('option', {name: 'legacy'})).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // ...but it stays listed for the developer who is IN it, or the select
        // would render their own team as no selection at all.
        await openEditIdentityModal('Bob Dev');
        expect(screen.getByRole('option', {name: 'legacy'})).toBeInTheDocument();
        expect((screen.getByLabelText('Team') as HTMLSelectElement).value).toBe('legacy');
    });

    it('no close affordance works while the identity save is in flight — the PATCH cannot land invisibly', async () => {
        let releasePatch: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releasePatch = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/identities') && method === 'PATCH') await gate;
            return base!(url, init);
        });

        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Alice Dev');
        fireEvent.change(screen.getByLabelText('GitHub username'), {target: {value: 'alice-renamed'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save identities'}));
        expect(await screen.findByRole('button', {name: 'Saving…'})).toBeInTheDocument();

        // Cancel, Esc, ×, and a genuine backdrop click are all inert mid-write.
        const dialogName = 'Identities — Alice Dev';
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        const backdrop = screen.getByTestId('identity-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();

        // A second click while pending must not fire a duplicate PATCH.
        fireEvent.click(screen.getByRole('button', {name: 'Saving…'}));

        releasePatch?.();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(identityPatches('dev-1')).toHaveLength(1);
    });

    it('no close affordance works while the MOVE is in flight — the move has its own pending guard', async () => {
        let releasePatch: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releasePatch = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/api/admin/developers/dev-1') && method === 'PATCH') await gate;
            return base!(url, init);
        });

        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Alice Dev');
        fireEvent.change(screen.getByLabelText('Team'), {target: {value: 'platform'}});
        fireEvent.click(screen.getByRole('button', {name: 'Move developer'}));

        // The move is the OTHER write path: assert its own pending wiring rather
        // than trusting Save's guard to speak for it.
        expect(await screen.findByRole('button', {name: 'Moving…'})).toBeInTheDocument();
        const dialogName = 'Identities — Alice Dev';
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        const backdrop = screen.getByTestId('identity-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog', {name: dialogName})).toBeInTheDocument();
        // Save is inert too — an in-flight move must not let the other write start.
        expect(screen.getByRole('button', {name: 'Save identities'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button', {name: 'Save identities'}));
        expect(identityPatches('dev-1')).toHaveLength(0);

        releasePatch?.();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(movePatches('dev-1')).toHaveLength(1);
    });

    it('surfaces a failed save inside the modal and keeps it open with the draft intact', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/identities') && method === 'PATCH') {
                return json({message: 'Identity already mapped to another developer'}, 409);
            }
            return base!(url, init);
        });

        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Alice Dev');
        fireEvent.change(screen.getByLabelText('GitHub username'), {target: {value: 'taken-by-bob'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save identities'}));

        // The card surfaced its write error; the modal must too — the backend
        // rejecting a duplicate git identity is the whole point of this screen.
        expect(await screen.findByText(/Identity already mapped to another developer/)).toBeInTheDocument();
        // The dialog stays open with the admin's values.
        expect(screen.getByRole('dialog', {name: 'Identities — Alice Dev'})).toBeInTheDocument();
        expect((screen.getByLabelText('GitHub username') as HTMLInputElement).value).toBe('taken-by-bob');
    });

    it('surfaces a failed move inside the modal without discarding the identity draft', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/api/admin/developers/dev-1') && method === 'PATCH') {
                return json({message: 'Team is archived'}, 409);
            }
            return base!(url, init);
        });

        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        await openEditIdentityModal('Alice Dev');
        fireEvent.change(screen.getByLabelText('GitHub username'), {target: {value: 'alice-renamed'}});
        fireEvent.change(screen.getByLabelText('Team'), {target: {value: 'platform'}});
        fireEvent.click(screen.getByRole('button', {name: 'Move developer'}));

        expect(await screen.findByText(/Team is archived/)).toBeInTheDocument();
        expect(screen.getByRole('dialog', {name: 'Identities — Alice Dev'})).toBeInTheDocument();
        // A failed move must not throw away the identity edits typed alongside it.
        expect((screen.getByLabelText('GitHub username') as HTMLInputElement).value).toBe('alice-renamed');
    });

    it('gates the Team select while the roster loads, keeping the developer’s current team', async () => {
        let releaseTeams: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseTeams = resolve;
        });
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            if (String(url).includes('/api/admin/teams')) await gate;
            return base!(url, init);
        });

        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        // Deliberately NOT openEditIdentityModal: that helper awaits the options
        // and would step straight past the window this test exists to check.
        fireEvent.click(within(developerRow('Alice Dev')).getByRole('button', {name: 'Edit'}));

        // While the teams load the control is inert, and its placeholder still
        // carries Alice's CURRENT team as the value — an enabled empty select
        // would read as "Alice has no team", and a blank value would mis-seed
        // the Move below.
        const select = (await screen.findByLabelText('Team')) as HTMLSelectElement;
        expect(select).toBeDisabled();
        expect(screen.getByRole('option', {name: 'Loading teams…'})).toBeInTheDocument();
        expect(select.value).toBe('frontend');
        expect(screen.getByRole('button', {name: 'Move developer'})).toBeDisabled();

        releaseTeams?.();
        await screen.findByRole('option', {name: 'platform'});
        expect(select).toBeEnabled();
        expect(select.value).toBe('frontend');
    });

    it('keeps the Team select gated when the team roster FAILS to load', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).includes('/api/admin/teams') && method === 'GET') {
                return json({message: 'boom'}, 500);
            }
            return base!(url, init);
        });

        renderPage(<AdminIdentities />);
        await waitForTableLoaded();
        fireEvent.click(within(developerRow('Alice Dev')).getByRole('button', {name: 'Edit'}));

        const select = (await screen.findByLabelText('Team')) as HTMLSelectElement;
        expect(await screen.findByRole('option', {name: 'Couldn’t load teams'})).toBeInTheDocument();
        expect(select).toBeDisabled();
        expect(select.value).toBe('frontend');
        // Positive control: the roster really did fail, so no real team loaded.
        expect(screen.queryByRole('option', {name: 'platform'})).not.toBeInTheDocument();
    });

    it('surfaces a failed developer load instead of an empty table', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (String(url).endsWith('/api/admin/developers') && method === 'GET') {
                return json({message: 'boom'}, 500);
            }
            return base!(url, init);
        });

        renderPage(<AdminIdentities />);

        expect(await screen.findByText(/Failed to load/)).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
});
