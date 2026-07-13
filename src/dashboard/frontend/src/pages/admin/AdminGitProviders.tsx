import {useMemo, useState, type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
import {StatePanel} from '../../components/StatePanel';
import {Modal} from '../../components/Modal';
import {DataTable, type Column} from '../../components/DataTable';
import {
    useAdminDataSources,
    useAdminGitProviderRepos,
    useAdminGitProviders,
    useCreateAdminGitProvider,
    useDeleteAdminGitProvider,
    useSyncAdminGitProvider,
    useTestAdminGitProvider,
    useTestDraftGitProvider,
    useUpdateAdminGitProvider,
} from '../../hooks/useAdmin';
import type {
    AdminGitProvider,
    GitProviderActiveSync,
    GitProviderInput,
    GitProviderProbeResult,
    GitProviderRepo,
    GitProviderType,
} from '../../api/types';
import {ErrorText, PageHeader, PrimaryButton, SecondaryButton, SelectField, Table, Td, TextField, Th} from './adminUi';

/**
 * Admin → Connectors → Git (GC1.8 / #200). Lets an admin connect, test, edit,
 * remove, enable/disable, and sync git providers (GitHub, Bitbucket, GitLab incl.
 * self-hosted) entirely from the dashboard — no config-file edit, no CLI.
 *
 * The form is PROVIDER-DRIVEN: choosing a type renders the right container label,
 * auth-method selector, and token field(s) (Bitbucket `app_password` is the only
 * two-field case). Tokens are write-only end to end — the list shows only the
 * mask, and editing a provider without re-entering the token keeps the stored one.
 * Config-file providers appear read-only (no edit/remove/toggle/sync; test only).
 */

/**
 * The form's provider model: container label + the auth methods each type
 * exposes. This mirrors the server's fail-closed allowlist
 * (`AUTH_METHODS` in `admin/git-providers.ts`) — the server remains the trust
 * boundary that re-validates every write; this drives the UI's field rendering.
 */
interface ProviderMeta {
    label: string;
    containerLabel: string;
    containerPlaceholder: string;
    authMethods: {value: string; label: string}[];
}

const PROVIDER_META: Record<GitProviderType, ProviderMeta> = {
    github: {
        label: 'GitHub',
        containerLabel: 'Organization',
        containerPlaceholder: 'my-org',
        authMethods: [{value: 'token', label: 'Personal access token'}],
    },
    bitbucket: {
        label: 'Bitbucket',
        containerLabel: 'Workspace',
        containerPlaceholder: 'my-workspace',
        authMethods: [
            // `app_password` is the stored discriminant (kept for wire/DB
            // compatibility); Atlassian deprecated Bitbucket app passwords, so the
            // label reflects their replacement — an API token authenticated with the
            // Atlassian account email over the same Basic-auth path.
            {value: 'app_password', label: 'API token (email + token)'},
            {value: 'access_token', label: 'Access token'},
            {value: 'oauth', label: 'OAuth token'},
        ],
    },
    gitlab: {
        label: 'GitLab',
        containerLabel: 'Group',
        containerPlaceholder: 'my-group',
        authMethods: [
            {value: 'personal_access_token', label: 'Personal access token'},
            {value: 'oauth', label: 'OAuth token'},
            {value: 'job_token', label: 'Job token'},
        ],
    },
};

const PROVIDER_TYPES: GitProviderType[] = ['github', 'bitbucket', 'gitlab'];

/**
 * Indigo (accent) button for interactive actions like "Test connection". The
 * single orange primary CTA (Save) uses {@link PrimaryButton}; every other
 * interactive control is indigo per the color system.
 */
function AccentButton({
    children,
    onClick,
    disabled,
    title,
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            className="rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
        >
            {children}
        </button>
    );
}

/**
 * Parse a stored repo-filter JSON column (`repos_include`/`repos_exclude`) back
 * into a string array. `undefined` for null/absent OR malformed input — both mean
 * "no explicit filter". An explicit `[]` round-trips as an empty array (a real,
 * distinct "none" state), never coerced to undefined.
 */
export function parseReposList(json: string | null): string[] | undefined {
    if (!json) return undefined;
    try {
        const parsed: unknown = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
            return parsed as string[];
        }
    } catch {
        // Malformed stored filter — treat as unset.
    }
    return undefined;
}

/** Human "N selected" / "All" summary of a provider's repo-include filter. */
export function repoScopeLabel(reposInclude: string | null): string {
    const list = parseReposList(reposInclude);
    if (list === undefined) return 'All repos';
    return list.length === 0 ? 'None selected' : `${list.length} selected`;
}

/**
 * Carry a provider's stored `exclude_repos` filter into a write body untouched.
 * The server PATCH is a FULL-ROW REPLACE, so an omitted `exclude_repos` wipes the
 * stored value; every edit that doesn't intend to change exclusions must re-send
 * it. GitLab has no `exclude_repos` in its config shape, so it is only carried
 * for github/bitbucket.
 */
function preserveExcludeRepos(
    provider: Pick<AdminGitProvider, 'type' | 'repos_exclude'>,
    input: GitProviderInput,
): void {
    if (provider.type !== 'gitlab') {
        const exclude = parseReposList(provider.repos_exclude);
        if (exclude !== undefined) input.exclude_repos = exclude;
    }
}

/**
 * Round-trip a provider's stored repo scope into a write body. The server PATCH
 * is a FULL-ROW REPLACE (`updateProvider` always rewrites `repos_include`/
 * `repos_exclude`), so an omitted `repos` would silently wipe the stored filter
 * back to "monitor all". Edits that don't touch the repo scope (the add/edit
 * form, the enable/disable toggle) must re-send the existing scope untouched; the
 * repo-scope editor (#201) is the one path that intentionally rewrites `repos`.
 */
function preserveReposInput(
    provider: Pick<AdminGitProvider, 'type' | 'repos_include' | 'repos_exclude'>,
    input: GitProviderInput,
): void {
    const include = parseReposList(provider.repos_include);
    if (include !== undefined) input.repos = include;
    preserveExcludeRepos(provider, input);
}

/**
 * Build the identity fields every PATCH must carry (the server re-validates the
 * whole row on each write). Reused by the enable/disable toggle and the repo-scope
 * editor so the two can't drift. The token is intentionally omitted — a PATCH with
 * no token keeps the stored secret. `enabled` echoes the current state; callers
 * that flip it (the toggle) override it after.
 */
function providerIdentityInput(provider: AdminGitProvider): GitProviderInput {
    const input: GitProviderInput = {
        type: provider.type,
        container: provider.container,
        auth_method: provider.auth_method,
        enabled: provider.enabled,
    };
    if (
        provider.type === 'bitbucket' &&
        provider.auth_method === 'app_password' &&
        provider.auth_username
    ) {
        input.username = provider.auth_username;
    }
    if (provider.type === 'gitlab') {
        if (provider.url) input.url = provider.url;
        if (provider.include_subgroups !== null) input.include_subgroups = provider.include_subgroups;
    }
    return input;
}

/** Map a provider's `last_sync_status` to a badge tone. */
function syncTone(status: string | null): 'success' | 'danger' | 'neutral' {
    if (status === 'ok') return 'success';
    if (status === 'error') return 'danger';
    return 'neutral';
}

/**
 * Human-readable line for an in-flight sync's progress snapshot (#209) — stage
 * plus the counters that stage has meaningfully advanced. Exported for tests.
 */
export function syncProgressLabel(active: GitProviderActiveSync): string {
    const p = active.progress;
    if (!p) return 'Starting sync…';
    switch (p.stage) {
        case 'listing_repos':
            return 'Listing repositories…';
        case 'fetching': {
            const total = p.repos_total ?? 0;
            // repos_processed counts COMPLETED repos; the one in flight is +1,
            // clamped so the label never overshoots (12/12, not 13/12; 0/0).
            const position = Math.min(p.repos_processed + 1, total);
            const repo = p.current_repo ? ` (${p.current_repo})` : '';
            return `Fetching activity — repo ${position}/${total}${repo} · ${p.commits_fetched} commits · ${p.prs_fetched} PRs`;
        }
        case 'analyzing':
            return `Matching developers — ${p.developers_matched} matched`;
        case 'writing':
            return `Writing snapshots — ${p.developers_matched} developer${p.developers_matched === 1 ? '' : 's'} matched`;
    }
    // Runtime fallback, deliberately OUTSIDE the switch so the compiler still
    // enforces exhaustiveness over the union: p.stage is wire data, and a newer
    // backend can emit a stage this cached bundle doesn't know. Degrade to a
    // generic label, never a blank line.
    return 'Syncing…';
}

/** Small indeterminate spinner shown next to live sync progress. */
function Spinner(): JSX.Element {
    return (
        <span
            aria-hidden
            className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
        />
    );
}

/** Render the probe result (ok/error + hint) inline after a Test connection. */
function ProbeResultView({result}: {result: GitProviderProbeResult}): JSX.Element {
    if (result.ok) {
        return (
            <span className="text-sm font-medium text-success" role="status">
                ✓ Connection successful
            </span>
        );
    }
    return (
        <span className="text-sm text-danger" role="status">
            ✕ {result.error ?? 'Connection failed'}
            {result.hint ? <span className="block text-xs text-muted">{result.hint}</span> : null}
        </span>
    );
}

/**
 * The add/edit form. `editing` pre-fills the fields for an existing DB provider
 * (token stays blank → keep the stored secret); `null` is the add form (token
 * required). Keyed by the caller so switching add ⇄ edit remounts a clean state.
 *
 * `onCreated` (#211) fires with the server's created provider on the CREATE path
 * only — the page uses it to auto-open the new row's repo-scope editor so the
 * admin narrows the scope before the first sync. Edits never fire it.
 */
function ProviderForm({
    editing,
    onDone,
    onCreated,
}: {
    editing: AdminGitProvider | null;
    onDone: () => void;
    onCreated: (created: AdminGitProvider) => void;
}): JSX.Element {
    const create = useCreateAdminGitProvider();
    const update = useUpdateAdminGitProvider();
    const testDraft = useTestDraftGitProvider();

    const [type, setType] = useState<GitProviderType>(editing?.type ?? 'github');
    const [container, setContainer] = useState(editing?.container ?? '');
    const [authMethod, setAuthMethod] = useState(
        editing?.auth_method ?? PROVIDER_META[editing?.type ?? 'github'].authMethods[0].value,
    );
    const [token, setToken] = useState('');
    const [username, setUsername] = useState(editing?.auth_username ?? '');
    const [url, setUrl] = useState(editing?.url ?? '');
    const [includeSubgroups, setIncludeSubgroups] = useState(editing?.include_subgroups ?? false);

    const meta = PROVIDER_META[type];
    const isEdit = editing !== null;
    const isBitbucketAppPassword = type === 'bitbucket' && authMethod === 'app_password';

    // Switching provider type resets the auth method to that type's first option
    // (an auth method from another provider is never valid here).
    function changeType(next: string): void {
        const nextType = next as GitProviderType;
        setType(nextType);
        setAuthMethod(PROVIDER_META[nextType].authMethods[0].value);
    }

    function buildInput(): GitProviderInput {
        const input: GitProviderInput = {
            type,
            container: container.trim(),
            auth_method: authMethod,
        };
        // Token is write-only: send it only when the admin typed one. On edit a
        // blank token means "keep the stored secret" (omitted here).
        if (token.trim()) input.token = token.trim();
        if (isBitbucketAppPassword) input.username = username.trim();
        if (type === 'gitlab') {
            if (url.trim()) input.url = url.trim();
            input.include_subgroups = includeSubgroups;
        }
        // On edit, preserve the existing repo scope (the PATCH is a full replace).
        // On create there is no prior scope — leave it as "monitor all".
        if (editing) preserveReposInput(editing, input);
        return input;
    }

    // Bitbucket app_password requires a username (the server's parser rejects a
    // blank one) — gate both Save and Test on it so we never send a shape the
    // server will 400.
    const hasUsername = !isBitbucketAppPassword || username.trim() !== '';
    // A draft test needs a credential (server: tokenRequired). On edit without a
    // re-entered token, the admin uses the row's "Test" button instead.
    const canTest = token.trim() !== '' && container.trim() !== '' && hasUsername;
    const canSave = container.trim() !== '' && hasUsername && (isEdit || token.trim() !== '');
    const pending = create.isPending || update.isPending;

    function submit(): void {
        const input = buildInput();
        if (isEdit && editing) {
            update.mutate({id: editing.id, patch: input}, {onSuccess: onDone});
        } else {
            create.mutate(input, {
                onSuccess: (created) => {
                    onCreated(created);
                    onDone();
                },
            });
        }
    }

    return (
        <Card title={isEdit ? `Edit ${meta.label} provider` : 'Add git provider'}>
            <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-end gap-4">
                    <SelectField label="Provider type" value={type} onChange={changeType}>
                        {PROVIDER_TYPES.map((t) => (
                            <option key={t} value={t}>
                                {PROVIDER_META[t].label}
                            </option>
                        ))}
                    </SelectField>
                    <TextField
                        label={meta.containerLabel}
                        value={container}
                        onChange={setContainer}
                        placeholder={meta.containerPlaceholder}
                    />
                    {meta.authMethods.length > 1 ? (
                        <SelectField label="Auth method" value={authMethod} onChange={setAuthMethod}>
                            {meta.authMethods.map((m) => (
                                <option key={m.value} value={m.value}>
                                    {m.label}
                                </option>
                            ))}
                        </SelectField>
                    ) : null}
                </div>

                <div className="flex flex-wrap items-end gap-4">
                    {isBitbucketAppPassword ? (
                        <TextField
                            label="Atlassian account email"
                            value={username}
                            onChange={setUsername}
                            placeholder="you@company.com"
                        />
                    ) : null}
                    <TextField
                        label={isBitbucketAppPassword ? 'API token' : 'Token'}
                        value={token}
                        onChange={setToken}
                        type="password"
                        placeholder={
                            isEdit
                                ? `Leave blank to keep ${editing?.token_masked ?? 'existing'}`
                                : 'Paste token'
                        }
                    />
                    {type === 'gitlab' ? (
                        <>
                            <TextField
                                label="Self-hosted URL (optional)"
                                value={url}
                                onChange={setUrl}
                                placeholder="https://gitlab.example.com"
                            />
                            <label className="flex items-center gap-2 pb-1.5 text-sm text-foreground">
                                <input
                                    type="checkbox"
                                    checked={includeSubgroups}
                                    onChange={(e) => setIncludeSubgroups(e.target.checked)}
                                    className="h-4 w-4 accent-accent"
                                />
                                Include subgroups
                            </label>
                        </>
                    ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <PrimaryButton type="button" onClick={submit} disabled={!canSave || pending}>
                        {pending ? 'Saving…' : 'Save'}
                    </PrimaryButton>
                    <AccentButton
                        onClick={() => testDraft.mutate(buildInput())}
                        disabled={!canTest || testDraft.isPending}
                        title={canTest ? undefined : 'Enter a token to test the connection'}
                    >
                        {testDraft.isPending ? 'Testing…' : 'Test connection'}
                    </AccentButton>
                    {isEdit ? (
                        <button
                            type="button"
                            onClick={onDone}
                            className="text-sm font-medium text-muted hover:text-foreground"
                        >
                            Cancel
                        </button>
                    ) : null}
                    {testDraft.data ? <ProbeResultView result={testDraft.data} /> : null}
                    <ErrorText error={testDraft.isError ? testDraft.error : null} />
                    <ErrorText error={create.isError ? create.error : null} />
                    <ErrorText error={update.isError ? update.error : null} />
                </div>
            </div>
        </Card>
    );
}

/**
 * Per-provider repo-scope MODAL (GC1.9 / #201, redesigned in #213). Two modes:
 *  - "Monitor all repositories" (default) — the PATCH omits `repos`, so the server
 *    clears `repos_include` and every repo is analyzed.
 *  - "Select repositories" — loads the provider's repos via `/repos` and writes the
 *    checked SLUG set to `repos_include`. Repos render as a paginated, filterable
 *    table with Slug + Name columns; archived repos are listed but excluded from
 *    the default selection.
 * The write reuses {@link providerIdentityInput} + {@link preserveExcludeRepos} so
 * it carries the full row (the server re-validates every write) and never disturbs
 * `exclude_repos`. Selection is keyed on `slug` — the canonical identifier stored
 * scope filters match against; `name` is display-only.
 *
 * `prompt` (#211) renders the just-connected intro asking the admin to narrow the
 * scope before the first sync — the add flow auto-opens the modal with it.
 */
const REPO_PAGE_SIZE = 25;

function RepoScopeModal({
    provider,
    onClose,
    prompt,
}: {
    provider: AdminGitProvider;
    onClose: () => void;
    prompt: boolean;
}): JSX.Element {
    const stored = parseReposList(provider.repos_include);
    const [mode, setMode] = useState<'all' | 'select'>(stored === undefined ? 'all' : 'select');
    // null → follow the derived default seed; a concrete Set → the admin's edits.
    const [edited, setEdited] = useState<Set<string> | null>(null);
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(0);
    const repos = useAdminGitProviderRepos(provider.id, mode === 'select');
    const update = useUpdateAdminGitProvider();

    const repoList = repos.data ?? [];
    // Every non-archived repo — the single source for both the default seed and
    // the "Select all" bulk action, so the two can't drift apart.
    const allNonArchived = useMemo(
        () => new Set(repoList.filter((r) => !r.archived).map((r) => r.slug)),
        [repoList],
    );
    // Default selection when entering select mode: the stored include list if the
    // provider already has one, else every NON-archived repo (archived excluded by
    // default). Recomputes as the repo list loads; overridden once the admin edits.
    const defaultSeed = stored !== undefined ? new Set(stored) : allNonArchived;
    const selected = edited ?? defaultSeed;

    // Case-insensitive substring filter over slug OR display name; pagination
    // applies to the FILTERED list. The page index is clamped (not reset via an
    // effect) so shrinking the result set can never leave an out-of-range page.
    const query = filter.trim().toLowerCase();
    const filtered = query
        ? repoList.filter(
              (r) => r.slug.toLowerCase().includes(query) || r.name.toLowerCase().includes(query),
          )
        : repoList;
    const pageCount = Math.max(1, Math.ceil(filtered.length / REPO_PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const visibleRows = filtered.slice(safePage * REPO_PAGE_SIZE, (safePage + 1) * REPO_PAGE_SIZE);

    function toggleRepo(slug: string, checked: boolean): void {
        const next = new Set(selected);
        if (checked) next.add(slug);
        else next.delete(slug);
        setEdited(next);
    }

    // Table columns: checkbox / Slug / Name (+ archived badge). Selection and
    // filtering already control the order and visible set, so column sorting is
    // deliberately off. The checkbox is labelled by the SLUG (the identifier the
    // save writes), not the display name.
    const columns: Column<GitProviderRepo>[] = [
        {
            key: 'selected',
            header: '',
            sortable: false,
            render: (r) => (
                <input
                    type="checkbox"
                    aria-label={r.slug}
                    checked={selected.has(r.slug)}
                    onChange={(e) => toggleRepo(r.slug, e.target.checked)}
                    className="h-4 w-4 accent-accent"
                />
            ),
        },
        {key: 'slug', header: 'Slug', accessor: (r) => r.slug, sortable: false},
        {
            key: 'name',
            header: 'Name',
            accessor: (r) => r.name,
            sortable: false,
            render: (r) => (
                <span className="flex items-center gap-2">
                    {r.name}
                    {r.archived ? (
                        <Badge tone="neutral" title="Archived — excluded by default">
                            Archived
                        </Badge>
                    ) : null}
                </span>
            ),
        },
    ];

    // In "select" mode the selection derives from the loaded repo list, so a save
    // must NOT proceed until that list is available: saving over an unloaded,
    // errored, or empty repo source would emit `repos: []` and silently flip the
    // provider from "monitor all" to "analyze nothing" (the PATCH is a full-row
    // replace). The same guard covers an EMPTY selection (#211): "Clear selection"
    // makes it a one-click state, and a saved `repos: []` is a silent kill switch
    // on collection — disabling the provider is the intended way to pause it.
    // "Monitor all" mode has no such dependency and is always saveable.
    const selectSourceReady = repos.isSuccess && repoList.length > 0;
    const emptySelection = mode === 'select' && selectSourceReady && selected.size === 0;
    const canSave =
        !update.isPending && (mode === 'all' || (selectSourceReady && !emptySelection));

    function save(): void {
        // Self-enforcing mirror of the button's disabled state: no future caller
        // (keyboard wiring, form submit) may bypass the empty-selection guard.
        if (!canSave) return;
        const patch = providerIdentityInput(provider);
        preserveExcludeRepos(provider, patch);
        if (mode === 'select') {
            // Deterministic order: repo-list order for listed slugs, then any stored
            // names no longer present (kept so a save can't silently drop them).
            const listed = repoList.filter((r) => selected.has(r.slug)).map((r) => r.slug);
            const extras = [...selected].filter((s) => !repoList.some((r) => r.slug === s)).sort();
            patch.repos = [...listed, ...extras];
        }
        // mode === 'all': omit `repos` → the server clears the filter (monitor all).
        update.mutate({id: provider.id, patch}, {onSuccess: onClose});
    }

    return (
        <Modal title={`Repository scope — ${provider.container}`} onClose={onClose} testId="repo-scope-modal">
            {prompt ? (
                <p className="mb-3 text-sm text-foreground" role="status" data-testid="scope-prompt">
                    Provider connected. Choose which repositories to analyze before the first sync —
                    large workspaces often contain many inactive repositories, and narrowing the scope
                    keeps syncs fast and the data relevant.
                </p>
            ) : null}
            <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                        type="radio"
                        name={`scope-${provider.id}`}
                        checked={mode === 'all'}
                        onChange={() => setMode('all')}
                        className="h-4 w-4 accent-accent"
                    />
                    Monitor all repositories
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                        type="radio"
                        name={`scope-${provider.id}`}
                        checked={mode === 'select'}
                        onChange={() => setMode('select')}
                        className="h-4 w-4 accent-accent"
                    />
                    Select repositories
                </label>
            </div>

            {mode === 'select' ? (
                <div className="mt-3" data-testid="repo-picker">
                    {repos.isPending ? (
                        <p className="text-sm text-muted">Loading repositories…</p>
                    ) : repos.isError ? (
                        <p className="text-sm text-danger">
                            Couldn’t load repositories: {repos.error.message}
                        </p>
                    ) : repoList.length === 0 ? (
                        <p className="text-sm text-muted">No repositories found for this provider.</p>
                    ) : (
                        <>
                            {/* Bulk toggles: with hundreds of repos and only a handful
                                active, per-checkbox editing from the all-selected seed
                                is impractical — clear first, then tick the active few.
                                Both operate on the FULL repo list, not the filtered
                                page. "Select all" IS the default seed and deliberately
                                rebuilds from the LISTED repos: opted-in archived repos
                                are reset (re-tickable individually), and stored names
                                absent from the listing are dropped — those have no
                                checkbox, so once cleared they can only be restored by
                                re-saving via API. */}
                            <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
                                <div className="flex gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setEdited(new Set(allNonArchived))}
                                        title="Selects every non-archived repository"
                                        className="text-xs font-medium text-accent hover:underline"
                                    >
                                        Select all
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setEdited(new Set())}
                                        className="text-xs font-medium text-accent hover:underline"
                                    >
                                        Clear selection
                                    </button>
                                </div>
                                {/* Bulk actions affect rows on every page — keep the
                                    total selected count in permanent view. */}
                                <span className="text-xs text-muted" data-testid="selected-count">
                                    {selected.size} of {repoList.length} selected
                                </span>
                            </div>
                            <TextField
                                label="Filter repositories"
                                value={filter}
                                onChange={(v) => {
                                    setFilter(v);
                                    setPage(0);
                                }}
                                placeholder="Filter by slug or name"
                            />
                            <div className="mt-2">
                                <DataTable
                                    columns={columns}
                                    rows={visibleRows}
                                    getRowKey={(r) => r.slug}
                                    caption="Repositories"
                                    emptyMessage="No repositories match the filter."
                                />
                            </div>
                            {pageCount > 1 ? (
                                <div className="mt-2 flex items-center gap-3" data-testid="repo-pagination">
                                    <SecondaryButton
                                        onClick={() => setPage(Math.max(0, safePage - 1))}
                                        disabled={safePage === 0}
                                    >
                                        Previous
                                    </SecondaryButton>
                                    <span className="text-sm text-muted">
                                        Page {safePage + 1} of {pageCount}
                                    </span>
                                    <SecondaryButton
                                        onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                                        disabled={safePage === pageCount - 1}
                                    >
                                        Next
                                    </SecondaryButton>
                                </div>
                            ) : null}
                            {emptySelection ? (
                                <p className="mt-2 text-sm text-danger" data-testid="empty-selection-warning">
                                    Select at least one repository — an empty selection would analyze
                                    nothing. To pause collection entirely, disable the provider instead.
                                </p>
                            ) : null}
                        </>
                    )}
                </div>
            ) : null}

            {/* Deactivation data policy (#211): narrowing is forward-looking only. */}
            <p className="mt-3 text-xs text-muted" data-testid="scope-policy-note">
                Changing the scope only affects future syncs — data already collected from
                deselected repositories is kept.
            </p>

            <div className="mt-4 flex items-center gap-3">
                <PrimaryButton type="button" onClick={save} disabled={!canSave}>
                    {update.isPending ? 'Saving…' : 'Save scope'}
                </PrimaryButton>
                <SecondaryButton onClick={onClose} disabled={update.isPending}>
                    Cancel
                </SecondaryButton>
                <ErrorText error={update.isError ? update.error : null} />
            </div>
        </Modal>
    );
}

/**
 * One row in the connected-providers table (DB or read-only config).
 *
 * `promptScope` (#211): true for a provider the admin JUST connected — the row
 * mounts with the repo-scope editor open and an intro prompting a selection
 * before the first sync. `onScopeClose` clears that page-level flag when the
 * editor closes (save or cancel), so it never re-prompts.
 */
function ProviderRow({
    provider,
    onEdit,
    promptScope,
    onScopeClose,
}: {
    provider: AdminGitProvider;
    onEdit: (p: AdminGitProvider) => void;
    promptScope: boolean;
    onScopeClose: () => void;
}): JSX.Element {
    const update = useUpdateAdminGitProvider();
    const remove = useDeleteAdminGitProvider();
    const sync = useSyncAdminGitProvider();
    const test = useTestAdminGitProvider();
    const [scopeOpen, setScopeOpen] = useState(false);
    // Derived (not mount-time-seeded): the create flow's hook-level invalidation
    // is awaited BEFORE the created callback runs, so this row mounts from the
    // refetched list first and the prompt flag lands on a re-render — a
    // mount-seeded useState would read false and never open. Do not "simplify"
    // this into an initial-state seed.
    const scopeVisible = scopeOpen || promptScope;

    function closeScope(): void {
        setScopeOpen(false);
        // Clear the page's just-created flag only when THIS row owns the prompt:
        // closing another row's editor must not dismiss the new provider's
        // auto-opened editor (and discard its unsaved picker state).
        if (promptScope) onScopeClose();
    }

    const isConfig = provider.source === 'config';
    const meta = PROVIDER_META[provider.type];
    // A run is in flight server-side (from the polled list) OR the trigger POST
    // is still pending — either way the button stays down and shows progress.
    const syncRunning = provider.active_sync !== null || sync.isPending;

    function toggleEnabled(): void {
        // A PATCH must carry the full provider identity (the server re-validates);
        // the token is omitted so the stored secret is kept.
        const patch = providerIdentityInput(provider);
        patch.enabled = !provider.enabled;
        // The PATCH is a full-row replace — carry the existing repo scope so a
        // simple enable/disable toggle can't silently reset it to "monitor all".
        preserveReposInput(provider, patch);
        update.mutate({id: provider.id, patch});
    }

    return (
        <>
            <tr className="border-b border-border/60">
                <Td>
                    <span className="font-medium text-foreground">{meta.label}</span>
                    {isConfig ? (
                        <Badge tone="neutral" className="ml-2" title="Managed in the config file — read-only">
                            Config
                        </Badge>
                    ) : null}
                </Td>
                <Td>{provider.container}</Td>
                <Td>
                    <code className="font-mono text-xs text-muted">{provider.token_masked}</code>
                </Td>
                <Td>
                    {isConfig ? (
                        <Badge tone="success">Enabled</Badge>
                    ) : (
                        <button
                            type="button"
                            onClick={toggleEnabled}
                            disabled={update.isPending}
                            aria-pressed={provider.enabled}
                            className={[
                                'rounded-full px-3 py-0.5 text-xs font-medium transition-colors disabled:opacity-50',
                                provider.enabled
                                    ? 'bg-accent text-white'
                                    : 'bg-surface-raised text-muted',
                            ].join(' ')}
                        >
                            {provider.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                    )}
                </Td>
                <Td>
                    {/* Scope summary is plain text (#213); editing moved to the
                        explicit "Repos" action button in the Actions column. */}
                    {repoScopeLabel(provider.repos_include)}
                </Td>
                <Td>
                    <Badge tone={syncTone(provider.last_sync_status)}>
                        {provider.last_sync_status ?? 'never'}
                    </Badge>
                    {provider.last_sync_at ? (
                        <span className="ml-2 text-xs text-muted">
                            {new Date(provider.last_sync_at).toLocaleString()}
                        </span>
                    ) : null}
                </Td>
                <Td>
                    <div className="flex flex-wrap items-center gap-2">
                        <AccentButton
                            onClick={() => test.mutate(provider.id)}
                            disabled={test.isPending}
                        >
                            {test.isPending ? 'Testing…' : 'Test'}
                        </AccentButton>
                        {!isConfig ? (
                            <>
                                <AccentButton
                                    onClick={() => sync.mutate(provider.id)}
                                    disabled={syncRunning || !provider.enabled}
                                    title={provider.enabled ? undefined : 'Enable the provider to sync'}
                                >
                                    {syncRunning ? 'Syncing…' : 'Sync now'}
                                </AccentButton>
                                <AccentButton
                                    onClick={() => setScopeOpen(true)}
                                    title="Choose which repositories to analyze"
                                >
                                    Repos
                                </AccentButton>
                                <button
                                    type="button"
                                    onClick={() => onEdit(provider)}
                                    className="text-sm font-medium text-accent hover:underline"
                                >
                                    Edit
                                </button>
                                <button
                                    type="button"
                                    onClick={() => remove.mutate(provider.id)}
                                    disabled={remove.isPending}
                                    className="text-sm font-medium text-danger hover:underline disabled:opacity-50"
                                >
                                    Remove
                                </button>
                            </>
                        ) : null}
                    </div>
                </Td>
            </tr>
            {provider.active_sync ? (
                <tr>
                    <td colSpan={7} className="px-3 pb-3">
                        <span
                            className="flex items-center gap-2 text-sm text-muted"
                            role="status"
                            data-testid="sync-progress"
                        >
                            <Spinner />
                            {syncProgressLabel(provider.active_sync)}
                        </span>
                    </td>
                </tr>
            ) : null}
            {sync.isError ? (
                <tr>
                    <td colSpan={7} className="px-3 pb-3">
                        <ErrorText error={sync.error} />
                    </td>
                </tr>
            ) : null}
            {test.data ? (
                <tr>
                    <td colSpan={7} className="px-3 pb-3">
                        <ProbeResultView result={test.data} />
                    </td>
                </tr>
            ) : null}
            {/* The modal renders through a portal, so mounting it between table
                rows is legal — no DOM ends up inside the table. */}
            {scopeVisible && !isConfig ? (
                <RepoScopeModal provider={provider} onClose={closeScope} prompt={promptScope} />
            ) : null}
        </>
    );
}

/**
 * A short link to developer-identity management. Connecting a provider only
 * produces data for developers whose git identities are mapped; unmatched authors
 * are dropped (design §10, findings #1/#2). Shown both in the cold-start onboarding
 * and (post-connect) beneath the form so the admin knows where to resolve gaps.
 */
function IdentityMappingLink(): JSX.Element {
    return (
        <Link to="/admin/identities" className="font-medium text-accent hover:underline">
            Manage developer identities
        </Link>
    );
}

/**
 * Cold-start onboarding (GC1.9 / #201): shown only when there is genuinely nothing
 * yet — no providers connected AND no git snapshots collected. Fixes the previous
 * empty-dropdown confusion (finding #3) by pointing the admin at the add form and
 * flagging the identity-mapping caveat up front.
 */
function GitEmptyState(): JSX.Element {
    return (
        <StatePanel
            tone="accent"
            testId="git-empty-state"
            icon={<span aria-hidden>🔌</span>}
            title="Connect your first git provider"
            description="No git providers are connected and no activity has been collected yet. Add a provider below to start analyzing commits, PRs, and churn."
        >
            <p className="text-sm text-muted">
                After connecting, only developers whose git identities are mapped will appear in the
                data. <IdentityMappingLink />.
            </p>
        </StatePanel>
    );
}

/**
 * Admin → Connectors → Git. Connected-provider list + provider-driven add/edit
 * form + per-provider repo-scope editor + cold-start onboarding. Reached only by
 * admins (route + API both gate it).
 */
export function AdminGitProviders(): JSX.Element {
    const providers = useAdminGitProviders();
    const dataSources = useAdminDataSources();
    const [editing, setEditing] = useState<AdminGitProvider | null>(null);
    // The provider the admin JUST connected (#211): its row mounts with the
    // repo-scope editor open, prompting a selection before the first sync.
    // Cleared when that editor closes (save or cancel) so it never re-prompts.
    const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

    const providerList = providers.data ?? [];
    const hasProviders = providerList.length > 0;
    // "No snapshots" = no git activity has ever been collected. /admin/data-sources
    // reports per-provider developer counts from git_snapshots; any positive count
    // means data exists. Snapshot state is only KNOWN once data-sources has loaded —
    // until then (or on a load error) we assume data may exist and suppress the
    // empty state, so it can never flash over a populated install.
    const hasSnapshots = dataSources.data
        ? dataSources.data.git_providers.some((g) => g.developer_count > 0)
        : true;
    const showEmptyState = !providers.isPending && !hasProviders && !hasSnapshots;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Git providers"
                description="Connect GitHub, Bitbucket, and GitLab repositories for analysis."
            />
            {showEmptyState ? <GitEmptyState /> : null}
            <ProviderForm
                key={editing?.id ?? 'new'}
                editing={editing}
                onDone={() => setEditing(null)}
                // Creating a second provider deliberately moves the one-shot
                // prompt to it — the previous provider's prompt is dismissed.
                onCreated={(created) => setJustCreatedId(created.id)}
            />
            {hasProviders ? (
                <p className="text-sm text-muted" data-testid="identity-mapping-note">
                    Only developers whose git identities are mapped produce activity data — unmatched
                    authors are dropped. <IdentityMappingLink />.
                </p>
            ) : null}
            <Card title="Connected providers">
                {providers.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : providers.isError ? (
                    <p className="text-sm text-danger">Failed to load: {providers.error.message}</p>
                ) : !hasProviders ? (
                    <p className="text-sm text-muted">
                        No providers connected yet. Add one above to start analyzing git activity.
                    </p>
                ) : (
                    <Table
                        head={
                            <>
                                <Th>Type</Th>
                                <Th>Container</Th>
                                <Th>Token</Th>
                                <Th>Enabled</Th>
                                <Th>Repos</Th>
                                <Th>Last sync</Th>
                                <Th>Actions</Th>
                            </>
                        }
                    >
                        {providerList.map((p) => (
                            <ProviderRow
                                key={p.id}
                                provider={p}
                                onEdit={setEditing}
                                promptScope={p.id === justCreatedId}
                                onScopeClose={() => setJustCreatedId(null)}
                            />
                        ))}
                    </Table>
                )}
            </Card>
        </div>
    );
}
