// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {
    AdminGitProviders,
    findContainerConflict,
    parseReposList,
    repoScopeLabel,
    syncProgressLabel,
} from '../pages/admin/AdminGitProviders';
import {gitProvidersRefetchInterval} from '../hooks/useAdmin';
import type {
    AdminGitProvider,
    GitProviderDeleteImpact,
    GitProviderDeleteResult,
    GitSyncProgress,
    GitSyncRepoStep,
    GitSyncStage,
} from '../api/types';

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
    first_sync_pending: false,
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
    first_sync_pending: false,
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
    slug: string;
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

/**
 * The delete-impact preview the confirmation dialog states (#264). Mutable per test so a
 * config-sibling (`cascade_skipped`) case can be exercised too.
 */
const DEFAULT_DELETE_IMPACT: GitProviderDeleteImpact = {
    provider: 'github',
    container: 'acme-org',
    raw_author_rows: 42,
    days: 12,
    earliest_date: '2026-01-05',
    latest_date: '2026-07-01',
    commits: 137,
    pr_records: 9,
    authors: 4,
    developers_affected: 3,
    cascade_skipped: false,
};

/** What the DELETE response reports as removed (#264). */
const DELETE_REMOVED: GitProviderDeleteResult['removed'] = {
    id: 'p-gh',
    provider: 'github',
    container: 'acme-org',
    raw_author_rows: 42,
    pr_records: 9,
    days: 12,
    earliest_date: '2026-01-05',
    latest_date: '2026-07-01',
    snapshot_cells_retracted: 7,
    snapshot_cells_rewritten: 5,
    snapshot_cells_legacy_skipped: 0,
    developers_affected: 3,
    cursor_keys_purged: 3,
    cascade_skipped: false,
};

/** The post-cascade aggregate recompute the server reports alongside it (#264). */
const DELETE_AGGREGATES: GitProviderDeleteResult['aggregates'] = {
    from: '2026-01-05',
    to: '2026-07-01',
    periods: 34,
    coachingPeriods: 32,
    truncated: false,
    anomaliesNotRescanned: true,
    error: null,
};

let providers: AdminGitProvider[];
let deleteImpact: GitProviderDeleteImpact;
let deleteRemoved: GitProviderDeleteResult['removed'];
let deleteAggregates: GitProviderDeleteResult['aggregates'];
/** HTTP status the delete-impact preview answers with — 500 drives the failure path. */
let deleteImpactStatus: number;
/** HTTP status the DELETE itself answers with — non-200 drives the destructive call's failure path. */
let deleteStatus: number;
let deleteImpactCalls: number;
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
    // The repo-scope pager persists its rows-per-page choice; isolate per test.
    localStorage.clear();
    createCount = 0;
    providers = [structuredClone(DB_GITHUB), structuredClone(CONFIG_GITLAB)];
    deleteImpact = structuredClone(DEFAULT_DELETE_IMPACT);
    deleteRemoved = structuredClone(DELETE_REMOVED);
    deleteAggregates = structuredClone(DELETE_AGGREGATES);
    deleteImpactStatus = 200;
    deleteStatus = 200;
    deleteImpactCalls = 0;
    repos = [
        {slug: 'api', name: 'API Service', archived: false, defaultBranch: 'main'},
        {slug: 'web', name: 'Web App', archived: false, defaultBranch: 'main'},
        {slug: 'legacy', name: 'Old Legacy', archived: true, defaultBranch: 'master'},
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
        // Sync older history — POST /:id/sync-older-history (#229). Checked before
        // the generic /sync route (the anchors differ, but keep it explicit).
        if (/\/git\/providers\/[^/]+\/sync-older-history$/.test(u) && method === 'POST') {
            return json({data: {provider_id: 'p-gh', status: 'running', started_at: '2026-07-07T00:00:00.000Z'}}, 202);
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
                // A freshly created provider has no cursor yet — first sync pending.
                first_sync_pending: true,
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
        // Delete-impact preview (#264) — GET /:id/delete-impact. Checked before the
        // generic list route. `deleteImpactStatus` lets a test drive the failure path.
        if (/\/git\/providers\/[^/]+\/delete-impact$/.test(u) && method === 'GET') {
            deleteImpactCalls += 1;
            if (deleteImpactStatus !== 200) {
                return json({error: 'Internal Server Error', message: 'boom'}, deleteImpactStatus);
            }
            return json({data: deleteImpact});
        }
        // Delete (#264): the response reports what the cascade removed. `deleteStatus` lets a
        // test drive the destructive call's own failure (e.g. a 409 for an in-flight sync).
        if (/\/git\/providers\/[^/]+$/.test(u) && method === 'DELETE') {
            const id = decodeURIComponent(u.split('/').pop() ?? '');
            if (deleteStatus !== 200) {
                return json(
                    {error: 'Conflict', message: 'A sync is in progress for this provider'},
                    deleteStatus,
                );
            }
            providers = providers.filter((p) => p.id !== id);
            return json({
                data: {
                    id,
                    deleted: true,
                    removed: {...deleteRemoved, id},
                    aggregates: deleteAggregates,
                },
            });
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

/**
 * Open the add-provider modal from the page header's primary affordance (#238).
 * Nothing renders a form until this runs — every form assertion goes through it.
 */
function openAddModal(): void {
    fireEvent.click(screen.getByRole('button', {name: '＋ Add git provider'}));
}

/** Open a row's edit modal from its "Edit" action (#238). */
function openEditModal(container: string): void {
    const row = screen.getByText(container).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', {name: 'Edit'}));
}

/**
 * Drive the whole add flow: open the modal, fill a GitHub org + token, submit.
 * The modal closes on success, so a second create must open it again — the
 * fields no longer survive a create (they unmount with the dialog).
 */
function createGithubProvider(container: string, token = 'ghp_secret'): void {
    openAddModal();
    fireEvent.change(screen.getByLabelText('Organization'), {target: {value: container}});
    fireEvent.change(screen.getByLabelText('Token'), {target: {value: token}});
    fireEvent.click(screen.getByRole('button', {name: 'Add provider'}));
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

describe('AdminGitProviders — modal add/edit (#238)', () => {
    it('renders NO form until the admin asks for one, and the opener announces the dialog', async () => {
        renderPage();
        await screen.findByText('acme-org');
        // The page is the table, not a form pinned above it.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Organization')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', {name: 'Test connection'})).not.toBeInTheDocument();

        const opener = screen.getByRole('button', {name: '＋ Add git provider'});
        expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
        fireEvent.click(opener);
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        expect(screen.getByLabelText('Organization')).toBeInTheDocument();
    });

    it('Cancel closes the add modal with no write, and reopening starts empty', async () => {
        renderPage();
        await screen.findByText('acme-org');
        openAddModal();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'typed-then-abandoned'}});
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(lastCall(/\/git\/providers$/, 'POST')).toBeUndefined();
        // Reopening remounts clean — the abandoned draft is gone (criterion 3).
        openAddModal();
        expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('');
    });

    // #265: the actual data-loss regression. A misplaced click on the dim area
    // used to close this form and discard the whole draft — type, container,
    // auth method and a pasted token — with no confirmation and no undo.
    it('a backdrop click keeps the add form open with every entered value intact', async () => {
        renderPage();
        await screen.findByText('acme-org');
        openAddModal();

        // The full four-field shape the issue names, so a partial survival fails.
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {
            target: {value: 'bitbucket'},
        });
        fireEvent.change(screen.getByRole('combobox', {name: 'Auth method'}), {
            target: {value: 'access_token'},
        });
        fireEvent.change(screen.getByLabelText('Workspace'), {target: {value: 'acme-ws'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'atl_pasted_secret'}});

        const backdrop = screen.getByTestId('git-provider-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);

        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        expect((screen.getByRole('combobox', {name: 'Provider type'}) as HTMLSelectElement).value).toBe(
            'bitbucket',
        );
        expect((screen.getByRole('combobox', {name: 'Auth method'}) as HTMLSelectElement).value).toBe(
            'access_token',
        );
        expect((screen.getByLabelText('Workspace') as HTMLInputElement).value).toBe('acme-ws');
        expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('atl_pasted_secret');
        expect(lastCall(/\/git\/providers$/, 'POST')).toBeUndefined();
    });

    it("a row's Edit opens the same form pre-filled, titled for that provider", async () => {
        renderPage();
        await screen.findByText('acme-org');
        const row = screen.getByText('acme-org').closest('tr') as HTMLElement;
        const editButton = within(row).getByRole('button', {name: 'Edit'});
        expect(editButton).toHaveAttribute('aria-haspopup', 'dialog');
        fireEvent.click(editButton);

        expect(screen.getByRole('dialog', {name: 'Edit GitHub provider'})).toBeInTheDocument();
        expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('acme-org');
        // The token stays blank — write-only, with the stored mask as the hint.
        expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
        expect(screen.getByPlaceholderText(/Leave blank to keep ••••cdef/)).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save changes'})).toBeInTheDocument();
    });

    // #264: (type, container) keys every imported row and every sync cursor, so the server
    // refuses a PATCH that moves them. The form locks both fields and says why, rather than
    // letting the admin type a change that can only come back as a 409.
    it('locks type + container on EDIT and explains why (they are the attribution key)', async () => {
        renderPage();
        await screen.findByText('acme-org');
        openEditModal('acme-org');

        expect(screen.getByLabelText('Organization')).toBeDisabled();
        expect(screen.getByLabelText('Provider type')).toBeDisabled();
        expect(screen.getByTestId('container-immutable-note').textContent).toMatch(
            /cannot be changed/i,
        );
        // The token field stays editable — only the attribution key is frozen.
        expect(screen.getByLabelText('Token')).not.toBeDisabled();
    });

    it('leaves type + container editable on ADD', async () => {
        renderPage();
        await screen.findByText('acme-org');
        openAddModal();
        expect(screen.getByLabelText('Organization')).not.toBeDisabled();
        expect(screen.getByLabelText('Provider type')).not.toBeDisabled();
        expect(screen.queryByTestId('container-immutable-note')).not.toBeInTheDocument();
    });

    it('remounts clean when switching between rows, and from a row back to add', async () => {
        providers = [
            structuredClone(DB_GITHUB),
            {...structuredClone(DB_GITHUB), id: 'p-two', container: 'other-org'},
        ];
        renderPage();
        await screen.findByText('acme-org');

        openEditModal('acme-org');
        expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('acme-org');
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // A different row must not carry the previous row's fields.
        openEditModal('other-org');
        expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('other-org');
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

        // …and add starts empty, not pre-filled from the last edit.
        openAddModal();
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('');
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
            if (/\/git\/providers$/.test(u) && method === 'POST') await gate;
            return base!(url, init);
        });
        renderPage();
        createGithubProvider('new-org');
        expect(await screen.findByRole('button', {name: 'Saving…'})).toBeInTheDocument();

        // Cancel, Esc and × are all inert mid-write. The backdrop click below is
        // inert UNCONDITIONALLY since #265, so it no longer proves the guard.
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        const backdrop = screen.getByTestId('git-provider-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();

        // Once the write settles the modal closes through the success path.
        releasePost?.();
        await waitFor(() =>
            expect(screen.queryByRole('dialog', {name: 'Add git provider'})).not.toBeInTheDocument(),
        );
    });

    it('surfaces a failed write inside the modal and keeps it open with the draft intact', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/git\/providers$/.test(u) && method === 'POST') {
                // The client surfaces a 4xx body's `message` (see apiClient).
                return json({message: 'Container already connected'}, 409);
            }
            return base!(url, init);
        });
        renderPage();
        createGithubProvider('dupe-org');

        expect(await screen.findByText(/Container already connected/)).toBeInTheDocument();
        // The dialog stays open with the admin's values — a failed write must not
        // discard the draft or leave the failure invisible behind a closed modal.
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('dupe-org');
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
    });
});

describe('AdminGitProviders — dynamic form', () => {
    it('renders GitHub fields by default (single auth method, no selector)', () => {
        renderPage();
        openAddModal();
        expect(screen.getByLabelText('Organization')).toBeInTheDocument();
        expect(screen.getByLabelText('Token')).toBeInTheDocument();
        // GitHub has one auth method → no auth-method selector.
        expect(screen.queryByRole('combobox', {name: 'Auth method'})).not.toBeInTheDocument();
    });

    it('renders the Bitbucket app_password two-field case, and drops the username on other methods', () => {
        renderPage();
        openAddModal();
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
        openAddModal();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'gitlab'}});
        expect(screen.getByLabelText('Group')).toBeInTheDocument();
        expect(screen.getByLabelText('Self-hosted URL (optional)')).toBeInTheDocument();
        expect(screen.getByText('Include subgroups')).toBeInTheDocument();
        expect(screen.getByRole('combobox', {name: 'Auth method'})).toBeInTheDocument();
    });
});

describe('AdminGitProviders — color system', () => {
    it('the add opener and the modal Save are the orange primary CTA; Test connection is indigo (accent)', () => {
        renderPage();
        expect(screen.getByRole('button', {name: '＋ Add git provider'}).className).toContain(
            'bg-primary',
        );
        openAddModal();
        expect(screen.getByRole('button', {name: 'Add provider'}).className).toContain('bg-primary');
        expect(screen.getByRole('button', {name: 'Test connection'}).className).toContain('accent');
    });
});

describe('AdminGitProviders — create + test', () => {
    it('creates a provider via POST with the form values', async () => {
        renderPage();
        createGithubProvider('new-org');

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
        openAddModal();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'bitbucket'}});
        fireEvent.change(screen.getByLabelText('Workspace'), {target: {value: 'my-workspace'}});
        fireEvent.change(screen.getByLabelText('Atlassian account email'), {target: {value: 'jane@company.com'}});
        fireEvent.change(screen.getByLabelText('API token'), {target: {value: 'atl_token'}});
        fireEvent.click(screen.getByRole('button', {name: 'Add provider'}));

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
        openAddModal();
        // Success path — inside the modal (criterion 3).
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
        openAddModal();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'org'}});
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'tok'}});
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeEnabled();
    });

    it('requires the account email before Save/Test for Bitbucket app_password', () => {
        renderPage();
        openAddModal();
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {target: {value: 'bitbucket'}});
        fireEvent.change(screen.getByLabelText('Workspace'), {target: {value: 'ws'}});
        fireEvent.change(screen.getByLabelText('API token'), {target: {value: 'pw'}});
        // Email still blank → both CTAs stay disabled (server would 400).
        expect(screen.getByRole('button', {name: 'Add provider'})).toBeDisabled();
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Atlassian account email'), {target: {value: 'bob@company.com'}});
        expect(screen.getByRole('button', {name: 'Add provider'})).toBeEnabled();
        expect(screen.getByRole('button', {name: 'Test connection'})).toBeEnabled();
    });

    it('the disabled Save cannot be bypassed — a click on it sends no POST', () => {
        renderPage();
        openAddModal();
        // Container filled, token blank → create is gated (server requires one).
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'org'}});
        const save = screen.getByRole('button', {name: 'Add provider'});
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(lastCall(/\/git\/providers$/, 'POST')).toBeUndefined();
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
        await screen.findByText('acme-org');
        openEditModal('acme-org');

        // The form prefills the container and shows a "keep existing" masked hint.
        expect(screen.getByPlaceholderText(/Leave blank to keep ••••cdef/)).toBeInTheDocument();
        // Save without touching the token → PATCH with no token field.
        fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
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
        // A successful edit closes the modal — and never triggers the create-only
        // scope prompt (#211).
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
    });

    it('an edit submits the changed fields, and a GitLab edit keeps url + subgroups', async () => {
        providers = [
            {
                ...structuredClone(DB_GITHUB),
                id: 'p-gl',
                type: 'gitlab',
                container: 'my-group',
                auth_method: 'personal_access_token',
                url: 'https://gitlab.example.com',
                include_subgroups: true,
                repos_include: null,
                repos_exclude: null,
            },
        ];
        renderPage();
        await screen.findByText('my-group');
        openEditModal('my-group');

        // The GitLab-only fields pre-fill from the row…
        expect((screen.getByLabelText('Self-hosted URL (optional)') as HTMLInputElement).value).toBe(
            'https://gitlab.example.com',
        );
        expect(screen.getByRole('checkbox', {name: 'Include subgroups'})).toBeChecked();
        // …and an edited container + re-entered token go out on the PATCH.
        fireEvent.change(screen.getByLabelText('Group'), {target: {value: 'renamed-group'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'glpat_new'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));

        await waitFor(() => {
            const patch = lastCall(/\/git\/providers\/p-gl$/, 'PATCH');
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            expect(sent.container).toBe('renamed-group');
            expect(sent.token).toBe('glpat_new');
            expect(sent.url).toBe('https://gitlab.example.com');
            expect(sent.include_subgroups).toBe(true);
        });
    });

    // #264: the delete is destructive (it retracts the container's imported data), so
    // "Remove" must CONFIRM first, stating the real impact — and report what was removed.
    describe('destructive remove (#264)', () => {
        async function openRemoveDialog(): Promise<HTMLElement> {
            renderPage();
            const ghCell = await screen.findByText('acme-org');
            const row = ghCell.closest('tr') as HTMLElement;
            fireEvent.click(within(row).getByRole('button', {name: 'Remove'}));
            return screen.findByTestId('remove-provider-modal');
        }

        it('does NOT delete on the first click — it opens a confirmation instead', async () => {
            await openRemoveDialog();
            expect(lastCall(/\/git\/providers\/p-gh$/, 'DELETE')).toBeUndefined();
        });

        it('states the real impact from /delete-impact', async () => {
            await openRemoveDialog();
            const impact = await screen.findByTestId('remove-impact');
            expect(impact.textContent).toContain('12 days of history');
            expect(impact.textContent).toContain('2026-01-05 → 2026-07-01');
            expect(impact.textContent).toContain('137 commits');
            expect(impact.textContent).toContain('9 pull-request record');
            expect(impact.textContent).toContain('3 developers');
            // And states plainly that developers themselves survive.
            expect(impact.textContent).toMatch(/not.*removed/s);
        });

        it('deletes only after confirming, and reports what was removed', async () => {
            const dialog = await openRemoveDialog();
            await screen.findByTestId('remove-impact');
            fireEvent.click(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            );
            await waitFor(() => {
                expect(lastCall(/\/git\/providers\/p-gh$/, 'DELETE')).toBeTruthy();
            });
            const banner = await screen.findByTestId('provider-removed-banner');
            expect(banner.textContent).toContain('42 author-day row(s)');
            expect(banner.textContent).toContain('7 snapshot cell(s) removed');
            expect(banner.textContent).toContain('3 sync cursor(s) cleared');
            expect(banner.textContent).toContain('none were deleted');
            // The derived rollups are recomputed server-side; the count is reported so the
            // admin can tell a recompute happened from one that silently didn't.
            expect(banner.textContent).toContain('34 trend aggregate period(s)');
        });

        // A refused legacy cell means the retraction was PARTIAL — that must not render
        // identically to a complete one.
        it('says so when some snapshot cells could NOT be retracted', async () => {
            deleteRemoved = {...DELETE_REMOVED, snapshot_cells_legacy_skipped: 4};
            const dialog = await openRemoveDialog();
            await screen.findByTestId('remove-impact');
            fireEvent.click(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            );
            const banner = await screen.findByTestId('provider-removed-banner');
            expect(banner.textContent).toContain('4 snapshot cell(s) could NOT be retracted');
            expect(banner.textContent).toContain('still include this provider');
        });

        // The data is gone but the trend charts are not — the admin has to be told, with the
        // remedy, rather than shown a clean success line.
        // A PARTIAL failure must report what landed, not claim nothing did: the recompute
        // commits one period at a time, so "0 recomputed" would send the admin hunting for a
        // problem that is already half-fixed. And the remedy must not over-promise — the CLI
        // covers the trend rollups only.
        it('reports a partially-failed recompute with the periods that DID land and an honest remedy', async () => {
            deleteAggregates = {
                ...DELETE_AGGREGATES,
                periods: 11,
                coachingPeriods: 8,
                error: 'disk full',
            };
            const dialog = await openRemoveDialog();
            await screen.findByTestId('remove-impact');
            fireEvent.click(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            );
            const banner = await screen.findByTestId('provider-removed-banner');
            expect(banner.textContent).toContain('only partly recomputed');
            expect(banner.textContent).toContain('disk full');
            expect(banner.textContent).toContain('11 trend period(s)');
            expect(banner.textContent).toContain('8 coaching period(s)');
            expect(banner.textContent).toContain('toprope aggregate backfill');
            // …and says plainly that the command does not cover the other engines.
            expect(banner.textContent).toContain('does not cover PR-review or');
        });

        it('says so when the recomputed range was CLAMPED', async () => {
            deleteAggregates = {...DELETE_AGGREGATES, truncated: true, from: '2023-08-01'};
            const dialog = await openRemoveDialog();
            await screen.findByTestId('remove-impact');
            fireEvent.click(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            );
            const banner = await screen.findByTestId('provider-removed-banner');
            expect(banner.textContent).toContain('capped at 2023-08-01');
            expect(banner.textContent).toContain('still include the removed activity');
        });

        // The one derived table deliberately left alone — stated, not implied by omission.
        it('states that anomaly alerts were not re-scanned', async () => {
            const dialog = await openRemoveDialog();
            await screen.findByTestId('remove-impact');
            fireEvent.click(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            );
            const banner = await screen.findByTestId('provider-removed-banner');
            expect(banner.textContent).toContain('not re-scanned');
            expect(banner.textContent).toContain('32 coaching period(s)');
        });

        it('reports the skipped-cascade outcome through to the banner', async () => {
            deleteImpact = {...DEFAULT_DELETE_IMPACT, cascade_skipped: true};
            deleteRemoved = {...DELETE_REMOVED, cascade_skipped: true, raw_author_rows: 0, days: 0};
            const dialog = await openRemoveDialog();
            await screen.findByTestId('remove-impact');
            fireEvent.click(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            );
            const banner = await screen.findByTestId('provider-removed-banner');
            expect(banner.textContent).toContain('config-file provider still owns its data');
            expect(banner.textContent).toContain('nothing was retracted');
            // …and NOT the retraction counts, which would be a lie on this path.
            expect(banner.textContent).not.toContain('author-day row(s)');
        });

        // Fail-closed on a preview that could not load — confirming against nothing is
        // confirming blind — but with a retry, so one transient 500 doesn't permanently
        // block the delete.
        it('disables the confirm when the impact fails to load, and offers a retry', async () => {
            deleteImpactStatus = 500;
            const dialog = await openRemoveDialog();
            await within(dialog).findByText(/Could not check what this would remove/);
            expect(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            ).toBeDisabled();

            const callsBeforeRetry = deleteImpactCalls;
            deleteImpactStatus = 200;
            fireEvent.click(within(dialog).getByRole('button', {name: 'Try again'}));
            await screen.findByTestId('remove-impact');
            expect(deleteImpactCalls).toBeGreaterThan(callsBeforeRetry);
            expect(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            ).not.toBeDisabled();
            // And nothing was deleted while the preview was broken.
            expect(lastCall(/\/git\/providers\/p-gh$/, 'DELETE')).toBeUndefined();
        });

        it('cancelling closes the dialog without deleting', async () => {
            const dialog = await openRemoveDialog();
            fireEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}));
            await waitFor(() => {
                expect(screen.queryByTestId('remove-provider-modal')).not.toBeInTheDocument();
            });
            expect(lastCall(/\/git\/providers\/p-gh$/, 'DELETE')).toBeUndefined();
        });

        // The destructive call itself can fail — most realistically a 409 because a sync started
        // between the preview and the confirm. The dialog must stay open with the reason visible,
        // not close on a delete that did not happen.
        it('keeps the dialog open with the reason when the DELETE itself fails', async () => {
            deleteStatus = 409;
            const dialog = await openRemoveDialog();
            await screen.findByTestId('remove-impact');
            fireEvent.click(
                within(dialog).getByRole('button', {name: 'Remove provider and its data'}),
            );
            await waitFor(() => {
                expect(lastCall(/\/git\/providers\/p-gh$/, 'DELETE')).toBeTruthy();
            });
            // Still open, error shown, and no success banner.
            expect(await screen.findByText(/A sync is in progress/)).toBeInTheDocument();
            expect(screen.getByTestId('remove-provider-modal')).toBeInTheDocument();
            expect(screen.queryByTestId('provider-removed-banner')).not.toBeInTheDocument();
        });

        it('says nothing is retracted when a config-file provider still owns the container', async () => {
            deleteImpact = {...DEFAULT_DELETE_IMPACT, cascade_skipped: true, days: 0, commits: 0};
            await openRemoveDialog();
            const impact = await screen.findByTestId('remove-impact');
            expect(impact.textContent).toContain('config-file provider still covers');
            expect(impact.textContent).toContain('no imported activity');
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

    // #228 — first-sync history window input.
    it('an already-synced row shows NO window input and syncs with no months', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org'); // DB_GITHUB: last_sync_at set
        const row = ghCell.closest('tr') as HTMLElement;
        // Once a provider has synced, the window is meaningless (server ignores it).
        expect(
            within(row).queryByLabelText('First-sync history window in months'),
        ).not.toBeInTheDocument();

        fireEvent.click(within(row).getByRole('button', {name: 'Sync now'}));
        await waitFor(() => {
            const call = lastCall(/\/git\/providers\/p-gh\/sync$/, 'POST');
            expect(call).toBeTruthy();
            const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
            expect(body).not.toHaveProperty('months');
        });
    });

    it('a first-sync row shows the window input (default 6) and posts the chosen months', async () => {
        providers.push({
            ...structuredClone(DB_GITHUB),
            id: 'p-fresh',
            container: 'fresh-org',
            last_sync_at: null,
            last_sync_status: null,
            first_sync_pending: true,
        });
        renderPage();
        const cell = await screen.findByText('fresh-org');
        const row = cell.closest('tr') as HTMLElement;
        const input = within(row).getByLabelText(
            'First-sync history window in months',
        ) as HTMLInputElement;
        // Defaults to 6 months.
        expect(input.value).toBe('6');

        // Default press → months: 6.
        fireEvent.click(within(row).getByRole('button', {name: 'Sync now'}));
        await waitFor(() => {
            const call = lastCall(/\/git\/providers\/p-fresh\/sync$/, 'POST');
            expect(call).toBeTruthy();
            const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
            expect(body.months).toBe(6);
        });

        // Wait out the pending state so the input is interactive again.
        await waitFor(() => expect(input).toBeEnabled());
        // Change the window → the next press carries the new value.
        fireEvent.change(input, {target: {value: '3'}});
        expect(input.value).toBe('3');
        fireEvent.click(within(row).getByRole('button', {name: 'Sync now'}));
        await waitFor(() => {
            const call = lastCall(/\/git\/providers\/p-fresh\/sync$/, 'POST');
            const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
            expect(body.months).toBe(3);
        });
    });

    it('clamps an out-of-range window entry to the valid bounds before syncing', async () => {
        providers.push({
            ...structuredClone(DB_GITHUB),
            id: 'p-fresh2',
            container: 'fresh-two',
            last_sync_at: null,
            last_sync_status: null,
            first_sync_pending: true,
        });
        renderPage();
        const cell = await screen.findByText('fresh-two');
        const row = cell.closest('tr') as HTMLElement;
        const input = within(row).getByLabelText(
            'First-sync history window in months',
        ) as HTMLInputElement;

        // Above the ceiling (60) is clamped, never emitted raw to the server.
        fireEvent.change(input, {target: {value: '999'}});
        expect(input.value).toBe('60');
        // Below the floor (1) is clamped up.
        fireEvent.change(input, {target: {value: '0'}});
        expect(input.value).toBe('1');
        fireEvent.change(input, {target: {value: '-5'}});
        expect(input.value).toBe('1');
        // A blank/non-numeric entry falls back to the default.
        fireEvent.change(input, {target: {value: ''}});
        expect(input.value).toBe('6');
    });
});

describe('AdminGitProviders — sync older history (#229)', () => {
    it('an already-synced row shows the older-history control (default 12) and posts the months', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org'); // DB_GITHUB: first_sync_pending false
        const row = ghCell.closest('tr') as HTMLElement;
        const input = within(row).getByLabelText('Older-history window in months') as HTMLInputElement;
        // Defaults to 12 months (larger than the 6-month first-sync default so the
        // control starts at a value that actually extends the window).
        expect(input.value).toBe('12');

        fireEvent.click(within(row).getByRole('button', {name: 'Sync older history'}));
        await waitFor(() => {
            const call = lastCall(/\/git\/providers\/p-gh\/sync-older-history$/, 'POST');
            expect(call).toBeTruthy();
            const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
            expect(body.months).toBe(12);
        });

        // Change the window → the next press carries the new absolute value.
        await waitFor(() => expect(input).toBeEnabled());
        fireEvent.change(input, {target: {value: '24'}});
        expect(input.value).toBe('24');
        fireEvent.click(within(row).getByRole('button', {name: 'Sync older history'}));
        await waitFor(() => {
            const call = lastCall(/\/git\/providers\/p-gh\/sync-older-history$/, 'POST');
            const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
            expect(body.months).toBe(24);
        });
    });

    it('clamps the older-history entry to the valid bounds, falling back to 12 when blank', async () => {
        renderPage();
        const ghCell = await screen.findByText('acme-org');
        const row = ghCell.closest('tr') as HTMLElement;
        const input = within(row).getByLabelText('Older-history window in months') as HTMLInputElement;

        fireEvent.change(input, {target: {value: '999'}});
        expect(input.value).toBe('60');
        fireEvent.change(input, {target: {value: '0'}});
        expect(input.value).toBe('1');
        // Blank falls back to THIS control's default (12), not the first-sync 6.
        fireEvent.change(input, {target: {value: ''}});
        expect(input.value).toBe('12');
    });

    it('a first-sync row hides the older-history control (there is no history to extend yet)', async () => {
        providers.push({
            ...structuredClone(DB_GITHUB),
            id: 'p-fresh-oh',
            container: 'fresh-oh',
            last_sync_at: null,
            last_sync_status: null,
            first_sync_pending: true,
        });
        renderPage();
        const cell = await screen.findByText('fresh-oh');
        const row = cell.closest('tr') as HTMLElement;
        expect(
            within(row).queryByRole('button', {name: 'Sync older history'}),
        ).not.toBeInTheDocument();
        expect(
            within(row).queryByLabelText('Older-history window in months'),
        ).not.toBeInTheDocument();
        // …but the first-sync window input IS offered instead.
        expect(
            within(row).getByLabelText('First-sync history window in months'),
        ).toBeInTheDocument();
    });

    it('config rows offer no older-history control', async () => {
        renderPage();
        const configCell = await screen.findByText('team');
        const row = configCell.closest('tr') as HTMLElement;
        expect(
            within(row).queryByRole('button', {name: 'Sync older history'}),
        ).not.toBeInTheDocument();
    });
});

describe('AdminGitProviders — repo-scope editor (#201)', () => {
    it('defaults archived repos unchecked and writes only the non-archived selection', async () => {
        // A monitor-all provider: switching to "Select repositories" seeds the
        // picker with every NON-archived repo; archived ones stay unchecked.
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();

        // The scope modal opens from the row's "Repos" action button (#213).
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));

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
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));

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
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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
        // Config repo scope is plain text ("2 selected") with no Repos action.
        expect(within(row).queryByRole('button', {name: 'Repos'})).not.toBeInTheDocument();
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
        repo_step: null,
        repo_step_done: 0,
        repo_step_scanned: null,
        repo_step_total: null,
    };

    it('falls back to a starting line before the first pipeline emission', () => {
        expect(syncProgressLabel({started_at: 't', progress: null})).toBe('Starting sync…');
    });

    it('labels every stage with its counters', () => {
        expect(syncProgressLabel({started_at: 't', progress: {...base, stage: 'listing_repos'}})).toBe(
            'Listing repositories…',
        );
        expect(syncProgressLabel({started_at: 't', progress: base})).toBe(
            'Fetching activity — repo 3/12 (web) · run total 34 commits · 5 PRs',
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
        ).toBe('Fetching activity — repo 12/12 (infra) · run total 34 commits · 5 PRs');
        // Zero repos selected: 0/0, no phantom first repo — and no repo-name
        // suffix when current_repo is null (full equality pins its absence).
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repos_total: 0, repos_processed: 0, current_repo: null},
            }),
        ).toBe('Fetching activity — repo 0/0 · run total 34 commits · 5 PRs');
    });
});

describe('syncProgressLabel — within-repo progress (#270)', () => {
    // Deliberately frozen run-level counters: the whole point of #270 is that these
    // do NOT move while one repo is being fetched, so every assertion below proves
    // the line advances on the within-repo fields instead.
    const base: GitSyncProgress = {
        stage: 'fetching',
        repos_total: 12,
        repos_processed: 2,
        current_repo: 'web',
        commits_fetched: 34,
        prs_fetched: 5,
        developers_matched: 0,
        repo_step: null,
        repo_step_done: 0,
        repo_step_scanned: null,
        repo_step_total: null,
    };

    it('counts commits seen while the commit list is still paging in', () => {
        // No total exists yet (the list has not finished paging), so the honest
        // signal is a running seen-count — never a percentage.
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'commits', repo_step_done: 300, repo_step_total: null},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · 300 commits found · run total 34 commits · 5 PRs');
    });

    it('singularizes the found-count at one item', () => {
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'commits', repo_step_done: 1, repo_step_total: null},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · 1 commit found · run total 34 commits · 5 PRs');
    });

    it('shows commit done/total during the per-commit detail fetch', () => {
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'commits', repo_step_done: 1240, repo_step_total: 5000},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · commit 1240/5000 · run total 34 commits · 5 PRs');
    });

    it('shows the diff fan-out as its own counter', () => {
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'diffs', repo_step_done: 12, repo_step_total: 5000},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · diff 12/5000 · run total 34 commits · 5 PRs');
    });

    it('shows the PR fan-out as its own counter, pluralized as PRs while listing', () => {
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'prs', repo_step_done: 12, repo_step_total: 40},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · PR 12/40 · run total 34 commits · 5 PRs');
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'prs', repo_step_done: 12, repo_step_total: null},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · 12 PRs found · run total 34 commits · 5 PRs');
    });

    it('keeps the run-level totals on the line at every step, never replacing them', () => {
        // The within-repo counter is PREPENDED, not substituted: repo_step is non-null
        // for essentially the whole fetching stage, so substituting would have hidden
        // how much data the run has actually pulled for the entire stage (review SO-2).
        for (const step of ['commits', 'diffs', 'prs'] as GitSyncRepoStep[]) {
            for (const total of [null, 40]) {
                expect(
                    syncProgressLabel({
                        started_at: 't',
                        progress: {...base, repo_step: step, repo_step_done: 12, repo_step_total: total},
                    }),
                ).toContain('· run total 34 commits · 5 PRs');
            }
        }
    });

    it('still shows a counter at zero-with-unknown-total, the state every repo passes through', () => {
        // The pipeline emits (step, 0, null) deliberately on entering a step, BEFORE its
        // list request — the live state for that whole request, which under a rate-limit
        // backoff is minutes. Suppressing a zero `done` (an easy-looking tidy-up next to
        // the zero-TOTAL rule below) would blank the within-repo signal for exactly that
        // window on every repo, so pin it.
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'prs', repo_step_done: 0, repo_step_total: null},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · 0 PRs found · run total 34 commits · 5 PRs');
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, repo_step: 'commits', repo_step_done: 0, repo_step_total: null},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · 0 commits found · run total 34 commits · 5 PRs');
    });

    it('labels the run-level pair so the two scopes are not read as one broken number', () => {
        // The within-repo count is routinely LARGER than the run total (the run total
        // only advances when a whole repo finishes), so an unlabelled
        // "commit 1240/5000 · 34 commits" reads as a bug (review SO-1).
        const label = syncProgressLabel({
            started_at: 't',
            progress: {...base, repo_step: 'commits', repo_step_done: 1240, repo_step_total: 5000},
        });
        expect(label).toContain('commit 1240/5000');
        expect(label).toContain('run total 34 commits');
        // The bare, ambiguous form must not appear.
        expect(label).not.toMatch(/\d+\/\d+ · \d+ commits/);
    });

    it('renders no counter for a step that ran over an empty set', () => {
        // A zero total would read as the meaningless "commit 0/0". Suppressing it is
        // this function's job alone — the pipeline reports total: 0 truthfully.
        for (const step of ['commits', 'diffs', 'prs'] as GitSyncRepoStep[]) {
            expect(
                syncProgressLabel({
                    started_at: 't',
                    progress: {...base, repo_step: step, repo_step_done: 0, repo_step_total: 0},
                }),
            ).toBe('Fetching activity — repo 3/12 (web) · run total 34 commits · 5 PRs');
        }
    });

    it('degrades an unknown wire step to the cumulative counters (backend/bundle skew)', () => {
        // A newer backend adds a step this bundle does not know: fall back to the
        // #209 line rather than rendering a broken "undefined 3/9".
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: 'reviews' as GitSyncRepoStep,
                    repo_step_done: 3,
                    repo_step_total: 9,
                },
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · run total 34 commits · 5 PRs');
    });

    it('degrades an inherited-key wire step too, not just an unknown one', () => {
        // repo_step is wire data. A bare object-literal lookup resolves 'toString' to a
        // FUNCTION, which passes an `undefined` check and renders as source text — so
        // the noun map must be probed with Object.hasOwn. A plain unknown string cannot
        // catch this class of value.
        for (const key of ['toString', 'constructor', 'valueOf']) {
            const label = syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: key as GitSyncRepoStep,
                    repo_step_done: 3,
                    repo_step_total: 9,
                },
            });
            expect(label).toBe('Fetching activity — repo 3/12 (web) · run total 34 commits · 5 PRs');
            expect(label).not.toMatch(/function|native code|\[object/);
        }
    });

    it('singularizes the run-level nouns at one', () => {
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {...base, commits_fetched: 1, prs_fetched: 1},
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · run total 1 commit · 1 PR');
    });

    // --- scanned-vs-found on a walk that filters in memory (#276) ---

    it('shows the scanned count alongside the found count while a walk approaches its window', () => {
        // The reported #276 scenario: a Bitbucket backfill pages from HEAD and discards
        // everything newer than `until`, so `repo_step_done` is pinned at 0 for hundreds
        // of pages. The scanned count is the ONLY field that moves, so the line must carry
        // it — and must say "scanned", never "found", because 3400 rows were examined and
        // 0 commits were kept.
        const label = syncProgressLabel({
            started_at: 't',
            progress: {
                ...base,
                repo_step: 'commits',
                repo_step_done: 0,
                repo_step_scanned: 3400,
                repo_step_total: null,
            },
        });
        expect(label).toBe(
            'Fetching activity — repo 3/12 (web) · 0 commits found (3400 scanned) · run total 34 commits · 5 PRs',
        );
        // The scanned number must not be presented as commits found — the lie in the
        // other direction the issue explicitly rules out.
        expect(label).not.toContain('3400 commits found');
    });

    it('shows both counts on the boundary page, where the found count is non-zero', () => {
        // Every backfill crosses this state exactly once per repo: the page that straddles
        // `until`, so some rows are kept and more were examined. All the other suffix
        // cases hold `repo_step_done` at 0, which means nothing pins that the suffix
        // survives a non-zero found count — a regression that only appended it while
        // `done === 0` would pass them all. Singular "1 commit" is exercised here too,
        // since the suffix composes onto the pluralised noun.
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: 'commits',
                    repo_step_done: 2,
                    repo_step_scanned: 5,
                    repo_step_total: null,
                },
            }),
        ).toBe(
            'Fetching activity — repo 3/12 (web) · 2 commits found (5 scanned) · run total 34 commits · 5 PRs',
        );
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: 'commits',
                    repo_step_done: 1,
                    repo_step_scanned: 5,
                    repo_step_total: null,
                },
            }),
        ).toContain('1 commit found (5 scanned)');
    });

    it('renders the plain count when an older backend omits the scanned key entirely', () => {
        // `repo_step_scanned` is declared non-optional, but that is a claim about the
        // CURRENT server: a cached bundle polling a rolled-back one receives the key
        // absent. `undefined` must degrade to the plain count, never render as
        // "undefined scanned" — the same wire-robustness posture `repoStepCount` takes
        // with `Object.hasOwn` for `repo_step`.
        const progress = {
            ...base,
            repo_step: 'commits' as const,
            repo_step_done: 7,
            repo_step_scanned: 3400,
            repo_step_total: null,
        };
        // Positive control: with the key present the suffix does render, so the assertion
        // below is about its absence and not about an unrelated suppression.
        expect(syncProgressLabel({started_at: 't', progress})).toContain('7 commits found (3400 scanned)');

        const {repo_step_scanned: _omitted, ...withoutKey} = progress;
        const label = syncProgressLabel({
            started_at: 't',
            progress: withoutKey as typeof progress,
        });
        expect(label).toContain('7 commits found ·');
        expect(label).not.toContain('scanned');
        expect(label).not.toContain('undefined');

        // A non-number is the case the `typeof` guard exists for, and the only one that
        // distinguishes it from a bare `!== null`: relational comparison coerces, so
        // `'3400' > 7` is true and a looser guard would interpolate remote text into the
        // operator's line as though it were a count.
        const asText = syncProgressLabel({
            started_at: 't',
            progress: {...progress, repo_step_scanned: '3400' as unknown as number},
        });
        expect(asText).toBe(
            'Fetching activity — repo 3/12 (web) · 7 commits found · run total 34 commits · 5 PRs',
        );
    });

    it('advances the line on every page of a walk that keeps nothing', () => {
        // AC1 as the operator experiences it: consecutive snapshots from the approach
        // walk must render DIFFERENT lines. Before #276 all three of these were the
        // byte-identical "0 commits found".
        const lines = [100, 200, 300].map((scanned) =>
            syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: 'commits',
                    repo_step_done: 0,
                    repo_step_scanned: scanned,
                    repo_step_total: null,
                },
            }),
        );
        expect(new Set(lines).size).toBe(3);
    });

    it('omits the scanned count when it adds nothing to the found count', () => {
        // A forward run reports `scanned` too (the provider does not pre-filter), but
        // there it equals the found count — appending "(300 scanned)" beside
        // "300 commits found" would be noise. Equal and BELOW both suppress: below is
        // unreachable for every producer, and a shrinking parenthetical would be worse
        // than none.
        for (const scanned of [300, 12]) {
            expect(
                syncProgressLabel({
                    started_at: 't',
                    progress: {
                        ...base,
                        repo_step: 'commits',
                        repo_step_done: 300,
                        repo_step_scanned: scanned,
                        repo_step_total: null,
                    },
                }),
            ).toBe('Fetching activity — repo 3/12 (web) · 300 commits found · run total 34 commits · 5 PRs');
        }
    });

    it('ignores a scanned count once the set size is known', () => {
        // Past the listing phase every row in the set was kept by definition, so a
        // scanned value there is stale (or a newer backend's) and must not turn
        // `commit 1240/5000` into something else.
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: 'commits',
                    repo_step_done: 1240,
                    repo_step_scanned: 9999,
                    repo_step_total: 5000,
                },
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · commit 1240/5000 · run total 34 commits · 5 PRs');
    });

    it('keeps suppressing a step that ran over an empty set even with a scanned count', () => {
        // `total: 0` still wins: "commit 0/0 (500 scanned)" would resurrect exactly the
        // meaningless counter the zero-total rule exists to hide.
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: 'commits',
                    repo_step_done: 0,
                    repo_step_scanned: 500,
                    repo_step_total: 0,
                },
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · run total 34 commits · 5 PRs');
    });

    it('does not render a scanned count for an unnameable step', () => {
        // Same degradation as without it: an unknown step has no noun, so there is no
        // honest sentence to put the scanned number in.
        expect(
            syncProgressLabel({
                started_at: 't',
                progress: {
                    ...base,
                    repo_step: 'reviews' as GitSyncRepoStep,
                    repo_step_done: 0,
                    repo_step_scanned: 400,
                    repo_step_total: null,
                },
            }),
        ).toBe('Fetching activity — repo 3/12 (web) · run total 34 commits · 5 PRs');
    });

    it('leaves every other stage untouched by the within-repo fields', () => {
        // repo_step is only meaningful during `fetching`; a stale value must not
        // leak into any other stage's line.
        const mid = {...base, repo_step: 'commits' as GitSyncRepoStep, repo_step_done: 7, repo_step_total: 9};
        expect(
            syncProgressLabel({started_at: 't', progress: {...mid, stage: 'analyzing', developers_matched: 4}}),
        ).toBe('Matching developers — 4 matched');
        expect(
            syncProgressLabel({started_at: 't', progress: {...mid, stage: 'writing', developers_matched: 4}}),
        ).toBe('Writing snapshots — 4 developers matched');
        expect(
            syncProgressLabel({started_at: 't', progress: {...mid, stage: 'listing_repos'}}),
        ).toBe('Listing repositories…');
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
            repo_step: 'commits',
            repo_step_done: 1240,
            repo_step_scanned: null,
            repo_step_total: 5000,
        },
    } as const;

    it('shows the progress line and disables the Sync button while a run is in flight', async () => {
        providers = [{...structuredClone(DB_GITHUB), active_sync: structuredClone(RUNNING_SYNC)}];
        renderPage();
        const progress = await screen.findByTestId('sync-progress');
        // Rendered from the real server field names on the fixture: the within-repo
        // counter leads and the run-level totals are kept, not replaced (#270).
        expect(progress).toHaveTextContent(
            'Fetching activity — repo 3/12 (web) · commit 1240/5000 · run total 34 commits · 5 PRs',
        );
        // Deliberately NOT a live region: this line changes on nearly every 1s poll, so
        // role="status" would announce it once per second for a multi-hour sync. Pinned
        // so a future "accessibility improvement" cannot silently reinstate it — the
        // missing completion announcement is tracked in #278 instead.
        expect(progress).not.toHaveAttribute('role');
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
        createGithubProvider('new-org');

        // After the create + list refetch, the NEW provider's row carries an
        // open scope editor with the prompt — announced as a status live region
        // (a regression to a plain <p> must fail here).
        const prompt = await screen.findByTestId('scope-prompt');
        expect(prompt).toHaveTextContent(/Choose which repositories to analyze before the first sync/);
        expect(screen.getByRole('status')).toBe(prompt);
        // The create modal handed off cleanly: it closed, and the ONLY dialog now
        // on screen is the new row's scope editor (#238 criterion 4).
        expect(screen.queryByRole('dialog', {name: 'Add git provider'})).not.toBeInTheDocument();
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(screen.getByRole('dialog', {name: 'Repository scope — new-org'})).toBeInTheDocument();
        // It targets the just-created provider (its radio group), not another row.
        expect(document.querySelector('input[name="scope-p-new"]')).not.toBeNull();
        expect(document.querySelector('input[name="scope-p-gh"]')).toBeNull();
        // Default stays "Monitor all" until the admin chooses otherwise.
        expect(screen.getByRole('radio', {name: 'Monitor all repositories'})).toBeChecked();
    });

    it('closing the auto-opened editor dismisses the prompt without saving a scope', async () => {
        renderPage();
        createGithubProvider('new-org');
        await screen.findByTestId('scope-prompt');

        fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        // No PATCH was sent — the provider stays on the default monitor-all.
        expect(lastCall(/\/git\/providers\/p-new$/, 'PATCH')).toBeUndefined();
    });

    it('completes the canonical journey: create → prompt → select repos → save → prompt gone and stays gone', async () => {
        renderPage();
        createGithubProvider('new-org');
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
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        // …and stay closed after the post-save list refetch lands (the flag was
        // cleared, so the refetched row must not re-prompt): the row now shows
        // the saved scope.
        expect(await screen.findByText('1 selected')).toBeInTheDocument();
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
    });

    it('closing ANOTHER row\'s scope editor does not dismiss the just-created provider\'s prompt', async () => {
        renderPage();
        createGithubProvider('new-org');
        await screen.findByTestId('scope-prompt');

        // Open the pre-existing provider's modal from ITS row's Repos action,
        // then close it — the new provider's prompt must survive both. The
        // dialog-count assertions prove the other modal really opened and
        // closed (i.e. its closeScope RAN), so this test cannot pass vacuously
        // if the open/close path itself breaks.
        const ghRow = screen.getByText('acme-org').closest('tr') as HTMLElement;
        fireEvent.click(within(ghRow).getByRole('button', {name: 'Repos'}));
        expect(screen.getAllByRole('dialog')).toHaveLength(2);
        expect(screen.getByTestId('scope-prompt')).toBeInTheDocument();
        const ghDialog = screen.getByRole('dialog', {name: 'Repository scope — acme-org'});
        fireEvent.click(within(ghDialog).getByRole('button', {name: 'Cancel'}));
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(screen.getByTestId('scope-prompt')).toBeInTheDocument();
        expect(document.querySelector('input[name="scope-p-new"]')).not.toBeNull();
    });

    it('creating a second provider moves the one-shot prompt to it', async () => {
        renderPage();
        createGithubProvider('org-a', 'tok-a');
        await screen.findByTestId('scope-prompt');
        expect(document.querySelector('input[name="scope-p-new"]')).not.toBeNull();

        // Second create. The modal closed on the first success, so this reopens
        // it and refills — the add form no longer persists the previous values.
        createGithubProvider('org-b', 'tok-b');
        // Exactly ONE prompt remains and it now targets the second provider.
        await waitFor(() => {
            expect(document.querySelector('input[name="scope-p-new-2"]')).not.toBeNull();
        });
        expect(screen.getAllByTestId('scope-prompt')).toHaveLength(1);
        expect(document.querySelector('input[name="scope-p-new"]')).toBeNull();
    });

    it("the modal's close button dismisses the auto-opened editor and the prompt", async () => {
        renderPage();
        createGithubProvider('new-org');
        await screen.findByTestId('scope-prompt');

        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        // Re-opening from the new row's Repos action is a normal (non-prompted)
        // modal, and the never-saved provider is still on "Monitor all".
        const newRow = screen.getByText('new-org').closest('tr') as HTMLElement;
        fireEvent.click(within(newRow).getByRole('button', {name: 'Repos'}));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
        expect(screen.getByRole('radio', {name: 'Monitor all repositories'})).toBeChecked();
    });

    it('blocks saving an empty selection — the one-click Clear cannot silently disable collection', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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
        await screen.findByText('acme-org');
        openEditModal('acme-org');
        expect(screen.getByRole('dialog', {name: 'Edit GitHub provider'})).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));

        // Anchor on the edit dialog closing — only onDone closes it, so reaching
        // this proves the mutation's whole onSuccess chain (invalidation →
        // callbacks → onDone) settled; the prompt assertion can't race it. If a
        // scope modal HAD auto-opened, a dialog would still be on screen.
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
    });

    it('shows the keep-history data-policy note in the manually opened editor, without the add-flow prompt', async () => {
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        expect(await screen.findByTestId('scope-policy-note')).toHaveTextContent(
            /only affects future syncs — data already collected from deselected repositories is kept/,
        );
        expect(screen.queryByTestId('scope-prompt')).not.toBeInTheDocument();
    });

    it('Clear selection empties the picker so a few active repos can be ticked; Select all restores the non-archived set', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
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

    it('keeps select-mode Save disabled when /repos succeeds with an EMPTY list', async () => {
        // The third branch of the save guard: not pending, not errored — the
        // provider genuinely has no repositories. Saving would emit repos: [].
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = [];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));

        expect(await screen.findByText('No repositories found for this provider.')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeDisabled();
        // Monitor-all remains saveable — no repo-list dependency.
        fireEvent.click(screen.getByRole('radio', {name: 'Monitor all repositories'}));
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeEnabled();
    });

    it('keeps the auto-opened editor AND prompt open when the scope save fails, with the error surfaced', async () => {
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/git\/providers\/p-new$/.test(u) && method === 'PATCH') {
                return json({error: 'Bad Request', message: 'Scope rejected by the server'}, 400);
            }
            return base!(url, init);
        });
        renderPage();
        createGithubProvider('new-org');
        await screen.findByTestId('scope-prompt');

        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: /api/});
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));

        // The failed save surfaces the server's message and leaves both the
        // editor and the one-shot prompt in place so the admin can retry.
        expect(await screen.findByText('Scope rejected by the server')).toBeInTheDocument();
        expect(screen.getByTestId('scope-prompt')).toBeInTheDocument();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeEnabled();
    });

    it('opening a stored empty scope ("None selected") immediately shows the guard: warning visible, Save disabled', async () => {
        // A legacy-saved dead scope: repos_include '[]' round-trips as a real
        // empty selection, so the editor opens in select mode already empty.
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '[]'}];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        await screen.findByRole('checkbox', {name: /api/});

        expect(screen.getByTestId('empty-selection-warning')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeDisabled();
        // Recovery: ticking a repo lifts the guard.
        fireEvent.click(screen.getByRole('checkbox', {name: /api/}));
        expect(screen.getByRole('button', {name: 'Save scope'})).toBeEnabled();
    });
});

describe('AdminGitProviders — repo-scope modal (#213)', () => {
    async function openSelectMode(): Promise<void> {
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'api'});
    }

    it('opens as an accessible dialog from the Repos action, with Slug and Name columns', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        await openSelectMode();

        const dialog = screen.getByRole('dialog', {name: 'Repository scope — mono-org'});
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        // The opener announces that it launches a dialog.
        expect(screen.getByRole('button', {name: 'Repos'})).toHaveAttribute('aria-haspopup', 'dialog');
        // Table columns: canonical slug + display name, archived badge on the row.
        expect(within(dialog).getByRole('columnheader', {name: 'Slug'})).toBeInTheDocument();
        expect(within(dialog).getByRole('columnheader', {name: 'Name'})).toBeInTheDocument();
        expect(within(dialog).getByText('api')).toBeInTheDocument();
        expect(within(dialog).getByText('API Service')).toBeInTheDocument();
        expect(within(dialog).getByText('Old Legacy')).toBeInTheDocument();
        expect(within(dialog).getByText('Archived')).toBeInTheDocument();
        // The bulk-effect indicator is always visible in select mode.
        expect(within(dialog).getByTestId('selected-count')).toHaveTextContent('2 of 3 selected');
    });

    it('Escape closes the modal without saving', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        await openSelectMode();

        fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(lastCall(/\/git\/providers\/p-all$/, 'PATCH')).toBeUndefined();
    });

    // #265: flipped — a backdrop click no longer closes anything. Asserting the
    // dialog is still mounted is not enough: the harm this fixes is losing the
    // UNSAVED session, so the mode, the ticked set and the filter text are all
    // read back after the click.
    it('a backdrop click does NOT close the modal — the unsaved selection session survives', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        await openSelectMode();

        // Build real unsaved state: untick a repo (2 of 3 → 1 of 3) and filter.
        fireEvent.click(screen.getByRole('checkbox', {name: 'api'}));
        fireEvent.change(screen.getByLabelText('Filter repositories'), {target: {value: 'web'}});
        expect(screen.getByTestId('selected-count')).toHaveTextContent('1 of 3 selected');

        const backdrop = screen.getByTestId('repo-scope-modal-p-all-backdrop');
        // Drag that STARTS inside the dialog (e.g. selecting filter text) and
        // releases over the dim area must NOT discard the selection session.
        fireEvent.mouseDown(screen.getByLabelText('Filter repositories'));
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // …and neither does a press-and-release straight on the backdrop.
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);

        // Still open AND still carrying the session — the data-loss regression.
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByRole('radio', {name: 'Select repositories'})).toBeChecked();
        expect(screen.getByTestId('selected-count')).toHaveTextContent('1 of 3 selected');
        expect((screen.getByLabelText('Filter repositories') as HTMLInputElement).value).toBe('web');
        expect(lastCall(/\/git\/providers\/p-all$/, 'PATCH')).toBeUndefined();
    });

    it('no close affordance works while a save is in flight — the PATCH outcome cannot land invisibly', async () => {
        // Gate the PATCH so the save stays pending under our control.
        let releasePatch: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releasePatch = resolve;
        });
        providers = [structuredClone(DB_MONITOR_ALL)];
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/git\/providers\/p-all$/.test(u) && method === 'PATCH') {
                await gate;
            }
            return base!(url, init);
        });
        renderPage();
        await openSelectMode();
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        expect(await screen.findByRole('button', {name: 'Saving…'})).toBeInTheDocument();

        // Esc and the × button are both inert mid-save. The backdrop click below
        // is inert UNCONDITIONALLY since #265, so it no longer proves the guard.
        const dialog = screen.getByRole('dialog');
        fireEvent.keyDown(dialog, {key: 'Escape'});
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        const backdrop = screen.getByTestId('repo-scope-modal-p-all-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // Once the save settles, the modal closes through the success path.
        releasePatch?.();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('a plain save preserves a stored slug the listing no longer returns (extras)', async () => {
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '["api","gone"]'}];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        await screen.findByRole('checkbox', {name: 'api'});

        // No Select all, no Clear — just save the stored selection as-is.
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const sent = JSON.parse(
                String(lastCall(/\/git\/providers\/p-all$/, 'PATCH')?.[1]?.body),
            ) as Record<string, unknown>;
            // Listed slugs in repo-list order, then the preserved unlisted extra.
            expect(sent.repos).toEqual(['api', 'gone']);
        });
    });

    it('saving while a filter is active writes the FULL selection, not the filtered view', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        await openSelectMode();

        // Seeded selection = both non-archived repos. Filter down to one row,
        // then save: the payload must carry the whole selection — deriving it
        // from the filtered view would silently drop 'api' from the scope.
        fireEvent.change(screen.getByLabelText('Filter repositories'), {target: {value: 'web'}});
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const sent = JSON.parse(
                String(lastCall(/\/git\/providers\/p-all$/, 'PATCH')?.[1]?.body),
            ) as Record<string, unknown>;
            expect(sent.repos).toEqual(['api', 'web']);
        });
    });

    it('Select all acts on the FULL list even while a filter hides most rows', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = Array.from({length: 30}, (_, i) => ({
            slug: `repo-${i}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'repo-0'});

        fireEvent.click(screen.getByRole('button', {name: 'Clear selection'}));
        // Filter down to a single visible row, then Select all: the FULL list is
        // selected, not just the visible/filtered page.
        fireEvent.change(screen.getByLabelText('Filter repositories'), {target: {value: 'Repo 7'}});
        fireEvent.click(screen.getByRole('button', {name: 'Select all'}));
        expect(screen.getByTestId('selected-count')).toHaveTextContent('30 of 30 selected');
    });

    it('Escape in one stacked dialog closes only that dialog (the prompt survives)', async () => {
        renderPage();
        createGithubProvider('new-org');
        await screen.findByTestId('scope-prompt');

        const ghRow = screen.getByText('acme-org').closest('tr') as HTMLElement;
        fireEvent.click(within(ghRow).getByRole('button', {name: 'Repos'}));
        expect(screen.getAllByRole('dialog')).toHaveLength(2);

        const ghDialog = screen.getByRole('dialog', {name: 'Repository scope — acme-org'});
        fireEvent.keyDown(ghDialog, {key: 'Escape'});
        // Only the acme dialog closed; the prompted modal is untouched.
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(screen.getByTestId('scope-prompt')).toBeInTheDocument();
    });

    it('Escape while typing in the filter closes the dialog (standard dialog semantics, documented intent)', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        await openSelectMode();

        const filter = screen.getByLabelText('Filter repositories');
        filter.focus();
        fireEvent.keyDown(filter, {key: 'Escape'});
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(lastCall(/\/git\/providers\/p-all$/, 'PATCH')).toBeUndefined();
    });

    it('filters the table by slug or display name, case-insensitively, and clearing restores all rows', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        await openSelectMode();

        const filter = screen.getByLabelText('Filter repositories');
        // By slug.
        fireEvent.change(filter, {target: {value: 'web'}});
        expect(screen.getByRole('checkbox', {name: 'web'})).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', {name: 'api'})).not.toBeInTheDocument();
        // The selected-count denominator stays the FULL list while filtering —
        // that is the "bulk actions act on the full list" signal.
        expect(screen.getByTestId('selected-count')).toHaveTextContent('2 of 3 selected');
        // By display name, different case.
        fireEvent.change(filter, {target: {value: 'api SERVICE'}});
        expect(screen.getByRole('checkbox', {name: 'api'})).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', {name: 'web'})).not.toBeInTheDocument();
        // No match → empty-table message, and Save stays enabled (selection is intact).
        fireEvent.change(filter, {target: {value: 'nothing-matches'}});
        expect(screen.getByText('No repositories match the filter.')).toBeInTheDocument();
        // Clearing restores every row.
        fireEvent.change(filter, {target: {value: ''}});
        expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    });

    it('paginates at 10 rows per page; selection survives paging and filtering and saves the full set', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = Array.from({length: 30}, (_, i) => ({
            slug: `repo-${i}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'repo-0'});

        // Page 1 shows 10 of 30 rows (the new default); Previous is inert at the
        // lower bound, and the last-page repo is off page 1.
        expect(screen.getAllByRole('checkbox')).toHaveLength(10);
        expect(screen.getByRole('button', {name: 'Page 1'})).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', {name: 'Previous page'})).toBeDisabled();
        expect(screen.queryByRole('checkbox', {name: 'repo-29'})).not.toBeInTheDocument();

        // Clear (acts on the FULL list), tick one repo on page 1…
        fireEvent.click(screen.getByRole('button', {name: 'Clear selection'}));
        expect(screen.getByTestId('selected-count')).toHaveTextContent('0 of 30 selected');
        fireEvent.click(screen.getByRole('checkbox', {name: 'repo-0'}));

        // …one on the last page (Next is inert at the upper bound)…
        fireEvent.click(screen.getByRole('button', {name: 'Last page'}));
        expect(screen.getByRole('button', {name: 'Page 3'})).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', {name: 'Next page'})).toBeDisabled();
        expect(screen.getAllByRole('checkbox')).toHaveLength(10);
        fireEvent.click(screen.getByRole('checkbox', {name: 'repo-29'}));

        // …and one found via the filter (which resets to page 1 of the result;
        // a single-result page also hides the pagination controls entirely).
        fireEvent.change(screen.getByLabelText('Filter repositories'), {target: {value: 'Repo 7'}});
        expect(screen.queryByTestId('repo-pagination')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('checkbox', {name: 'repo-7'}));
        fireEvent.change(screen.getByLabelText('Filter repositories'), {target: {value: ''}});
        // Clearing the filter restarts from page 1 (the filter change resets the
        // page; the safePage clamp alone would have left the user on page 2).
        expect(screen.getByRole('button', {name: 'Page 1'})).toHaveAttribute('aria-current', 'page');

        // The selection accumulated across pages and filters…
        expect(screen.getByTestId('selected-count')).toHaveTextContent('3 of 30 selected');
        // …and page-1 state survived the round trip.
        expect(screen.getByRole('checkbox', {name: 'repo-0'})).toBeChecked();

        // Save writes the full selected set in repo-list order.
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const sent = JSON.parse(
                String(lastCall(/\/git\/providers\/p-all$/, 'PATCH')?.[1]?.body),
            ) as Record<string, unknown>;
            expect(sent.repos).toEqual(['repo-0', 'repo-7', 'repo-29']);
        });
    });

    it('hides pagination when the repo list fits on one page', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        renderPage();
        await openSelectMode();
        expect(screen.queryByTestId('repo-pagination')).not.toBeInTheDocument();
    });

    it('exactly 10 repos is still a single page (boundary)', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = Array.from({length: 10}, (_, i) => ({
            slug: `repo-${i}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'repo-0'});
        // 10 rows == the smallest offered size, so no pager and no size selector:
        // nothing any size could do would split one page.
        expect(screen.getAllByRole('checkbox')).toHaveLength(10);
        expect(screen.queryByTestId('repo-pagination')).not.toBeInTheDocument();
    });

    it('jumps directly to a numbered page (the old prev/next-only pager could not)', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        // 60 repos / 10 per page = 6 pages, so page 6 exists as a numbered target.
        repos = Array.from({length: 60}, (_, i) => ({
            slug: `repo-${String(i).padStart(2, '0')}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'repo-00'});

        // Sort by slug so page order is deterministic (repo-00 … repo-59).
        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        // A single numbered click leaps straight to page 6 — the last 10 rows.
        fireEvent.click(screen.getByRole('button', {name: 'Page 6'}));
        expect(screen.getByRole('button', {name: 'Page 6'})).toHaveAttribute('aria-current', 'page');
        expect(screen.getAllByRole('checkbox')).toHaveLength(10);
        expect(screen.getByRole('checkbox', {name: 'repo-50'})).toBeInTheDocument();
        expect(screen.getByRole('checkbox', {name: 'repo-59'})).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', {name: 'repo-00'})).not.toBeInTheDocument();
    });

    it('rows-per-page selector defaults to 10, re-slices the list, and persists the choice (#227)', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = Array.from({length: 30}, (_, i) => ({
            slug: `repo-${i}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'repo-0'});

        // Default 10/page.
        const select = screen.getByRole('combobox', {name: 'Rows per page'});
        expect(select).toHaveValue('10');
        expect(screen.getAllByRole('checkbox')).toHaveLength(10);

        // Bump to 25/page and confirm the slice grows + the choice is persisted.
        fireEvent.change(select, {target: {value: '25'}});
        expect(screen.getAllByRole('checkbox')).toHaveLength(25);
        expect(localStorage.getItem('toprope.rowsPerPage.repoScope')).toBe('25');

        // "All" shows every repo on one page and drops the numbered pager (the
        // selector itself stays, so the choice is reversible).
        fireEvent.change(screen.getByRole('combobox', {name: 'Rows per page'}), {
            target: {value: 'all'},
        });
        expect(screen.getAllByRole('checkbox')).toHaveLength(30);
        expect(
            screen.queryByRole('navigation', {name: 'Repository pages'}),
        ).not.toBeInTheDocument();
        expect(screen.getByRole('combobox', {name: 'Rows per page'})).toBeInTheDocument();
    });

    it('seeds the repo pager from a persisted rows-per-page choice (#227)', async () => {
        localStorage.setItem('toprope.rowsPerPage.repoScope', '25');
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = Array.from({length: 30}, (_, i) => ({
            slug: `repo-${i}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'repo-0'});

        // Opens straight at the stored 25/page, not the 10 default.
        expect(screen.getByRole('combobox', {name: 'Rows per page'})).toHaveValue('25');
        expect(screen.getAllByRole('checkbox')).toHaveLength(25);
    });

    it('footnotes stored slugs missing from the listing instead of blending them into the count', async () => {
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '["api","gone"]'}];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        await screen.findByRole('checkbox', {name: 'api'});
        // "gone" is selected (stored) but not listed: 1 listed of 3, +1 extra —
        // never "2 of 3" (or worse, a numerator above the denominator).
        expect(screen.getByTestId('selected-count')).toHaveTextContent(
            '1 of 3 selected (+1 not listed)',
        );
    });
});

describe('AdminGitProviders — sortable repo table (#215)', () => {
    /** Visible row order as checkbox aria-labels (= slugs), top to bottom. */
    const rowOrder = (): string[] =>
        screen.getAllByRole('checkbox').map((el) => el.getAttribute('aria-label') ?? '');

    // Slug and name orders deliberately DIVERGE — and 'delta' breaks a perfect
    // inversion, so no name-sorted sequence can alias a reversed slug-sorted
    // one (a comparator that sorted "name" by inverted slug would fail):
    //   slug asc:  alpha, bravo, charlie, delta
    //   name asc:  charlie (Alpha Tool), delta (Delta House), bravo (Mike App), alpha (Zulu Service)
    // The LISTING order below is shuffled so it matches neither slug nor name
    // order in either direction — the save-payload test can then prove the
    // payload derives from the listing, not from any normalized sort.
    const DIVERGENT_REPOS: RepoRow[] = [
        {slug: 'bravo', name: 'Mike App', archived: false, defaultBranch: 'main'},
        {slug: 'delta', name: 'Delta House', archived: false, defaultBranch: 'main'},
        {slug: 'alpha', name: 'Zulu Service', archived: false, defaultBranch: 'main'},
        {slug: 'charlie', name: 'Alpha Tool', archived: false, defaultBranch: 'main'},
    ];

    it('opens a stored selection selected-first, name-ordered within each group', async () => {
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '["web"]'}];
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        await screen.findByRole('checkbox', {name: 'web'});

        // Selected (web) first; unselected follow by name: API Service < Old Legacy.
        expect(rowOrder()).toEqual(['web', 'api', 'legacy']);
        // The active default sort is announced on the Selected header.
        expect(screen.getByRole('columnheader', {name: /Selected/})).toHaveAttribute(
            'aria-sort',
            'ascending',
        );
    });

    it('brings a stored selection from a later page onto page 1', async () => {
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '["repo-29"]'}];
        repos = Array.from({length: 30}, (_, i) => ({
            slug: `repo-${i}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        await screen.findByRole('checkbox', {name: 'repo-29'});

        // In listing order repo-29 lives on page 2; selection-first sorting
        // surfaces it as the very first row of page 1.
        expect(rowOrder()[0]).toBe('repo-29');
        expect(screen.getByRole('button', {name: 'Page 1'})).toHaveAttribute('aria-current', 'page');
    });

    it('sorts by slug and by name in both directions across the FULL list', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = structuredClone(DIVERGENT_REPOS);
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'alpha'});

        // Default (all selected via the seed) degrades to name order.
        expect(rowOrder()).toEqual(['charlie', 'delta', 'bravo', 'alpha']);

        // Slug ascending, then descending.
        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        expect(rowOrder()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
        expect(screen.getByRole('columnheader', {name: /Slug/})).toHaveAttribute('aria-sort', 'ascending');
        // Inactive headers announce no sort.
        expect(screen.getByRole('columnheader', {name: /^Name/})).toHaveAttribute('aria-sort', 'none');
        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        expect(rowOrder()).toEqual(['delta', 'charlie', 'bravo', 'alpha']);
        expect(screen.getByRole('columnheader', {name: /Slug/})).toHaveAttribute('aria-sort', 'descending');

        // Name ascending (NOT an inverted slug order — delta breaks the alias),
        // then descending.
        fireEvent.click(screen.getByRole('button', {name: /^Name/}));
        expect(rowOrder()).toEqual(['charlie', 'delta', 'bravo', 'alpha']);
        expect(screen.getByRole('columnheader', {name: /^Name/})).toHaveAttribute('aria-sort', 'ascending');
        fireEvent.click(screen.getByRole('button', {name: /^Name/}));
        expect(rowOrder()).toEqual(['alpha', 'bravo', 'delta', 'charlie']);
        expect(screen.getByRole('columnheader', {name: /^Name/})).toHaveAttribute('aria-sort', 'descending');
    });

    it('sorting is display-only: a save after sorting still writes the repo-list order', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = structuredClone(DIVERGENT_REPOS);
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'alpha'});

        // Sort descending by slug so the DISPLAY order inverts the listing…
        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        expect(rowOrder()).toEqual(['delta', 'charlie', 'bravo', 'alpha']);

        // …then save: the payload derives from the LISTING order — which the
        // fixture deliberately makes distinct from every sorted order.
        fireEvent.click(screen.getByRole('button', {name: 'Save scope'}));
        await waitFor(() => {
            const sent = JSON.parse(
                String(lastCall(/\/git\/providers\/p-all$/, 'PATCH')?.[1]?.body),
            ) as Record<string, unknown>;
            expect(sent.repos).toEqual(['bravo', 'delta', 'alpha', 'charlie']);
        });
    });

    it('a header sort reorders across page boundaries and restarts from page 1', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = Array.from({length: 30}, (_, i) => ({
            slug: `repo-${i}`,
            name: `Repo ${i}`,
            archived: false,
            defaultBranch: 'main',
        }));
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'repo-0'});

        // Move to page 2, then sort descending by slug: the sort applies to the
        // FULL list (repo-29, which lived on page 2, now heads page 1) and the
        // pager restarts from page 1, matching the filter's behavior.
        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        expect(screen.getByRole('button', {name: 'Page 1'})).toHaveAttribute('aria-current', 'page');
        expect(rowOrder()[0]).toBe('repo-29');
    });

    it('selection-status sort groups selected-then-name, toggles to unselected-first, and regroups live on tick', async () => {
        providers = [{...structuredClone(DB_MONITOR_ALL), repos_include: '["bravo"]'}];
        repos = structuredClone(DIVERGENT_REPOS);
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        await screen.findByRole('checkbox', {name: 'bravo'});

        // Selected group (bravo) first; unselected by name: Alpha Tool,
        // Delta House, Zulu Service.
        expect(rowOrder()).toEqual(['bravo', 'charlie', 'delta', 'alpha']);

        // Ticking a repo regroups it immediately (live view): charlie joins the
        // selected group, which stays name-ordered (Alpha Tool < Mike App).
        fireEvent.click(screen.getByRole('checkbox', {name: 'charlie'}));
        expect(rowOrder()).toEqual(['charlie', 'bravo', 'delta', 'alpha']);

        // Toggling the direction puts the unselected group first, still
        // name-ordered within each group, and announces the new direction.
        fireEvent.click(screen.getByRole('button', {name: /Selected/}));
        expect(rowOrder()).toEqual(['delta', 'alpha', 'charlie', 'bravo']);
        expect(screen.getByRole('columnheader', {name: /Selected/})).toHaveAttribute(
            'aria-sort',
            'descending',
        );
    });

    it('sorting composes with the filter (ordering applies to the filtered set)', async () => {
        providers = [structuredClone(DB_MONITOR_ALL)];
        repos = structuredClone(DIVERGENT_REPOS);
        renderPage();
        fireEvent.click(await screen.findByRole('button', {name: 'Repos'}));
        fireEvent.click(screen.getByRole('radio', {name: 'Select repositories'}));
        await screen.findByRole('checkbox', {name: 'alpha'});

        fireEvent.click(screen.getByRole('button', {name: /Slug/}));
        // 'o' matches bravo (slug), charlie (name "Alpha Tool"), and delta
        // (name "Delta House") — never alpha ("Zulu Service").
        fireEvent.change(screen.getByLabelText('Filter repositories'), {target: {value: 'o'}});
        expect(rowOrder()).toEqual(['bravo', 'charlie', 'delta']);
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

/**
 * #266 — the duplicate container is caught WHILE TYPING, beside the field, instead of only
 * after a pointless round-trip to the server.
 *
 * The comparison runs through the SERVER's `sameContainer`, so the case/whitespace variants
 * that used to create a second independent (and permanently double-counting) data set are all
 * flagged. It is an affordance, not the guard: the last test here proves the server's 409
 * still lands inline when the loaded list was stale.
 */
describe('findContainerConflict (#266)', () => {
    const rows: AdminGitProvider[] = [DB_GITHUB, CONFIG_GITLAB];

    it('matches exact, case-variant and whitespace-padded containers', () => {
        for (const typed of ['acme-org', 'ACME-ORG', 'Acme-Org ', '  acme-org']) {
            expect(findContainerConflict(rows, 'github', typed)?.id).toBe('p-gh');
        }
    });

    it('is scoped to the provider TYPE, and misses a free container', () => {
        // One container NAME under two families is two different data sets — not a conflict.
        expect(findContainerConflict(rows, 'gitlab', 'acme-org')).toBeNull();
        expect(findContainerConflict(rows, 'github', 'unclaimed')).toBeNull();
    });

    it('matches a read-only config-file provider too', () => {
        expect(findContainerConflict(rows, 'gitlab', 'TEAM ')?.id).toBe('config:gitlab:team');
    });

    it('treats a blank/whitespace-only container as unfinished, not as a conflict', () => {
        expect(findContainerConflict(rows, 'github', '')).toBeNull();
        expect(findContainerConflict(rows, 'github', '   ')).toBeNull();
    });
});

describe('AdminGitProviders — inline duplicate-container validation (#266)', () => {
    /** The container input's inline error message, or null when none is shown. */
    function containerError(): string | null {
        const field = screen.getByLabelText('Organization');
        const describedBy = field.getAttribute('aria-describedby');
        if (!describedBy) return null;
        return document.getElementById(describedBy)?.textContent ?? null;
    }

    function saveButton(): HTMLButtonElement {
        return screen.getByRole('button', {name: 'Add provider'}) as HTMLButtonElement;
    }

    it.each([
        ['an exact match', 'acme-org'],
        ['a case variant', 'ACME-ORG'],
        ['a trailing space', 'acme-org '],
        ['a leading space + mixed case', ' Acme-Org'],
    ])('flags %s inline beside the field and blocks Save', async (_label, typed) => {
        renderPage();
        await screen.findByText('acme-org');
        openAddModal();

        // A free container: no error, and Save is gated only by the missing token.
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'brand-new'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        expect(containerError()).toBeNull();
        expect(saveButton()).not.toBeDisabled();

        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: typed}});
        // Names the existing provider as the table spells it, and gives the remediation. The long
        // explanation deliberately lives ONLY in the server's 409 (see `containerConflictMessage`),
        // so there is no second copy of that prose on the client.
        expect(containerError()).toContain('GitHub · acme-org');
        expect(containerError()).toContain('already connected');
        expect(containerError()).toContain('edit or remove it');
        expect(screen.getByLabelText('Organization')).toHaveAttribute('aria-invalid', 'true');
        expect(saveButton()).toBeDisabled();

        // Correcting the value clears the error and re-enables Save.
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'acme-org-2'}});
        expect(containerError()).toBeNull();
        expect(screen.getByLabelText('Organization')).not.toHaveAttribute('aria-invalid');
        expect(saveButton()).not.toBeDisabled();

        // Nothing was ever sent for the colliding value.
        expect(lastCall(/\/git\/providers$/, 'POST')).toBeUndefined();
    });

    it('SENDS the normalized container, so the value validated is the value transmitted', async () => {
        // `buildInput` goes through the shared `normalizeContainer`, not a local `.trim()` — the
        // client's inline check casefolds, so a transmitted value that only trimmed would mean the
        // client validated one string and sent another. Harmless (the server re-normalizes) but it
        // is precisely the check/store asymmetry #266 exists to remove.
        renderPage();
        await screen.findByText('acme-org');
        openAddModal();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: '  Brand-NEW '}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        fireEvent.click(saveButton());

        await waitFor(() => expect(lastCall(/\/git\/providers$/, 'POST')).toBeDefined());
        const sent = JSON.parse(
            String(lastCall(/\/git\/providers$/, 'POST')?.[1]?.body),
        ) as Record<string, unknown>;
        expect(sent.container).toBe('brand-new');
    });

    it('flags a container owned by a read-only CONFIG-FILE provider, with its own remediation', async () => {
        renderPage();
        await screen.findByText('acme-org');
        openAddModal();
        // The config-file row is a GitLab group, so switch type first.
        fireEvent.change(screen.getByRole('combobox', {name: 'Provider type'}), {
            target: {value: 'gitlab'},
        });
        fireEvent.change(screen.getByLabelText('Group'), {target: {value: 'TEAM '}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'glpat-x'}});

        const field = screen.getByLabelText('Group');
        const message = document.getElementById(field.getAttribute('aria-describedby') ?? '')
            ?.textContent;
        // Remediation differs for a config-file owner: it cannot be edited from the UI at all.
        expect(message).toContain('config file');
        expect(message).toContain('GitLab · team');
        expect(screen.getByRole('button', {name: 'Add provider'})).toBeDisabled();
    });

    // AC8 — and note WHERE it is guaranteed: the check does not run on the edit path at all, so
    // this asserts the `isEdit` gate, not a self-exclusion predicate. The server-side proof that a
    // PATCH re-sending the provider's own container is a no-op rather than a refused move lives in
    // `tests/dashboard/admin-git-providers-container.test.ts` and `tests/git/providers-store.test.ts`.
    it('does NOT flag a provider as its own duplicate when editing it (AC8)', async () => {
        renderPage();
        await screen.findByText('acme-org');
        openEditModal('acme-org');

        // The container is pre-filled with this provider's own value and is immutable (#264).
        expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('acme-org');
        expect(containerError()).toBeNull();
        const save = screen.getByRole('button', {name: 'Save changes'});
        expect(save).not.toBeDisabled();

        // Saving without touching it goes through.
        fireEvent.click(save);
        await waitFor(() => expect(lastCall(/\/git\/providers\/[^/]+$/, 'PATCH')).toBeDefined());
    });

    it('never blocks the EDIT path on a container collision the admin cannot clear', async () => {
        // The container field is disabled on edit (#264 immutability), so a client-side conflict
        // there is unclearable from inside the dialog. And it is reachable: a config-file provider
        // added later for the same container would otherwise permanently disable Save on the
        // connected provider, blocking token rotation and enable/disable — neither of which
        // touches the container. Seeded here as a DB row that collides with the config row.
        providers = [
            {...structuredClone(DB_GITHUB), id: 'p-dbl', type: 'gitlab', container: 'team'},
            structuredClone(CONFIG_GITLAB),
        ];
        renderPage();
        await screen.findByText('Config');
        const row = screen.getAllByText('team')[0].closest('tr') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', {name: 'Edit'}));

        const field = screen.getByLabelText('Group');
        expect(field).not.toHaveAttribute('aria-invalid');
        expect(screen.getByRole('button', {name: 'Save changes'})).not.toBeDisabled();
    });

    it('keeps the server 409 authoritative: a STALE list still surfaces it inline (AC10)', async () => {
        // The list the client loaded does NOT contain the provider, so its own check passes —
        // exactly the window where another admin connected it between load and submit. The
        // server refuses, and the dialog must stay open and render that message.
        providers = [];
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const u = String(url);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (/\/admin\/data-sources$/.test(u)) {
                return json({data: {connectors: [], git_providers: []}});
            }
            if (/\/git\/providers$/.test(u) && method === 'POST') {
                return json(
                    {
                        error: 'Conflict',
                        message:
                            "A github provider for 'acme-org' already exists — it is owned by the connected provider p-gh.",
                    },
                    409,
                );
            }
            if (/\/git\/providers$/.test(u)) return json({data: providers});
            return json({error: 'not found'}, 404);
        });

        renderPage();
        await screen.findByText(/No providers connected yet/);
        openAddModal();
        fireEvent.change(screen.getByLabelText('Organization'), {target: {value: 'acme-org'}});
        fireEvent.change(screen.getByLabelText('Token'), {target: {value: 'ghp_secret'}});
        // No client-side error — the client cannot know.
        expect(containerError()).toBeNull();
        fireEvent.click(saveButton());

        // The server's typed message lands inside the still-open dialog.
        expect(
            await screen.findByText(/already exists — it is owned by the connected provider p-gh/),
        ).toBeInTheDocument();
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
    });
});
