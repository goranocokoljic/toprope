// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {AdminGitProviders, parseReposList, repoScopeLabel, syncProgressLabel} from '../pages/admin/AdminGitProviders';
import {gitProvidersRefetchInterval} from '../hooks/useAdmin';
import type {AdminGitProvider, GitSyncProgress, GitSyncStage} from '../api/types';

/**
 * Tests for Admin → Git providers (GC1.8 / #200 + GC1.9 / #201). Cover every
 * acceptance criterion: the provider-driven dynamic form (all 3 types + both
 * app_password branches), the single orange Save CTA / indigo interactive states,
 * write-only token behavior (masked + blank-keeps-existing), inline
 * test-connection success/error rendering, read-only config rows, the per-provider
 * repo-scope editor (all-vs-select payloads + archived-default), and the
 * cold-start empty-state onboarding.
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
    active_sync: null,
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
    active_sync: null,
};

/** A DB provider with no repo filter — the "monitor all" starting point (#201). */
const DB_MONITOR_ALL: AdminGitProvider = {
    ...DB_GITHUB,
    id: 'p-all',
    container: 'mono-org',
    repos_include: null,
    repos_exclude: null,
};

interface RepoRow {
    name: string;
    archived: boolean;
    defaultBranch: string | null;
}

interface DataSourceGitProvider {
    provider: string;
    connected: boolean;
    developer_count: number;
    last_sync: string | null;
}

let providers: AdminGitProvider[];
let repos: RepoRow[];
let dataSourceGitProviders: DataSourceGitProvider[];
let fetchMock: Mock;
// Counts POST /git/providers calls: the first create gets the well-known id
// 'p-new' (many assertions reference it); later creates get distinct ids so
// multi-create flows are testable (no duplicate React keys).
let createCount: number;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

beforeEach(() => {
    createCount = 0;
    providers = [structuredClone(DB_GITHUB), structuredClone(CONFIG_GITLAB)];
    repos = [
        {name: 'api', archived: false, defaultBranch: 'main'},
        {name: 'web', archived: false, defaultBranch: 'main'},
        {name: 'legacy', archived: true, defaultBranch: 'master'},
    ];
    // Default: no git snapshots collected yet (drives the empty-state gate).
    dataSourceGitProviders = [];

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        // Repo listing — GET /:id/repos (checked before the generic list route).
        if (/\/git\/providers\/[^/]+\/repos$/.test(u) && method === 'GET') {
            return json({data: repos});
        }
        // Data sources — drives the empty-state "no snapshots" signal.
        if (/\/admin\/data-sources$/.test(u) && method === 'GET') {
            return json({data: {connectors: [], git_providers: dataSourceGitProviders}});
        }
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
        // Create. A fresh provider has no repo filter (monitor all) and no
        // sync history — mirrors the server's create response.
        if (/\/git\/providers$/.test(u) && method === 'POST') {
            createCount += 1;
            const created: AdminGitProvider = {
                ...DB_GITHUB,
                id: createCount === 1 ? 'p-new' : `p-new-${createCount}`,
                type: body.type as AdminGitProvider['type'],
                container: String(body.container),
                auth_method: String(body.auth_method),
                repos_include: null,
                repos_exclude: null,
                last_sync_at: null,
                last_sync_status: null,
                last_sync_error: null,
            };
            providers = [...providers, created];
            return json({data: created}, 201);
        }
        // Update (PATCH /:id) — full-row replace like the server: apply the sent
        // scope/enabled to the stored row so post-save refetches see the result.
        if (/\/git\/providers\/[^/]+$/.test(u) && method === 'PATCH') {
            const id = decodeURIComponent(u.split('/').pop() ?? '');
            const existing = providers.find((p) => p.id === id) ?? DB_GITHUB;
            const updated: AdminGitProvider = {
                ...existing,
                enabled: (body.enabled as boolean | undefined) ?? existing.enabled,
                repos_include: body.repos !== undefined ? JSON.stringify(body.repos) : null,
                repos_exclude:
                    body.exclude_repos !== undefined ? JSON.stringify(body.exclude_repos) : null,
            };
            providers = providers.map((p) => (p.id === id ? updated : p));
            return json({data: updated});
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
        // Default method is app_password (stored discriminant, relabeled for the
        // Atlassian API-token migration) → email + "API token" fields.
        expect(screen.getByLabelText('Atlassian account email')).toBeInTheDocument();
        expect(screen.getByLabelText('API token')).toBeInTheDocument();
        // The auth-method option is relabeled but keeps its app_password value.
        expect(screen.getByRole('option', {name: 'API token (email + token)'})).toBeInTheDocument();
        // Switch to access_token → email disappears, field becomes "Token".
        fireEvent.change(screen.getByRole('combobox', {name: 'Auth method'}), {target: {value: 'access_token'}});
        expect(screen.queryByLabelText('Atlassian account email')).not.toBeInTheDocument();
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

    it('creates a Bitbucket API-token provider keeping the app_password wire shape (email → username)', async () => {
        // The label migration is display-only: the stored discriminant stays
        // `app_password` and the Atlassian email is still sent in the `username`
        // field, so the server's Basic-auth path is unchanged.
        renderPage();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'bitbucket'}});
        fireEvent.change(screen.getByLabelText('Workspace'), {target: {value: 'my-workspace'}});
        fireEvent.change(screen.getByLabelText('Atlassian account email'), {target: {value: 'jane@company.com'}});
        fireEvent.change(screen.getByLabelText('API token'), {target: {value: 'atl_token'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));

        await waitFor(() => {
            const post = lastCall(/\/git\/providers$/, 'POST');
            expect(post).toBeTruthy();
            const sent = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
            expect(sent.type).toBe('bitbucket');
            expect(sent.auth_method).toBe('app_password');
            expect(sent.username).toBe('jane@company.com');
            expect(sent.token).toBe('atl_token');
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

    it('requires the account email before Save/Test for Bitbucket app_password', () => {
        renderPage();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'bitbucket'}});
        fireEvent.change(screen.getByLabelText('Workspace'), {target: {value: 'ws'}});
        fireEvent.change(screen.getByLabelText('API token'), {target: {value: 'pw'}});
        // Email still blank → both CTAs stay disabled (server would 400).
        expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled();
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Atlassian account email'), {target: {value: 'bob@company.com'}});
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

describe('AdminGitProviders — repo-scope editor (#201)', () => {
    it('defaults archived repos unchecked and writes only the non-archived selection', async () => {
        // A monitor-all provider: switching to "Select repositories" seeds the
        // picker with every NON-archived repo; archived ones stay unchecked.
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();

        // The Repos cell is a button showing the current scope ("All repos").
        const scopeButton = await screen.findByRole('button', {name: 'All repos'});
        fireEvent.click(scopeButton);

        // Enter select mode → triggers the /repos fetch.
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));

        // Non-archived repos are pre-checked; the archived one is not.
        const apiBox = await screen.findByRole('checkbox', {name: /api/});
        expect(apiBox).toBeChecked();
        expect(screen.getByRole('checkbox', {name: /web/})).toBeChecked();
        const legacyBox = screen.getByRole('checkbox', {name: /legacy/});
        expect(legacyBox).not.toBeChecked();

        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const patch = lastCall(/\/git\/providers\/p-all$/, 'PATCH');
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            // Selecting writes repos_include with the non-archived set only.
            expect(sent.repos).toEqual(['api', 'web']);
            // Identity carried, token never re-sent.
            expect(sent.type).toBe('github');
            expect(sent).not.toHaveProperty('token');
        });
    });

    it('lets the admin check an archived repo in explicitly', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'All repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));

        const legacyBox = await screen.findByRole('checkbox', {name: /legacy/});
        fireEvent.click(legacyBox); // opt the archived repo in
        expect(legacyBox).toBeChecked();

        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const sent = JSON.parse(
                String(lastCall(/\/git\/providers\/p-all$/, 'PATCH')?.[1]?.body),
            ) as Record<string, unknown>;
            expect(sent.repos).toEqual(['api', 'web', 'legacy']);
        });
    });

    it('clearing back to "Monitor all" removes the filter (PATCH omits repos)', async () => {
        // DB_GITHUB starts with a repos_include list → editor opens in select mode.
        renderPage();
        const scopeButton = await screen.findByRole('button', {name: '3 selected'});
        fireEvent.click(scopeButton);

        // Switch to monitor-all and save.
        fireEvent.click(screen.getByRole('radio', {name: 'Monitor all repositories'}));
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));

        await waitFor(() => {
            const patch = lastCall(/\/git\/providers\/p-gh$/, 'PATCH');
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            // Omitting `repos` clears repos_include server-side (monitor all).
            expect(sent).not.toHaveProperty('repos');
            // exclude_repos is preserved untouched (full-row replace).
            expect(sent.exclude_repos).toEqual(['legacy']);
        });
    });

    it('surfaces a repo-listing failure instead of a blank picker', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        // Make the /repos probe fail (server returns 502 on a listing error).
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/git\/providers\/[^/]+\/repos$/.test(u) && method === 'GET') {
                return json({ok: false, error: 'boom'}, 502);
            }
            if (/\/git\/providers$/.test(u) && method === 'GET') return json({data: providers});
            if (/\/admin\/data-sources$/.test(u)) {
                return json({data: {connectors: [], git_providers: dataSourceGitProviders}});
            }
            return json({error: 'not found'}, 404);
        });
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'All repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        expect(await screen.findByText(/Couldn’t load repositories/)).toBeInTheDocument();
        // Save must stay blocked: writing over a failed load would emit repos:[]
        // and silently flip the provider from "monitor all" to "analyze nothing".
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeDisabled();
        // Monitor-all is still saveable — no repo-list dependency.
        fireEvent.click(screen.getByRole('radio', {name: 'Monitor all repositories'}));
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeEnabled();
    });

    it('blocks a select-mode save until the repo list has loaded', async () => {
        // Hold the /repos response open so the list stays pending.
        let releaseRepos: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseRepos = resolve;
        });
        providers = [structuredClone(DB_MONITOR_ALL)];
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/git\/providers\/[^/]+\/repos$/.test(u) && method === 'GET') {
                await gate;
                return json({data: repos});
            }
            return base!(url, init);
        });
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'All repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        // While the list is still loading, select-mode Save is disabled.
        expect(await screen.findByText(/Loading repositories/)).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeDisabled();
        // Once it resolves, Save becomes available.
        releaseRepos?.();
        await screen.findByRole('checkbox', {name: /api/});
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeEnabled();
    });

    it('does not offer a scope editor on read-only config rows', async () => {
        renderPage();
        const configCell = await screen.findByText('team');
        const row = configCell.closest('tr') as HTMLElement;
        // Config repo scope is plain text ("2 selected"), not an editable button.
        expect(within(row).queryByRole('button', {name: '2 selected'})).not.toBeInTheDocument();
        expect(within(row).getByText('2 selected')).toBeInTheDocument();
    });
});

describe('syncProgressLabel (#209)', () => {
    const base: GitSyncProgress = {
        stage: 'fetching',
        repos_total: 12,
        repos_processed: 2,
        current_repo: 'web',
        commits_fetched: 34,
        prs_fetched: 5,
        developers_matched: 0,
    };

    it('falls back to a starting line before the first pipeline emission', () => {
        expect(syncProgressLabel({started_at: 't', progress: null})).toBe('Starting sync…');
    });

    it('labels every stage with its counters', () => {
        expect(syncProgressLabel({started_at: 't', progress: {...base, stage: 'listing_repos'}})).toBe(
            'Listing repositories…',
        );
        expect(syncProgressLabel({started_at: 't', progress: base})).toBe(
            'Fetching activity — repo 3/12 (web) · 34 commits · 5 PRs',
        );
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, stage: 'analyzing', developers_matched: 4},
            }),
        ).toBe('Matching developers — 4 matched');
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, stage: 'writing', developers_matched: 4},
            }),
        ).toBe('Writing snapshots — 4 developers matched');
    });

    it('degrades an unknown wire stage to a generic label (backend/bundle skew)', () => {
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, stage: 'replicating' as GitSyncStage},
            }),
        ).toBe('Syncing…');
    });

    it('never overshoots the repo counter on the last repo or an empty scope', () => {
        // Last repo in flight: processed 11 of 12 → position 12/12, not 13/12.
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repos_processed: 11, current_repo: 'infra'},
            }),
        ).toBe('Fetching activity — repo 12/12 (infra) · 34 commits · 5 PRs');
        // Zero repos selected: 0/0, no phantom first repo — and no repo-name
        // suffix when current_repo is null (full equality pins its absence).
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repos_total: 0, repos_processed: 0, current_repo: null},
            }),
        ).toBe('Fetching activity — repo 0/0 · 34 commits · 5 PRs');
    });
});

describe('AdminGitProviders — live sync progress (#209)', () => {
    const RUNNING_SYNC = {
        started_at: '2026-07-13T10:00:00.000Z',
        progress: {
            stage: 'fetching',
            repos_total: 12,
            repos_processed: 2,
            current_repo: 'web',
            commits_fetched: 34,
            prs_fetched: 5,
            developers_matched: 0,
        },
    } as const;

    it('shows the progress line and disables the Sync button while a run is in flight', async () => {
        providers = [{...structuredClone(DB_GITHUB), active_sync: structuredClone(RUNNING_SYNC)}];
        renderPage();
        const progress = await screen.findByTestId('sync-progress');
        expect(progress).toHaveTextContent('Fetching activity — repo 3/12 (web) · 34 commits · 5 PRs');
        expect(screen.getByRole('button', {name: 'Syncing…'})).toBeDisabled();
        expect(screen.queryByRole('button', {name: 'Sync now'})).not.toBeInTheDocument();
    });

    it('shows a starting line when the run has not emitted progress yet', async () => {
        providers = [
            {...structuredClone(DB_GITHUB), active_sync: {started_at: '2026-07-13T10:00:00.000Z', progress: null}},
        ];
        renderPage();
        expect(await screen.findByTestId('sync-progress')).toHaveTextContent('Starting sync…');
    });

    it('polls the list while a sync is running and hands the row back when it settles', async () => {
        // The stop condition itself is proven deterministically by the
        // gitProvidersRefetchInterval unit tests below — this test proves the
        // WIRING: the hook actually re-fetches on the interval while a run is
        // in flight, and the settle-observing poll clears the progress row.
        providers = [{...structuredClone(DB_GITHUB), active_sync: structuredClone(RUNNING_SYNC)}];
        renderPage();
        await screen.findByTestId('sync-progress');
        const listCalls = (): number =>
            fetchMock.mock.calls.filter(
                (c) => /\/git\/providers$/.test(String(c[0])) && (c[1]?.method ?? 'GET').toUpperCase() === 'GET',
            ).length;
        const initial = listCalls();
        // The run settles server-side: the next poll observes an idle row…
        providers = [structuredClone(DB_GITHUB)];
        await waitFor(() => expect(listCalls()).toBeGreaterThan(initial), {timeout: 3000});
        // …and the row hands back to the idle state.
        await waitFor(() => expect(screen.queryByTestId('sync-progress')).not.toBeInTheDocument());
        expect(screen.getByRole('button', {name: 'Sync now'})).toBeEnabled();
    }, 10000);

    it('gitProvidersRefetchInterval: 1s only while some row has an in-flight run', () => {
        const running = {...structuredClone(DB_GITHUB), active_sync: structuredClone(RUNNING_SYNC)};
        const idle = structuredClone(DB_GITHUB);
        expect(gitProvidersRefetchInterval([running, idle])).toBe(1000);
        expect(gitProvidersRefetchInterval([idle])).toBe(false);
        expect(gitProvidersRefetchInterval([])).toBe(false);
        expect(gitProvidersRefetchInterval(undefined)).toBe(false);
    });

    it('surfaces the server message when a duplicate trigger is rejected (409) AND refetches the list so the row picks up the in-flight run', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/git\/providers\/[^/]+\/sync$/.test(u) && method === 'POST') {
                return json(
                    {error: 'Conflict', message: 'A sync is already in progress for this provider'},
                    409,
                );
            }
            return base!(url, init);
        });
        renderPage();
        const ghCell = await screen.findByText('acme-org');
        const row = ghCell.closest('tr') as HTMLElement;
        // The run the 409 complains about IS in flight server-side: the refetch
        // the rejection triggers (onSettled invalidation) must observe it.
        providers = [{...structuredClone(DB_GITHUB), active_sync: structuredClone(RUNNING_SYNC)}];
        fireEvent.click(within(row).getByRole('button', {name: 'Sync now'}));
        expect(
            await screen.findByText('A sync is already in progress for this provider'),
        ).toBeInTheDocument();
        // The rejected trigger still invalidated the list: the row shows the
        // actual in-flight run's progress (which also bootstraps polling).
        expect(await screen.findByTestId('sync-progress')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Syncing…'})).toBeDisabled();
    });

    it('keeps the Sync button down until the refetched list lands — no double-click window after the 202', async () => {
        // Gate the list REFETCH that follows the 202 (the mount fetch passes).
        let releaseList: (() => void) | undefined;
        let listCalls = 0;
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/git\/providers$/.test(u) && method === 'GET') {
                listCalls += 1;
                if (listCalls > 1) {
                    await new Promise<void>((r) => {
                        releaseList = r;
                    });
                    return json({
                        data: [{...structuredClone(DB_GITHUB), active_sync: structuredClone(RUNNING_SYNC)}],
                    });
                }
            }
            return base!(url, init);
        });
        renderPage();
        const row = (await screen.findByText('acme-org')).closest('tr') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', {name: 'Sync now'}));

        // The POST has resolved (202) but the invalidation refetch is gated:
        // isPending must cover the refetch, so the button stays down — the gap
        // where a double-click would 409 does not exist.
        await waitFor(() => expect(releaseList).toBeDefined());
        expect(screen.getByRole('button', {name: 'Syncing…'})).toBeDisabled();
        expect(screen.queryByRole('button', {name: 'Sync now'})).not.toBeInTheDocument();

        // Once the refetch lands the row seamlessly hands off to active_sync.
        releaseList?.();
        expect(await screen.findByTestId('sync-progress')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Syncing…'})).toBeDisabled();
    });
});

describe('AdminGitProviders — add-flow repo selection (#211)', () => {
    it('auto-opens the repo-scope editor for the just-created provider, with the pre-sync prompt', async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'new-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));

        // After the create + list refetch, the NEW provider's row carries an
        // open scope editor with the prompt — announced as a status live region
        // (a regression to a plain <p> must fail here).
        const prompt = await screen.findByTestId('scope-prompt');
        expect(prompt).toHaveTextContent(/Choose which repositories to analyze before the first sync/);
        expect(screen.getByRole('status')).toBe(prompt);
        // It targets the just-created provider (its radio group), not another row.
        expect(document.querySelector('input[name="scope-p-new"]')).not.toBeNull();
        expect(document.querySelector('input[name="scope-p-gh"]')).toBeNull();
        // Default stays "Monitor all" until the admin chooses otherwise.
        expect(screen.getByRole('radio', {name: 'Monitor all repositories'})).toBeChecked();
    });

    it('closing the auto-opened editor dismisses the prompt without saving a scope', async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'new-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        await screen.findByTestId('scope-prompt');

        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('Repository scope')).not.toBeInTheDocument();
        // No PATCH was sent — the provider stays on the default monitor-all.
        expect(lastCall(/\/git\/providers\/p-new$/, 'PATCH')).toBeUndefined();
    });

    it('completes the canonical journey: create → prompt → select repos → save → prompt gone and stays gone', async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'new-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        await screen.findByTestId('scope-prompt');

        // Narrow the auto-opened editor to a single active repo and save.
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: /api/});
        fireEvent.click(screen.getByRole('button', {name: 'Clear selection'}));
        fireEvent.click(screen.getByRole('checkbox', {name: /api/}));
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));

        // The PATCH targeted the JUST-CREATED provider with the narrowed scope…
        await waitFor(() => {
            const patch = lastCall(/\/git\/providers\/p-new$/, 'PATCH');
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            expect(sent.repos).toEqual(['api']);
        });
        // …the editor and prompt close on save…
        await waitFor(() => expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument());
        expect(screen.queryByText('Repository scope')).not.toBeInTheDocument();
        // …and stay closed after the post-save list refetch lands (the flag was
        // cleared, so the refetched row must not re-prompt): the row now shows
        // the saved scope.
        expect(await screen.findByRole('button', {name: '1 selected'})).toBeInTheDocument();
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
    });

    it('closing ANOTHER row\'s scope editor does not dismiss the just-created provider\'s prompt', async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'new-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        await screen.findByTestId('scope-prompt');

        // Open the pre-existing provider's editor from its repos cell, then
        // close it the same way — the new provider's prompt must survive both.
        // The editor-count assertions prove the other row's editor really
        // opened and closed (i.e. its closeScope RAN), so this test cannot
        // pass vacuously if the toggle itself breaks.
        fireEvent.click(screen.getByRole('button', {name: '3 selected'}));
        expect(screen.getAllByText('Repository scope')).toHaveLength(2);
        expect(screen.getByTestId('scope-prompt')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: '3 selected'}));
        expect(screen.getAllByText('Repository scope')).toHaveLength(1);
        expect(screen.getByTestId('scope-prompt')).toBeInTheDocument();
        expect(document.querySelector('input[name="scope-p-new"]')).not.toBeNull();
    });

    it('creating a second provider moves the one-shot prompt to it', async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'org-a'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'tok-a'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        await screen.findByTestId('scope-prompt');
        expect(document.querySelector('input[name="scope-p-new"]')).not.toBeNull();

        // Second create (the form keeps its values; change the container).
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'org-b'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        // Exactly ONE prompt remains and it now targets the second provider.
        await waitFor(() => {
            expect(document.querySelector('input[name="scope-p-new-2"]')).not.toBeNull();
        });
        expect(screen.getAllByTestId('scope-prompt')).toHaveLength(1);
        expect(document.querySelector('input[name="scope-p-new"]')).toBeNull();
    });

    it('the repos-cell button closes the auto-opened editor and dismisses the prompt', async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'new-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        await screen.findByTestId('scope-prompt');

        // The just-created provider's repos cell reads "All repos" (only row
        // that does — the fixture row shows "3 selected").
        fireEvent.click(screen.getByRole('button', {name: 'All repos'}));
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('Repository scope')).not.toBeInTheDocument();
        // Re-opening from the same cell is a normal (non-prompted) editor, and
        // the never-saved provider is still on its "Monitor all" default.
        fireEvent.click(screen.getByRole('button', {name: 'All repos'}));
        expect(screen.getByText('Repository scope')).toBeInTheDocument();
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
        expect(screen.getByRole('radio', {name: 'Monitor all repositories'})).toBeChecked();
    });

    it('blocks saving an empty selection — the one-click Clear cannot silently disable collection', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'All repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: /api/});

        fireEvent.click(screen.getByRole('button', {name: 'Clear selection'}));
        expect(screen.getByTestId('empty-selection-warning')).toHaveTextContent(
            /Select at least one repository/,
        );
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeDisabled();
        // Ticking one repo lifts the guard and hides the warning.
        fireEvent.click(screen.getByRole('checkbox', {name: /api/}));
        expect(screen.queryByTestId('empty-selection-warning')).not.toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeEnabled();
    });

    it('does NOT auto-open the editor after editing an existing provider', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org');
        const row = ghCell.closest('tr') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', {name: 'Edit'}));
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        // Anchor on the form reverting to add mode — that proves the mutation's
        // whole onSuccess chain (invalidation → callbacks → onDone) settled, so
        // the negative assertions below cannot pass by racing it.
        expect(await screen.findByText('Add git provider')).toBeInTheDocument();
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('Repository scope')).not.toBeInTheDocument();
    });

    it('shows the keep-history data-policy note in the manually opened editor, without the add-flow prompt', async () => {
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: '3 selected'}));
        expect(await screen.findByTestId('scope-policy-note')).toHaveTextContent(
            /only affects future syncs — data already collected from deselected repositories is kept/,
        );
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
    });

    it('Clear selection empties the picker so a few active repos can be ticked; Select all restores the non-archived set', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'All repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: /api/});

        // Clear, then tick only the one active repo — the 400-repo workspace flow.
        fireEvent.click(screen.getByRole('button', {name: 'Clear selection'}));
        expect(screen.getByRole('checkbox', {name: /api/})).not.toBeChecked();
        expect(screen.getByRole('checkbox', {name: /web/})).not.toBeChecked();
        fireEvent.click(screen.getByRole('checkbox', {name: /api/}));
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const sent = JSON.parse(
                String(lastCall(/\/git\/providers\/p-all$/, 'PATCH')?.[1]?.body),
            ) as Record<string, unknown>;
            expect(sent.repos).toEqual(['api']);
        });
    });

    it('Select all matches the default seed: non-archived only, archived stays opt-in', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'All repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: /api/});

        fireEvent.click(screen.getByRole('button', {name: 'Clear selection'}));
        fireEvent.click(screen.getByRole('button', {name: 'Select all'}));
        expect(screen.getByRole('checkbox', {name: /api/})).toBeChecked();
        expect(screen.getByRole('checkbox', {name: /web/})).toBeChecked();
        expect(screen.getByRole('checkbox', {name: /legacy/})).not.toBeChecked();
    });

    it('Select all RESETS an opted-in archived repo back to unchecked (documented, deliberate)', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'All repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        const legacyBox = await screen.findByRole('checkbox', {name: /legacy/});

        fireEvent.click(legacyBox); // opt the archived repo in
        expect(legacyBox).toBeChecked();
        fireEvent.click(screen.getByRole('button', {name: 'Select all'}));
        // Select all rebuilds from the non-archived listing — the opt-in resets.
        expect(screen.getByRole('checkbox', {name: /legacy/})).not.toBeChecked();
    });

    it('Select all drops a stored repo name that is absent from the listing (documented, deliberate)', async () => {
        // Stored scope references "gone", which /repos no longer returns.
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '["api","gone"]'}];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: '2 selected'}));
        await screen.findByRole('checkbox', {name: /api/});

        fireEvent.click(screen.getByRole('button', {name: 'Select all'}));
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const sent = JSON.parse(
                String(lastCall(/\/git\/providers\/p-all$/, 'PATCH')?.[1]?.body),
            ) as Record<string, unknown>;
            // The listed non-archived set only — the unlisted "gone" is dropped
            // (a plain save without Select all would have preserved it as an extra).
            expect(sent.repos).toEqual(['api', 'web']);
        });
    });

    it('opening a stored empty scope ("None selected") immediately shows the guard: warning visible, Save disabled', async () => {
        // A legacy-saved dead scope: repos_include '[]' round-trips as a real
        // empty selection, so the editor opens in select mode already empty.
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '[]'}];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'None selected'}));
        await screen.findByRole('checkbox', {name: /api/});

        expect(screen.getByTestId('empty-selection-warning')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeDisabled();
        // Recovery: ticking a repo lifts the guard.
        fireEvent.click(screen.getByRole('checkbox', {name: /api/}));
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeEnabled();
    });
});

describe('AdminGitProviders — empty-state onboarding (#201)', () => {
    it('shows the empty state only when there are no providers and no snapshots', async () => {
        providers = [];
        dataSourceGitProviders = [{provider: 'github', connected: false, developer_count: 0, last_sync: null}];
        renderPage();
        expect(await screen.findByTestId('git-empty-state')).toBeInTheDocument();
        expect(screen.getByText('Connect your first git provider')).toBeInTheDocument();
        // Onboarding points at identity management.
        expect(screen.getByRole('link', {name: 'Manage developer identities'})).toBeInTheDocument();
    });

    it('hides the empty state once a provider exists (and shows the identity note)', async () => {
        providers = [structuredClone(DB_GITHUB)];
        renderPage();
        await screen.findByText('acme-org');
        expect(screen.queryByTestId('git-empty-state')).not.toBeInTheDocument();
        expect(screen.getByTestId('identity-mapping-note')).toBeInTheDocument();
    });

    it('hides the empty state when snapshots exist even with no providers', async () => {
        providers = [];
        dataSourceGitProviders = [{provider: 'github', connected: true, developer_count: 5, last_sync: null}];
        renderPage();
        // Wait for the loaded (empty) list to settle, then assert no onboarding.
        await screen.findByText(/No providers connected yet/);
        expect(screen.queryByTestId('git-empty-state')).not.toBeInTheDocument();
    });
});
