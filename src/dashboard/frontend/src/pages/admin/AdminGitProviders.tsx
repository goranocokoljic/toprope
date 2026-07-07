import {useState, type ReactNode} from 'react';
import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
import {
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
    GitProviderInput,
    GitProviderProbeResult,
    GitProviderType,
} from '../../api/types';
import {ErrorText, PageHeader, PrimaryButton, SelectField, Table, Td, TextField, Th} from './adminUi';

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
            {value: 'app_password', label: 'App password (username + password)'},
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
 * Round-trip a provider's stored repo scope into a write body. The server PATCH
 * is a FULL-ROW REPLACE (`updateProvider` always rewrites `repos_include`/
 * `repos_exclude`), so an omitted `repos` would silently wipe the stored filter
 * back to "monitor all". This form has no repo picker (that's #201), so any
 * edit/toggle must re-send the existing scope untouched. GitLab has no
 * `exclude_repos` in its config shape, so it is only carried for github/bitbucket.
 */
function preserveReposInput(
    provider: Pick<AdminGitProvider, 'type' | 'repos_include' | 'repos_exclude'>,
    input: GitProviderInput,
): void {
    const include = parseReposList(provider.repos_include);
    if (include !== undefined) input.repos = include;
    if (provider.type !== 'gitlab') {
        const exclude = parseReposList(provider.repos_exclude);
        if (exclude !== undefined) input.exclude_repos = exclude;
    }
}

/** Map a provider's `last_sync_status` to a badge tone. */
function syncTone(status: string | null): 'success' | 'danger' | 'neutral' {
    if (status === 'ok') return 'success';
    if (status === 'error') return 'danger';
    return 'neutral';
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
 */
function ProviderForm({
    editing,
    onDone,
}: {
    editing: AdminGitProvider | null;
    onDone: () => void;
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
            create.mutate(input, {onSuccess: onDone});
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
                            label="Username"
                            value={username}
                            onChange={setUsername}
                            placeholder="bitbucket-username"
                        />
                    ) : null}
                    <TextField
                        label={isBitbucketAppPassword ? 'App password' : 'Token'}
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

/** One row in the connected-providers table (DB or read-only config). */
function ProviderRow({
    provider,
    onEdit,
}: {
    provider: AdminGitProvider;
    onEdit: (p: AdminGitProvider) => void;
}): JSX.Element {
    const update = useUpdateAdminGitProvider();
    const remove = useDeleteAdminGitProvider();
    const sync = useSyncAdminGitProvider();
    const test = useTestAdminGitProvider();

    const isConfig = provider.source === 'config';
    const meta = PROVIDER_META[provider.type];

    function toggleEnabled(): void {
        // A PATCH must carry the full provider identity (the server re-validates);
        // the token is omitted so the stored secret is kept.
        const patch: GitProviderInput = {
            type: provider.type,
            container: provider.container,
            auth_method: provider.auth_method,
            enabled: !provider.enabled,
        };
        if (provider.type === 'bitbucket' && provider.auth_method === 'app_password' && provider.auth_username) {
            patch.username = provider.auth_username;
        }
        if (provider.type === 'gitlab') {
            if (provider.url) patch.url = provider.url;
            if (provider.include_subgroups !== null) patch.include_subgroups = provider.include_subgroups;
        }
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
                <Td>{repoScopeLabel(provider.repos_include)}</Td>
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
                                    disabled={sync.isPending || !provider.enabled}
                                    title={provider.enabled ? undefined : 'Enable the provider to sync'}
                                >
                                    {sync.isPending ? 'Syncing…' : 'Sync now'}
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
            {test.data ? (
                <tr>
                    <td colSpan={7} className="px-3 pb-3">
                        <ProbeResultView result={test.data} />
                    </td>
                </tr>
            ) : null}
        </>
    );
}

/**
 * Admin → Connectors → Git. Connected-provider list + provider-driven add/edit
 * form. Reached only by admins (route + API both gate it).
 */
export function AdminGitProviders(): JSX.Element {
    const providers = useAdminGitProviders();
    const [editing, setEditing] = useState<AdminGitProvider | null>(null);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Git providers"
                description="Connect GitHub, Bitbucket, and GitLab repositories for analysis."
            />
            <ProviderForm key={editing?.id ?? 'new'} editing={editing} onDone={() => setEditing(null)} />
            <Card title="Connected providers">
                {providers.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : providers.isError ? (
                    <p className="text-sm text-danger">Failed to load: {providers.error.message}</p>
                ) : (providers.data ?? []).length === 0 ? (
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
                        {(providers.data ?? []).map((p) => (
                            <ProviderRow key={p.id} provider={p} onEdit={setEditing} />
                        ))}
                    </Table>
                )}
            </Card>
        </div>
    );
}
