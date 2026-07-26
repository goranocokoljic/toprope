import {useMemo, useState, type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
import {StatePanel} from '../../components/StatePanel';
import {FormModal} from '../../components/FormModal';
import {useModalState} from '../../components/useModalState';
import {DataTable, type Column, type SortState} from '../../components/DataTable';
import {Pagination} from '../../components/Pagination';
import {
    DEFAULT_PAGE_SIZE_OPTIONS,
    isPaginationVisible,
    loadPageSize,
    savePageSize,
    type PageSizeOption,
} from '../../components/usePagination';
import {
    useAdminDataSources,
    useAdminGitProviderRepos,
    useAdminGitProviders,
    useCreateAdminGitProvider,
    useDeleteAdminGitProvider,
    useGitProviderDeleteImpact,
    useSyncAdminGitProvider,
    useSyncOlderHistoryGitProvider,
    useTestAdminGitProvider,
    useTestDraftGitProvider,
    useUpdateAdminGitProvider,
} from '../../hooks/useAdmin';
import type {
    AdminGitProvider,
    GitProviderActiveSync,
    GitProviderDeleteResult,
    GitProviderInput,
    GitProviderProbeResult,
    GitProviderRepo,
    GitProviderType,
} from '../../api/types';
import {
    AdminBanner,
    ErrorText,
    PageHeader,
    PrimaryButton,
    SelectField,
    Table,
    Td,
    TextField,
    Th,
} from './adminUi';

/**
 * Admin → Connectors → Git (GC1.8 / #200). Lets an admin connect, test, edit,
 * remove, enable/disable, and sync git providers (GitHub, Bitbucket, GitLab incl.
 * self-hosted) entirely from the dashboard — no config-file edit, no CLI.
 *
 * The add/edit form lives in a `FormModal` (#238) opened from the header's
 * "＋ Add git provider" button or a row's "Edit" — the connected-providers table is
 * the page's primary content, and nothing renders over it unasked.
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

// First-sync history-window bounds (months), mirrored from the server's
// FIRST_SYNC_WINDOW_* constants (sync.ts) — they can't be imported across the
// server/client bundle boundary, so keep them in sync by hand. The server
// re-validates fail-closed regardless, so this input is UX, not the guard.
const FIRST_SYNC_WINDOW_MIN_MONTHS = 1;
const FIRST_SYNC_WINDOW_MAX_MONTHS = 60;
const FIRST_SYNC_WINDOW_DEFAULT_MONTHS = 6;

// Default for the "Sync older history" input (#229): an ABSOLUTE "months of history
// to keep". Seeded larger than the first-sync default so the control starts at a
// value that actually extends the window (pressing it at 6 would just no-op against
// the common 6-month first sync). Same hard bounds (1..60); the server re-validates.
const SYNC_HISTORY_DEFAULT_MONTHS = 12;

/**
 * Clamp a raw months input to the valid integer window; a blank/non-numeric entry
 * falls back to `fallback` (the relevant default) so the control can never emit an
 * out-of-range value the server would reject. Shared by the first-sync window and
 * the "sync older history" input (#229) — same bounds, different blank-fallback.
 */
function clampWindowMonths(raw: string, fallback: number = FIRST_SYNC_WINDOW_DEFAULT_MONTHS): number {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(FIRST_SYNC_WINDOW_MAX_MONTHS, Math.max(FIRST_SYNC_WINDOW_MIN_MONTHS, parsed));
}

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
    ariaHasPopup,
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    /** Set to 'dialog' on buttons that open a modal (announced to AT). */
    ariaHasPopup?: 'dialog';
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-haspopup={ariaHasPopup}
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
 * The add/edit form, rendered as the shared create/edit dialog (#236/#238).
 * `editing` pre-fills the fields for an existing DB provider (token stays blank →
 * keep the stored secret); `null` is the add form (token required). The caller
 * renders it only while its modal is open and keys it on `editing?.id ?? 'new'`,
 * so switching add ⇄ edit ⇄ another row remounts a clean state.
 *
 * `FormModal` owns Save / Cancel / the write error and the close-guard-while-
 * pending contract — this component supplies only the fields plus the draft
 * "Test connection" affordance, which belongs to the body because it acts on the
 * unsaved draft rather than committing it.
 *
 * `onCreated` (#211) fires with the server's created provider on the CREATE path
 * only — the page uses it to auto-open the new row's repo-scope editor so the
 * admin narrows the scope before the first sync. Edits never fire it.
 */
function ProviderFormModal({
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
    // `isEdit` picks the path, so exactly one of the two mutations is ever in
    // play — select it once rather than testing both at each use.
    const write = isEdit ? update : create;
    const pending = write.isPending;

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
        <FormModal
            title={isEdit ? `Edit ${meta.label} provider` : 'Add git provider'}
            onClose={onDone}
            onSubmit={submit}
            submitLabel={isEdit ? 'Save changes' : 'Add provider'}
            pending={pending}
            submitDisabled={!canSave}
            // The write's error. The draft test's error is NOT surfaced here —
            // it belongs beside the Test button that produced it.
            error={write.isError ? write.error : null}
            testId="git-provider-modal"
        >
            <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-end gap-4">
                    {/* Type and container are IMMUTABLE after creation (#264): together they
                        key every imported row and every sync cursor, so moving a saved
                        provider to a different pair would orphan the old container's data.
                        The server refuses such a PATCH; the fields are locked here so the
                        admin never types a change that cannot be saved. */}
                    <SelectField
                        label="Provider type"
                        value={type}
                        onChange={changeType}
                        disabled={isEdit}
                    >
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
                        disabled={isEdit}
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

                {/* The draft test acts on the UNSAVED form, so it lives with the
                    fields — the modal's footer is reserved for the write (Save)
                    and the close affordance (Cancel). */}
                <div className="flex flex-wrap items-center gap-3">
                    <AccentButton
                        onClick={() => testDraft.mutate(buildInput())}
                        disabled={!canTest || testDraft.isPending || pending}
                        title={canTest ? undefined : 'Enter a token to test the connection'}
                    >
                        {testDraft.isPending ? 'Testing…' : 'Test connection'}
                    </AccentButton>
                    {testDraft.data ? <ProbeResultView result={testDraft.data} /> : null}
                    <ErrorText error={testDraft.isError ? testDraft.error : null} />
                </div>

                {isEdit ? (
                    <p className="text-xs text-muted" data-testid="container-immutable-note">
                        The provider type and {meta.containerLabel.toLowerCase()} cannot be changed —
                        this provider’s imported commits, PRs and sync cursors are keyed by them. To
                        point at a different {meta.containerLabel.toLowerCase()}, remove this provider
                        (which also removes its imported data) and add the new one.
                    </p>
                ) : null}
            </div>
        </FormModal>
    );
}

/**
 * Destructive-delete confirmation (#264). A provider delete no longer just forgets a
 * connection — it retracts exactly that container's imported commits, PRs and snapshot
 * contribution and purges its sync cursors. So the dialog states the REAL numbers, fetched
 * from `/delete-impact` while it is open, rather than a generic warning.
 *
 * Reuses `FormModal` (the shared dialog + its close-guard-while-pending contract) instead of
 * hand-rolling a second modal shell; only the body and the button labels differ.
 */
function RemoveProviderModal({
    provider,
    onClose,
    onDeleted,
}: {
    provider: AdminGitProvider;
    onClose: () => void;
    /** Fired with the server's report of what was removed — the page states it back. */
    onDeleted: (result: GitProviderDeleteResult) => void;
}): JSX.Element {
    const remove = useDeleteAdminGitProvider();
    // No `enabled` gate: this component is mounted only while the confirmation is open, so
    // the mount IS the gate — a parameter restating it would have exactly one caller passing
    // a literal `true`.
    const impact = useGitProviderDeleteImpact(provider.id);
    const label = `${PROVIDER_META[provider.type].label} · ${provider.container}`;

    return (
        <FormModal
            title={`Remove ${label}?`}
            onClose={onClose}
            onSubmit={() =>
                remove.mutate(provider.id, {
                    onSuccess: (result) => {
                        onDeleted(result);
                        onClose();
                    },
                })
            }
            submitLabel="Remove provider and its data"
            pendingLabel="Removing…"
            pending={remove.isPending}
            // Gate the destructive action on having actually LOADED the impact: confirming
            // against "Loading…" is confirming against nothing.
            submitDisabled={!impact.data}
            error={remove.isError ? remove.error : null}
            testId="remove-provider-modal"
        >
            <div className="flex flex-col gap-3 text-sm">
                {impact.isPending ? (
                    <p className="text-muted">Checking what this would remove…</p>
                ) : impact.isError ? (
                    // Fail-closed (Save stays disabled) — but with a way out: one transient
                    // 500 must not leave the admin permanently unable to remove the provider.
                    <div className="flex flex-col items-start gap-2">
                        <p className="text-danger">
                            Could not check what this would remove: {impact.error.message}
                        </p>
                        <AccentButton onClick={() => void impact.refetch()} disabled={impact.isFetching}>
                            {impact.isFetching ? 'Retrying…' : 'Retry'}
                        </AccentButton>
                    </div>
                ) : impact.data.cascade_skipped ? (
                    <p className="text-foreground" data-testid="remove-impact">
                        A config-file provider still covers <strong>{label}</strong>, so it keeps
                        owning this data. Removing this connection deletes only the saved
                        connection — no imported activity and no sync state are removed.
                    </p>
                ) : (
                    <div data-testid="remove-impact" className="flex flex-col gap-2">
                        <p className="text-foreground">
                            This permanently removes everything imported from{' '}
                            <strong>{label}</strong>:
                        </p>
                        <ul className="list-disc pl-5 text-muted">
                            <li>
                                <strong>{impact.data.days}</strong> day
                                {impact.data.days === 1 ? '' : 's'} of history
                                {impact.data.earliest_date && impact.data.latest_date
                                    ? ` (${impact.data.earliest_date} → ${impact.data.latest_date})`
                                    : ''}{' '}
                                — {impact.data.commits} commit
                                {impact.data.commits === 1 ? '' : 's'} from {impact.data.authors}{' '}
                                git author{impact.data.authors === 1 ? '' : 's'}
                            </li>
                            <li>
                                <strong>{impact.data.pr_records}</strong> pull-request record
                                {impact.data.pr_records === 1 ? '' : 's'}
                            </li>
                            <li>
                                <strong>{impact.data.developers_affected}</strong> developer
                                {impact.data.developers_affected === 1 ? '' : 's'} will lose this
                                provider’s activity from their totals
                            </li>
                        </ul>
                        <p className="text-muted">
                            Developers, their identity mappings and team membership are{' '}
                            <strong>not</strong> removed, and no other provider’s data is touched.
                            Re-adding {provider.container} later starts a clean import from the
                            history window you choose.
                        </p>
                    </div>
                )}
            </div>
        </FormModal>
    );
}

/**
 * What a completed delete removed, as the sentences the page banner shows.
 *
 * Returned as a list rather than one long string so the banner can render the caveats
 * (`snapshot_cells_legacy_skipped`, a failed aggregate recompute) as their own lines: both
 * describe a retraction that is INCOMPLETE, and folding them into a run-on success sentence is
 * how an incomplete outcome comes to read as a clean one.
 */
export function removedSummary(result: GitProviderDeleteResult): string[] {
    const {removed, aggregates} = result;
    if (removed.cascade_skipped) {
        return [
            `Removed the saved connection for ${removed.provider} · ${removed.container}. A config-file provider still owns its data, so nothing was retracted.`,
        ];
    }
    const lines = [
        `Removed ${removed.provider} · ${removed.container}: ` +
            `${removed.raw_author_rows} author-day row(s) and ${removed.pr_records} PR record(s) retracted ` +
            `across ${removed.days} day(s); ${removed.snapshot_cells_retracted} snapshot cell(s) removed and ` +
            `${removed.snapshot_cells_rewritten} recomputed from the remaining providers; ` +
            `${removed.cursor_keys_purged} sync cursor(s) cleared. ` +
            `${removed.developers_affected} developer(s) affected — none were deleted.`,
    ];
    // A refused (legacy) cell means this provider's contribution to that day is STILL counted.
    // Reporting the totals without it would make a partial retraction look complete.
    if (removed.snapshot_cells_legacy_skipped > 0) {
        lines.push(
            `${removed.snapshot_cells_legacy_skipped} snapshot cell(s) could NOT be retracted: they hold ` +
                'pre-upgrade totals the projection cannot reconstruct, so those days still include this ' +
                'provider’s activity.',
        );
    }
    if (aggregates.error !== null) {
        lines.push(
            `Trend aggregates were NOT recomputed (${aggregates.error}), so weekly/monthly charts still ` +
                `include the removed activity. Run \`toprope aggregate backfill --from ${aggregates.from ?? ''}\` to fix them.`,
        );
    } else if (aggregates.periods > 0) {
        lines.push(
            `${aggregates.periods} trend aggregate period(s) and ${aggregates.prMetricPeriods} PR-metric ` +
                `period(s) recomputed for ${aggregates.from} → ${aggregates.to}.`,
        );
    }
    return lines;
}

/** Default client-side page size for the repo table (#213); adjustable via the
 *  footer selector (#227), persisted per-surface under this key. */
const REPO_PAGE_SIZE_DEFAULT = 10;
const REPO_PAGE_SIZE_STORAGE_KEY = 'toprope.rowsPerPage.repoScope';

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
    // Rows-per-page (#227). This modal owns its own page/size state (rather than
    // usePagination) because the sort reads the LIVE selection — a checkbox tick
    // must regroup rows WITHOUT snapping to page 1, which the hook's identity
    // reset would do. Seed from storage, fail-closed to the default.
    const [pageSize, setPageSizeState] = useState<PageSizeOption>(() =>
        loadPageSize(REPO_PAGE_SIZE_STORAGE_KEY, DEFAULT_PAGE_SIZE_OPTIONS, REPO_PAGE_SIZE_DEFAULT),
    );
    // Default ordering is selection-first (#215): reopening a narrowed scope
    // shows the stored selection on page 1, immediately amendable. On a fresh
    // monitor-all provider the seed selects everything, so this degrades to a
    // plain name ordering.
    const [sort, setSort] = useState<SortState>({key: 'selected', direction: 'asc'});
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

    // Case-insensitive substring filter over slug OR display name, then SORT,
    // then pagination — sorting must order the whole filtered list, never a
    // single page. The page index is clamped (not reset via an effect) so
    // shrinking the result set can never leave an out-of-range page.
    const query = filter.trim().toLowerCase();
    const filtered = query
        ? repoList.filter(
              (r) => r.slug.toLowerCase().includes(query) || r.name.toLowerCase().includes(query),
          )
        : repoList;

    // One slug collation everywhere: numeric-aware for humane ordering, with a
    // plain comparison appended so numerically equal but textually distinct
    // slugs ("repo-1" vs "repo-01") still have an explicit total order rather
    // than leaning on engine sort stability.
    const bySlug = (a: GitProviderRepo, b: GitProviderRepo): number =>
        a.slug.localeCompare(b.slug, undefined, {numeric: true}) || a.slug.localeCompare(b.slug);
    // Name is the universal secondary ordering (numeric-aware), slug the final
    // total-order tiebreak, so every sort is stable and deterministic.
    const byName = (a: GitProviderRepo, b: GitProviderRepo): number =>
        a.name.localeCompare(b.name, undefined, {numeric: true}) || bySlug(a, b);
    // Selection-status sort groups selected repos first (asc) or last (desc),
    // name-ordered WITHIN each group in both directions (#215). It reads the
    // LIVE selection, so ticking a row while sorted by status regroups it
    // immediately — the sort is an honest view, not a snapshot (a deliberate,
    // reviewed trade-off: a row ticked on a later page relocates to the
    // selected group at the front).
    const sortedFiltered = [...filtered].sort((a, b) => {
        if (sort.key === 'selected') {
            const rankDiff =
                (selected.has(a.slug) ? 0 : 1) - (selected.has(b.slug) ? 0 : 1);
            if (rankDiff !== 0) return sort.direction === 'asc' ? rankDiff : -rankDiff;
            return byName(a, b);
        }
        const cmp = sort.key === 'slug' ? bySlug(a, b) : byName(a, b);
        return sort.direction === 'asc' ? cmp : -cmp;
    });

    // 'All' collapses the whole (filtered) list onto a single page.
    const effectivePageSize =
        pageSize === 'all' ? Math.max(1, sortedFiltered.length) : pageSize;
    const pageCount = Math.max(1, Math.ceil(sortedFiltered.length / effectivePageSize));
    const safePage = Math.min(page, pageCount - 1);
    const visibleRows = sortedFiltered.slice(
        safePage * effectivePageSize,
        (safePage + 1) * effectivePageSize,
    );

    // A size change reshuffles every page boundary, so restart from page 1 (the
    // same restart a filter/sort applies here), and persist the choice.
    function changePageSize(next: PageSizeOption): void {
        setPageSizeState(next);
        setPage(0);
        savePageSize(REPO_PAGE_SIZE_STORAGE_KEY, next);
    }

    function toggleRepo(slug: string, checked: boolean): void {
        const next = new Set(selected);
        if (checked) next.add(slug);
        else next.delete(slug);
        setEdited(next);
    }

    // Table columns: checkbox / Slug / Name (+ archived badge). All three sort
    // (#215) through DataTable's CONTROLLED mode — the comparator above owns
    // the ordering so it composes with filtering and pagination; the render-only
    // Selected and Name columns force-enable their headers with sortable: true.
    // The checkbox is labelled by the SLUG (the identifier the save writes).
    const columns: Column<GitProviderRepo>[] = [
        {
            key: 'selected',
            header: 'Selected',
            sortable: true,
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
        {key: 'slug', header: 'Slug', accessor: (r) => r.slug},
        {
            key: 'name',
            header: 'Name',
            sortable: true,
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
    // The count line separates LISTED selections from stored slugs the listing
    // no longer returns (extras) — blending them could read "4 of 3 selected".
    const listedSelectedCount = repoList.filter((r) => selected.has(r.slug)).length;
    const unlistedSelectedCount = selected.size - listedSelectedCount;
    // Validation only — `FormModal` folds the in-flight state into Save's
    // disabled state and into the close guard, so `update.isPending` must NOT
    // be mixed in here.
    const canSave = mode === 'all' || (selectSourceReady && !emptySelection);

    function save(): void {
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
        <FormModal
            title={`Repository scope — ${provider.container}`}
            onClose={onClose}
            onSubmit={save}
            submitLabel="Save scope"
            pending={update.isPending}
            submitDisabled={!canSave}
            error={update.isError ? update.error : null}
            // Provider-scoped so stacked modals (#211 prompt + another row's)
            // never render duplicate test ids.
            testId={`repo-scope-modal-${provider.id}`}
        >
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
                                    {listedSelectedCount} of {repoList.length} selected
                                    {unlistedSelectedCount > 0
                                        ? ` (+${unlistedSelectedCount} not listed)`
                                        : ''}
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
                                    sort={sort}
                                    onSortChange={(next) => {
                                        setSort(next);
                                        // Match the filter's behavior: a
                                        // re-ordered list restarts from page 1.
                                        setPage(0);
                                    }}
                                />
                            </div>
                            {isPaginationVisible(
                                sortedFiltered.length,
                                pageCount,
                                true,
                                DEFAULT_PAGE_SIZE_OPTIONS,
                            ) ? (
                                <div className="mt-2" data-testid="repo-pagination">
                                    {/* Shared pager (#222) + rows-per-page selector
                                        (#227). Page state stays 0-based here (the
                                        slice math predates the component), so bridge
                                        to the 1-based control. The modal keeps
                                        ownership of `page`/`pageSize` rather than
                                        folding into DataTable's `pageSize` because
                                        the sort reads the LIVE selection — a checkbox
                                        tick must regroup rows WITHOUT snapping back
                                        to page 1, which an identity-reset would do. */}
                                    <Pagination
                                        page={safePage + 1}
                                        pageCount={pageCount}
                                        onPageChange={(p) => setPage(p - 1)}
                                        pageSize={pageSize}
                                        pageSizeOptions={DEFAULT_PAGE_SIZE_OPTIONS}
                                        onPageSizeChange={changePageSize}
                                        totalItems={sortedFiltered.length}
                                        ariaLabel="Repository pages"
                                    />
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
        </FormModal>
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
    onDeleted,
}: {
    provider: AdminGitProvider;
    onEdit: (p: AdminGitProvider) => void;
    promptScope: boolean;
    onScopeClose: () => void;
    /** Bubbled to the page: the row unmounts on delete, so the report can't live here. */
    onDeleted: (result: GitProviderDeleteResult) => void;
}): JSX.Element {
    const update = useUpdateAdminGitProvider();
    const [removeOpen, setRemoveOpen] = useState(false);
    const sync = useSyncAdminGitProvider();
    const syncOlder = useSyncOlderHistoryGitProvider();
    const test = useTestAdminGitProvider();
    const [scopeOpen, setScopeOpen] = useState(false);
    // First-sync history window (months). Only meaningful — and only surfaced —
    // before this provider has ever synced: once a cursor exists the server ignores
    // it (re-widening would double-count), so the input disappears and "Sync now"
    // sends no window. Gate on the server's cursor-derived `first_sync_pending`, NOT
    // `last_sync_at`: the latter only tracks sync-now runs, so it would keep showing
    // the (server-ignored) input after a scheduled/CLI first sync.
    const [windowMonths, setWindowMonths] = useState(FIRST_SYNC_WINDOW_DEFAULT_MONTHS);
    // "Sync older history" window (#229), in ABSOLUTE months to keep. Only surfaced
    // AFTER the first sync (there is no history to extend before it) — a first-sync
    // provider uses the window input above instead.
    const [olderHistoryMonths, setOlderHistoryMonths] = useState(SYNC_HISTORY_DEFAULT_MONTHS);
    const isFirstSync = provider.first_sync_pending;
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
    // A run is in flight server-side (from the polled list) OR either trigger POST
    // (sync-now / sync-older-history) is still pending — either way the sync
    // controls stay down and show progress. Both triggers share the server's
    // in-flight registry, so only one can actually be running at a time.
    const syncRunning =
        provider.active_sync !== null || sync.isPending || syncOlder.isPending;

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
                                {isFirstSync ? (
                                    <label className="flex items-center gap-1 text-xs text-muted">
                                        <span>Last</span>
                                        <input
                                            type="number"
                                            min={FIRST_SYNC_WINDOW_MIN_MONTHS}
                                            max={FIRST_SYNC_WINDOW_MAX_MONTHS}
                                            step={1}
                                            value={windowMonths}
                                            onChange={(e) => setWindowMonths(clampWindowMonths(e.target.value))}
                                            disabled={syncRunning || !provider.enabled}
                                            aria-label="First-sync history window in months"
                                            title="First sync only: how many months of history to import"
                                            className="w-14 rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-foreground disabled:opacity-50"
                                        />
                                        <span>months</span>
                                    </label>
                                ) : null}
                                <AccentButton
                                    onClick={() =>
                                        sync.mutate({
                                            id: provider.id,
                                            months: isFirstSync ? windowMonths : undefined,
                                        })
                                    }
                                    disabled={syncRunning || !provider.enabled}
                                    title={provider.enabled ? undefined : 'Enable the provider to sync'}
                                >
                                    {syncRunning ? 'Syncing…' : 'Sync now'}
                                </AccentButton>
                                {/* "Sync older history" (#229): extend the synced
                                    window BACKWARD by an absolute months value. Only
                                    meaningful after the first sync — before it, the
                                    first-sync window input above already controls how
                                    far back run #1 reaches. */}
                                {!isFirstSync ? (
                                    <>
                                        <label className="flex items-center gap-1 text-xs text-muted">
                                            <span>Keep</span>
                                            <input
                                                type="number"
                                                min={FIRST_SYNC_WINDOW_MIN_MONTHS}
                                                max={FIRST_SYNC_WINDOW_MAX_MONTHS}
                                                step={1}
                                                value={olderHistoryMonths}
                                                onChange={(e) =>
                                                    setOlderHistoryMonths(
                                                        clampWindowMonths(
                                                            e.target.value,
                                                            SYNC_HISTORY_DEFAULT_MONTHS,
                                                        ),
                                                    )
                                                }
                                                disabled={syncRunning || !provider.enabled}
                                                aria-label="Older-history window in months"
                                                title="How many months of history to keep, total — extends the synced window further back"
                                                className="w-14 rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-foreground disabled:opacity-50"
                                            />
                                            <span>months</span>
                                        </label>
                                        <AccentButton
                                            onClick={() =>
                                                syncOlder.mutate({
                                                    id: provider.id,
                                                    months: olderHistoryMonths,
                                                })
                                            }
                                            disabled={syncRunning || !provider.enabled}
                                            title={
                                                provider.enabled
                                                    ? 'Fetch never-synced older history for this provider'
                                                    : 'Enable the provider to sync'
                                            }
                                        >
                                            Sync older history
                                        </AccentButton>
                                    </>
                                ) : null}
                                <AccentButton
                                    onClick={() => setScopeOpen(true)}
                                    title="Choose which repositories to analyze"
                                    ariaHasPopup="dialog"
                                >
                                    Repos
                                </AccentButton>
                                <button
                                    type="button"
                                    onClick={() => onEdit(provider)}
                                    aria-haspopup="dialog"
                                    className="text-sm font-medium text-accent hover:underline"
                                >
                                    Edit
                                </button>
                                {/* Destructive since #264 — it retracts this container's
                                    imported data too, so it goes through a confirmation
                                    that states what will be removed. */}
                                <button
                                    type="button"
                                    onClick={() => setRemoveOpen(true)}
                                    aria-haspopup="dialog"
                                    className="text-sm font-medium text-danger hover:underline"
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
            {syncOlder.isError ? (
                <tr>
                    <td colSpan={7} className="px-3 pb-3">
                        <ErrorText error={syncOlder.error} />
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
            {removeOpen && !isConfig ? (
                <RemoveProviderModal
                    provider={provider}
                    onClose={() => setRemoveOpen(false)}
                    onDeleted={onDeleted}
                />
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
 * empty-dropdown confusion (finding #3) by pointing the admin at the add
 * affordance — the header's "＋ Add git provider" button since #238 — and flagging
 * the identity-mapping caveat up front.
 */
function GitEmptyState(): JSX.Element {
    return (
        <StatePanel
            tone="accent"
            testId="git-empty-state"
            icon={<span aria-hidden>🔌</span>}
            title="Connect your first git provider"
            description="No git providers are connected and no activity has been collected yet. Use “＋ Add git provider” above to start analyzing commits, PRs, and churn."
        >
            <p className="text-sm text-muted">
                After connecting, only developers whose git identities are mapped will appear in the
                data. <IdentityMappingLink />.
            </p>
        </StatePanel>
    );
}

/**
 * Admin → Connectors → Git. Connected-provider list (the page's primary content)
 * + the provider-driven add/edit form in a modal opened from the header's
 * "＋ Add git provider" button or a row's "Edit" (#236/#238) + per-provider
 * repo-scope editor + cold-start onboarding. Reached only by admins (route + API
 * both gate it).
 */
export function AdminGitProviders(): JSX.Element {
    const providers = useAdminGitProviders();
    const dataSources = useAdminDataSources();
    const formModal = useModalState<AdminGitProvider>();
    // The provider the admin JUST connected (#211): its row mounts with the
    // repo-scope editor open, prompting a selection before the first sync.
    // Cleared when that editor closes (save or cancel) so it never re-prompts.
    const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
    // What the last delete actually removed (#264). Held at page level because the row that
    // triggered it has unmounted by the time the report arrives.
    const [lastRemoved, setLastRemoved] = useState<GitProviderDeleteResult | null>(null);

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
                actions={
                    <PrimaryButton onClick={formModal.openCreate} ariaHasPopup="dialog">
                        ＋ Add git provider
                    </PrimaryButton>
                }
            />
            {showEmptyState ? <GitEmptyState /> : null}
            {/* The delete is destructive, so its OUTCOME is reported rather than left silent
                (#264): the admin sees exactly how much history was retracted, and that no
                developer was deleted. */}
            {lastRemoved ? (
                <AdminBanner
                    tone="warning"
                    testId="provider-removed-banner"
                    onDismiss={() => setLastRemoved(null)}
                >
                    {removedSummary(lastRemoved).map((line, i) => (
                        <p key={line} className={i === 0 ? undefined : 'mt-1'}>
                            {line}
                        </p>
                    ))}
                </AdminBanner>
            ) : null}
            {/* No form renders until the admin asks for one. Keyed so add ⇄ edit
                ⇄ another row always remounts clean fields (#236 criterion 3). */}
            {formModal.mode !== 'closed' ? (
                <ProviderFormModal
                    key={formModal.editing?.id ?? 'new'}
                    editing={formModal.editing}
                    onDone={formModal.close}
                    // Creating a second provider deliberately moves the one-shot
                    // prompt to it — the previous provider's prompt is dismissed.
                    onCreated={(created) => setJustCreatedId(created.id)}
                />
            ) : null}
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
                        No providers connected yet. Use “＋ Add git provider” above to start
                        analyzing git activity.
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
                                onEdit={formModal.openEdit}
                                promptScope={p.id === justCreatedId}
                                onScopeClose={() => setJustCreatedId(null)}
                                onDeleted={setLastRemoved}
                            />
                        ))}
                    </Table>
                )}
            </Card>
        </div>
    );
}
