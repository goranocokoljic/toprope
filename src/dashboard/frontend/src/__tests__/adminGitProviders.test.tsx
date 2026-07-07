// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {AdminGitProviders, parseReposList, repoScopeLabel} from '../pages/admin/AdminGitProviders';
import type {AdminGitProvider} from '../api/types';

/**
 * Tests for Admin → Git providers (GC1.8 / #200). Cover every acceptance
 * criterion: the provider-driven dynamic form (all 3 types + both app_password
 * branches), the single orange Save CTA / indigo interactive states, write-only
 * token behavior (masked + blank-keeps-existing), inline test-connection
 * success/error rendering, and read-only config rows.
 */

const DB_GITHUB: AdminGitProvider = {
    id: 'p-gh',
    source: 'db',
    type: 'github',
    container: 'acme-org',
    url: null,
    include_subgroups: null,
    auth_method: 'token',
    auth_username: null,
    token_last4: 'cdef',
    token_masked: '••••cdef',
    repos_include: '["api","web","infra"]',
    repos_exclude: '["legacy"]',
    enabled: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    last_sync_at: '2026-07-01T10:00:00.000Z',
    last_sync_status: 'ok',
    last_sync_error: null,
};

const CONFIG_GITLAB: AdminGitProvider = {
    id: 'config:gitlab:team',
    source: 'config',
    type: 'gitlab',
    container: 'team',
    url: 'https://gitlab.example.com',
    include_subgroups: true,
    auth_method: 'personal_access_token',
    auth_username: null,
    token_last4: null,
    token_masked: '••••',
    repos_include: '["a","b"]',
    repos_exclude: null,
    enabled: true,
    created_at: null,
    updated_at: null,
    created_by: null,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_error: null,
};

let providers: AdminGitProvider[];
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

beforeEach(() => {
    providers = [structuredClone(DB_GITHUB), structuredClone(CONFIG_GITLAB)];

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        // Draft test — POST /test (no id). Return failure when the container says so.
        if (/\/git\/providers\/test$/.test(u) && method === 'POST') {
            if (String(body.container).includes('bad')) {
                return json({ok: false, error: 'Bad credentials', hint: 'Check the token scopes'});
            }
            return json({ok: true});
        }
        // Saved test — POST /:id/test.
        if (/\/git\/providers\/[^/]+\/test$/.test(u) && method === 'POST') {
            return json({ok: true});
        }
        // Sync — POST /:id/sync.
        if (/\/git\/providers\/[^/]+\/sync$/.test(u) && method === 'POST') {
            return json({data: {provider_id: 'p-gh', status: 'running', started_at: '2026-07-07T00:00:00.000Z'}}, 202);
        }
        // Create.
        if (/\/git\/providers$/.test(u) && method === 'POST') {
            const created: AdminGitProvider = {
                ...DB_GITHUB,
                id: 'p-new',
                type: body.type as AdminGitProvider['type'],
                container: String(body.container),
                auth_method: String(body.auth_method),
            };
            providers = [...providers, created];
            return json({data: created}, 201);
        }
        // Update (PATCH /:id).
        if (/\/git\/providers\/[^/]+$/.test(u) && method === 'PATCH') {
            return json({data: {...DB_GITHUB, enabled: body.enabled as boolean ?? true}});
        }
        // Delete.
        if (/\/git\/providers\/[^/]+$/.test(u) && method === 'DELETE') {
            return json({data: {id: 'p-gh', deleted: true}});
        }
        // List.
        if (/\/git\/providers$/.test(u)) {
            return json({data: providers});
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
                <AdminGitProviders />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

function lastCall(pattern: RegExp, method: string): [unknown, RequestInit | undefined] | undefined {
    return [...fetchMock.mock.calls]
        .reverse()
        .find(
            (c) => pattern.test(String(c[0])) && (c[1]?.method ?? 'GET').toUpperCase() === method,
        ) as [unknown, RequestInit | undefined] | undefined;
}

describe('repoScopeLabel', () => {
    it('summarizes null as all, an array as N selected, empty as none', () => {
        expect(repoScopeLabel(null)).toBe('All repos');
        expect(repoScopeLabel('["a","b","c"]')).toBe('3 selected');
        expect(repoScopeLabel('[]')).toBe('None selected');
    });

    it('falls back to all on malformed json', () => {
        expect(repoScopeLabel('{not json')).toBe('All repos');
    });
});

describe('parseReposList', () => {
    it('parses arrays, keeps explicit empty, and returns undefined for null/malformed/non-string', () => {
        expect(parseReposList('["a","b"]')).toEqual(['a', 'b']);
        // An explicit empty list is a real "none" state — preserved, not undefined.
        expect(parseReposList('[]')).toEqual([]);
        expect(parseReposList(null)).toBeUndefined();
        expect(parseReposList('{bad')).toBeUndefined();
        expect(parseReposList('[1,2]')).toBeUndefined();
    });
});

describe('AdminGitProviders — dynamic form', () => {
    it('renders GitHub fields by default (single auth method, no selector)', () => {
        renderPage();
        expect(screen.getByLabelText('Organization')).toBeInTheDocument();
        expect(screen.getByLabelText('Token')).toBeInTheDocument();
        // GitHub has one auth method → no auth-method selector.
        expect(screen.queryByRole('combobox', {name: 'Auth method'})).not.toBeInTheDocument();
    });

    it('renders the Bitbucket app_password two-field case, and drops the username on other methods', () => {
        renderPage();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'bitbucket'}});
        // Container label switches to Workspace.
        expect(screen.getByLabelText('Workspace')).toBeInTheDocument();
        // Default method is app_password → username + "App password" fields.
        expect(screen.getByLabelText('Username')).toBeInTheDocument();
        expect(screen.getByLabelText('App password')).toBeInTheDocument();
        // Switch to access_token → username disappears, field becomes "Token".
        fireEvent.change(screen.getByRole('combobox', {name: 'Auth method'}), {target: {value: 'access_token'}});
        expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Token')).toBeInTheDocument();
    });

    it('renders GitLab self-hosted url + include-subgroups toggle', () => {
        renderPage();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'gitlab'}});
        expect(screen.getByLabelText('Group')).toBeInTheDocument();
        expect(screen.getByLabelText('Self-hosted URL (optional)')).toBeInTheDocument();
        expect(screen.getByText('Include subgroups')).toBeInTheDocument();
        expect(screen.getByRole('combobox', {name: 'Auth method'})).toBeInTheDocument();
    });
});

describe('AdminGitProviders — color system', () => {
    it('Save is the orange primary CTA and Test connection is indigo (accent)', () => {
        renderPage();
        expect(screen.getByRole('button', {name: 'Save'}).className).toContain('bg-primary');
        expect(screen.getByRole('button', {name: 'Test connection'}).className).toContain('accent');
    });
});

describe('AdminGitProviders — create + test', () => {
    it('creates a provider via POST with the form values', async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'new-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));

        await waitFor(() => {
            const post = lastCall(/\/git\/providers$/, 'POST');
            expect(post).toBeTruthy();
            const sent = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
            expect(sent.type).toBe('github');
            expect(sent.container).toBe('new-org');
            expect(sent.token).toBe('ghp_secret');
        });
    });

    it('shows an inline success then an error+hint from the draft test', async () => {
        renderPage();
        // Success path.
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'good-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'tok'}});
        fireEvent.click(screen.getByRole('button', {name: 'Test connection'}));
        expect(await screen.findByText(/Connection successful/)).toBeInTheDocument();

        // Error path surfaces the API error message + remediation hint.
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'bad-org'}});
        fireEvent.click(screen.getByRole('button', {name: 'Test connection'}));
        expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();
        expect(screen.getByText('Check the token scopes')).toBeInTheDocument();
    });

    it('disables Test connection until a token is entered', () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'org'}});
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'tok'}});
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeEnabled();
    });

    it('requires a username before Save/Test for Bitbucket app_password', () => {
        renderPage();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'bitbucket'}});
        fireEvent.change(screen.getByLabelText('Workspace'), {target: {value: 'ws'}});
        fireEvent.change(screen.getByLabelText('App password'), {target: {value: 'pw'}});
        // Username still blank → both CTAs stay disabled (server would 400).
        expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled();
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Username'), {target: {value: 'bob'}});
        expect(screen.getByRole('button', {name: 'Save'})).toBeEnabled();
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeEnabled();
    });
});

describe('AdminGitProviders — list + row actions', () => {
    it('lists DB and config providers with masked tokens and repo scope', async () => {
        renderPage();
        expect(await screen.findByText('acme-org')).toBeInTheDocument();
        expect(screen.getByText('••••cdef')).toBeInTheDocument();
        // Config provider row: masked, repo scope "2 selected", read-only badge.
        expect(screen.getByText('2 selected')).toBeInTheDocument();
        expect(screen.getByText('Config')).toBeInTheDocument();
    });

    it('config rows are read-only: no Edit or Remove, but Test is offered', async () => {
        renderPage();
        const configCell = await screen.findByText('team');
        const row = configCell.closest('tr');
        expect(row).not.toBeNull();
        const utils = within(row as HTMLElement);
        expect(utils.queryByRole('button', {name: 'Edit'})).not.toBeInTheDocument();
        expect(utils.queryByRole('button', {name: 'Remove'})).not.toBeInTheDocument();
        expect(utils.queryByRole('button', {name: 'Sync now'})).not.toBeInTheDocument();
        expect(utils.getByRole('button', {name: 'Test'})).toBeInTheDocument();
    });

    it('editing a DB row keeps the token when left blank (PATCH omits token)', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org');
        const row = ghCell.closest('tr') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', {name: 'Edit'}));

        // The form prefills the container and shows a "keep existing" masked hint.
        expect(screen.getByPlaceholderText(/Leave blank to keep ••••cdef/)).toBeInTheDocument();
        // Save without touching the token → PATCH with no token field.
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        await waitFor(() => {
            const patch = lastCall(/\/git\/providers\/p-gh$/, 'PATCH');
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            expect(sent).not.toHaveProperty('token');
            expect(sent.container).toBe('acme-org');
            // The full-replace PATCH must carry the existing repo scope so it
            // isn't silently wiped back to "monitor all".
            expect(sent.repos).toEqual(['api', 'web', 'infra']);
            expect(sent.exclude_repos).toEqual(['legacy']);
        });
    });

    it('removes a DB provider via DELETE', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org');
        const row = ghCell.closest('tr') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', {name: 'Remove'}));
        await waitFor(() => {
            expect(lastCall(/\/git\/providers\/p-gh$/, 'DELETE')).toBeTruthy();
        });
    });

    it('toggles enabled via PATCH carrying the provider identity, no token', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org');
        const row = ghCell.closest('tr') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', {name: 'Enabled'}));
        await waitFor(() => {
            const patch = lastCall(/\/git\/providers\/p-gh$/, 'PATCH');
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            expect(sent.enabled).toBe(false);
            expect(sent.type).toBe('github');
            expect(sent).not.toHaveProperty('token');
            // A toggle must not wipe the repo scope (full-replace PATCH).
            expect(sent.repos).toEqual(['api', 'web', 'infra']);
            expect(sent.exclude_repos).toEqual(['legacy']);
        });
    });

    it('triggers a sync via POST /:id/sync', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org');
        const row = ghCell.closest('tr') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', {name: 'Sync now'}));
        await waitFor(() => {
            expect(lastCall(/\/git\/providers\/p-gh\/sync$/, 'POST')).toBeTruthy();
        });
    });
});
