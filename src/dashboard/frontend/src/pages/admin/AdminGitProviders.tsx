import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
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
    GitSyncProgress,
    GitSyncRepoStep,
    GitSyncStage,
} from '../../api/types';
import {
    AdminBanner,
    adminBannerFrame,
    ErrorText,
    PageHeader,
    PrimaryButton,
    SelectField,
    Table,
    Td,
    TextField,
    Th,
} from './adminUi';
// The SERVER's container normalization, imported rather than re-implemented (#266 AC9).
// `providers/container.ts` is deliberately dependency-free so both bundles can use it: two
// copies of the trim/casefold rule is exactly how a client starts accepting what the server
// rejects (or blocking what it would allow).
import {
    isBlankContainer,
    normalizeContainer,
    sameContainer,
} from '../../../../../connectors/git/providers/container';

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
 * The noun each within-repo step counts (#270). A `Record` over the union, matching
 * `PROVIDER_META` above: adding a `GitSyncRepoStep` member without a noun is a BUILD
 * error, and an unrecognized wire value from a newer backend reads `undefined` at
 * runtime — both properties, without a switch.
 */
const REPO_STEP_NOUN: Record<GitSyncRepoStep, string> = {
    commits: 'commit',
    diffs: 'diff',
    prs: 'PR',
};

/**
 * The counters shown after the repo position on the `fetching` line (#270): the
 * within-repo counter, then the run-level totals it supplements.
 *
 * The within-repo counter is PREPENDED, not substituted — `commits_fetched`/
 * `prs_fetched` only move when a whole repo finishes, so substituting would have
 * hidden how much data the run has actually pulled for essentially the whole stage.
 * The two are at different scopes and use the same nouns, so the run-level pair is
 * labelled to keep `commit 1240/5000 · run total 34 commits` from reading as one
 * broken number (the within-repo count is routinely the larger of the two).
 */
function repoStepDetail(p: GitSyncProgress): string {
    const commits = `${p.commits_fetched} commit${p.commits_fetched === 1 ? '' : 's'}`;
    const prs = `${p.prs_fetched} PR${p.prs_fetched === 1 ? '' : 's'}`;
    const runTotal = `run total ${commits} · ${prs}`;
    const step = repoStepCount(p);
    return step === null ? runTotal : `${step} · ${runTotal}`;
}

/**
 * `commit 12/40` once the set size is known, `12 commits found` while it isn't
 * (with `(3400 scanned)` appended where the two differ — see below), or null when there
 * is nothing honest to show: no step in flight, a step that ran over an empty set (a
 * total of 0 would render as the meaningless "commit 0/0"), or a step name a newer
 * backend emits that this bundle cannot name. This is the single place those decisions
 * are made — providers deliberately do not pre-suppress the cases this hides. (That is
 * about REPORTS, not rows: Bitbucket does filter rows in memory, which is why the scanned
 * count below exists.)
 */
function repoStepCount(p: GitSyncProgress): string | null {
    // `Object.hasOwn`, not a bare lookup: `repo_step` is wire data, and a plain object
    // literal would resolve an inherited key ("toString", "constructor") to a function
    // that passes an `undefined` check and renders as source text.
    const noun: string | undefined =
        p.repo_step !== null && Object.hasOwn(REPO_STEP_NOUN, p.repo_step)
            ? REPO_STEP_NOUN[p.repo_step]
            : undefined;
    if (noun === undefined || p.repo_step_total === 0) return null;
    if (p.repo_step_total === null) {
        return `${p.repo_step_done} ${noun}${p.repo_step_done === 1 ? '' : 's'} found${scannedSuffix(p)}`;
    }
    return `${noun} ${p.repo_step_done}/${p.repo_step_total}`;
}

/**
 * ` (3400 scanned)` when the listing step has been handed more rows than it kept, else
 * empty (#276).
 *
 * A Bitbucket backfill walks from HEAD and discards everything newer than the window, so
 * "found" cannot move for hundreds of pages while this can — without it the line is the
 * frozen `0 commits found` that #270 was supposed to eliminate. It is APPENDED rather
 * than substituted, and says "scanned" rather than reusing "found", because the two count
 * different things and a scanned count presented as commits found would be a fresh lie in
 * the other direction.
 *
 * Rendered only when strictly greater, so a provider that reports the field on a forward
 * run (where it equals `repo_step_done` and adds nothing) shows the plain count. `>` is
 * also what keeps a nonsense wire value — a `scanned` below `done`, which no producer can
 * emit — from rendering as a shrinking parenthetical.
 *
 * `typeof === 'number'`, not `!== null`, for the same reason `repoStepCount` above uses
 * `Object.hasOwn`: this is wire data. A cached bundle polling a rolled-back server gets
 * the key absent, and `undefined !== null` is true — the plain count then survives only
 * on the accident that `undefined > n` is false. A non-number would be worse (`'3400' > 0`
 * is true, and the suffix would render remote text verbatim).
 */
function scannedSuffix(p: GitSyncProgress): string {
    const scanned = p.repo_step_scanned;
    return typeof scanned === 'number' && scanned > p.repo_step_done ? ` (${scanned} scanned)` : '';
}

/**
 * The COARSE, counter-free name of each pipeline stage — the one spelling of these
 * four names. Both readers use it: the visible progress line, which appends that
 * stage's live counters, and the screen-reader announcement (#278), which
 * deliberately appends nothing. Keeping one record rather than a second literal set
 * is what stops the two surfaces from growing separate vocabularies for one stage.
 *
 * A `Record` over the union, like `PROVIDER_META` and `REPO_STEP_NOUN` above: adding
 * a `GitSyncStage` member without a name here is a BUILD error, and an unrecognized
 * wire value from a newer backend reads `undefined` at runtime.
 *
 * Scope of the claim: it covers the four NAMED stages only. The two non-stage fallbacks
 * (no progress emitted yet; a stage this bundle cannot name) are deliberately spelled
 * per surface — the visible line uses the ellipsis idiom ("Starting sync…", "Syncing…"),
 * the spoken one does not ("Sync started", "Sync in progress").
 */
const STAGE_LABEL: Record<GitSyncStage, string> = {
    listing_repos: 'Listing repositories',
    fetching: 'Fetching activity',
    analyzing: 'Matching developers',
    writing: 'Writing snapshots',
};

/**
 * Human-readable line for an in-flight sync's progress snapshot (#209) — stage
 * plus the counters that stage has meaningfully advanced. Exported for tests.
 */
export function syncProgressLabel(active: GitProviderActiveSync): string {
    const p = active.progress;
    if (!p) return 'Starting sync…';
    switch (p.stage) {
        case 'listing_repos':
            return `${STAGE_LABEL.listing_repos}…`;
        case 'fetching': {
            const total = p.repos_total ?? 0;
            // repos_processed counts COMPLETED repos; the one in flight is +1,
            // clamped so the label never overshoots (12/12, not 13/12; 0/0).
            const position = Math.min(p.repos_processed + 1, total);
            const repo = p.current_repo ? ` (${p.current_repo})` : '';
            return `${STAGE_LABEL.fetching} — repo ${position}/${total}${repo} · ${repoStepDetail(p)}`;
        }
        case 'analyzing':
            return `${STAGE_LABEL.analyzing} — ${p.developers_matched} matched`;
        case 'writing':
            return `${STAGE_LABEL.writing} — ${p.developers_matched} developer${p.developers_matched === 1 ? '' : 's'} matched`;
        default: {
            // Exhaustiveness witness: adding a GitSyncStage member without a case here
            // is a BUILD error. (A bare `return` after the switch does NOT give this —
            // the compiler is satisfied by the return and never checks coverage, which
            // is what the comment here used to claim incorrectly.) At runtime `p.stage`
            // is wire data, so a newer backend's stage lands here too and degrades to a
            // generic label rather than a blank line.
            const exhaustive: never = p.stage;
            void exhaustive;
            return 'Syncing…';
        }
    }
}

/**
 * What an IN-FLIGHT run announces to a screen reader (#278): the coarse pipeline
 * stage and nothing else.
 *
 * This is the whole point of the split from {@link syncProgressLabel} — the visible
 * line's counters change on nearly every 1s poll, and a polite live region carrying
 * them would announce a ~70-character string once a second for the length of a
 * multi-hour first sync (#270's finding). The stage changes roughly four times per
 * run, so it is safe to announce and is the part a listener can actually use.
 *
 * Degrades on wire data rather than trusting the union: `progress` is null (or, from a
 * rolled-back server a cached bundle is polling, absent — hence `!p`, the same guard
 * `syncProgressLabel` uses, not `=== null`) until the pipeline's first emission, and
 * `stage` is a string from the server, so a member a newer backend emits lands on the
 * generic line instead of announcing raw source text. `Object.hasOwn`, not a bare
 * lookup, for the reason `repoStepCount` uses it — a plain object literal resolves
 * inherited keys ("toString", "constructor") to functions that pass an `undefined`
 * check.
 */
export function syncStageAnnouncement(active: GitProviderActiveSync): string {
    const p = active.progress;
    if (!p) return 'Sync started';
    return Object.hasOwn(STAGE_LABEL, p.stage) ? STAGE_LABEL[p.stage] : 'Sync in progress';
}

/**
 * What the row says when it cannot tell whether the run it watched produced the outcome
 * the columns now hold — the single fallback {@link syncTerminalAnnouncement} returns for
 * anything that is not one of the two known terminals, including the `null` the freshness
 * gate in `ProviderRow` passes when the recorded outcome predates the run.
 */
const SYNC_OUTCOME_UNKNOWN = 'Sync finished — outcome unknown';

/**
 * Does the row's recorded outcome belong to the run that just disappeared (#278)?
 *
 * This is the guard that keeps the announcement from making a completion claim the row
 * cannot support. `recordSyncOutcome` writes `last_sync_status` and `last_sync_at` in
 * ONE update, and it is the only writer of either column — so an outcome recorded for
 * this run necessarily carries a `last_sync_at` at or after the run's `started_at`.
 *
 * The window this closes is not hypothetical. `activeSyncs` is a process-local `Map`
 * (`api/admin/git-providers.ts`), and the outcome is recorded in the run promise's
 * then/catch while the registry entry is cleared in `finally`. Lose the process between
 * them — a restart or deploy during exactly the multi-hour first sync this feature is
 * for — and the run vanishes with no outcome ever written. The next poll then shows
 * `active_sync: null` beside LAST week's `'ok'`, and announcing "Sync completed" would
 * be a completion signal for a run that imported nothing (#231 discards a failed run's
 * partial window). A sighted admin has a tell: `last_sync_at` renders next to the Badge
 * and reads three weeks old. The announcement carries no timestamp, so without this
 * gate the listener would get a strictly WORSE signal than the visible one.
 *
 * Parsed instants, and an unparseable operand REJECTED explicitly rather than left to
 * `NaN >= NaN` happening to be false — both per the project's timestamp rule. Failing
 * closed here costs only a vaguer announcement.
 */
export function outcomeBelongsToRun(lastSyncAt: string | null, runStartedAt: string): boolean {
    if (lastSyncAt === null) return false;
    const recorded = Date.parse(lastSyncAt);
    const started = Date.parse(runStartedAt);
    if (Number.isNaN(recorded) || Number.isNaN(started)) return false;
    return recorded >= started;
}

/**
 * The later of two ISO instants, or null when neither is usable (#278). Null and
 * unparseable operands are discarded rather than winning or losing a comparison, and
 * the comparison is on parsed instants — an expanded-year spelling
 * (`+010000-01-01T…`) sorts BELOW an ordinary year as a string and would invert it.
 *
 * Used to pick the most recent run a row knows about out of two independent sources
 * (the polled in-flight entry and this row's own trigger handles), which is what makes
 * the "already announced" check monotone.
 */
export function laterInstant(a: string | null, b: string | null): string | null {
    const ta = a === null ? NaN : Date.parse(a);
    const tb = b === null ? NaN : Date.parse(b);
    if (Number.isNaN(ta)) return Number.isNaN(tb) ? null : b;
    if (Number.isNaN(tb)) return a;
    return tb > ta ? b : a;
}

/**
 * What a SETTLED run announces (#278), read from the same `last_sync_status` column the
 * status Badge renders. Callers must have already established that the outcome belongs
 * to the run being announced — see {@link outcomeBelongsToRun}.
 *
 * The third branch is not defensive padding. `status` here is UNVALIDATED WIRE DATA: the
 * frontend does no runtime validation of the response, and the column is CHECK-constrained
 * to `ok | error | never` — a wider set than the two values `recordSyncOutcome` can write
 * (`SyncOutcomeStatus` is `'ok' | 'error'`; `'never'` is the Badge's display default for a
 * NULL column, not a stored outcome). Naming an outcome the row does not have would be
 * exactly the completion claim this feature must not make, so anything but the two known
 * terminals falls through to {@link SYNC_OUTCOME_UNKNOWN}.
 */
export function syncTerminalAnnouncement(status: string | null): string {
    if (status === 'ok') return 'Sync completed';
    if (status === 'error') return 'Sync failed';
    return SYNC_OUTCOME_UNKNOWN;
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
 * The heading over a row's advisory note (#289).
 *
 * Two claims it must not overstate, both of which a fixed string got wrong:
 *
 *  - "**Last manual** sync", not "last sync". `last_sync_advisories` — like every
 *    `last_sync_*` column beside it — is written ONLY by the admin per-provider routes. The
 *    scheduler never touches them, so on a deployment with a nightly sync the run this
 *    describes is usually not the most recent one, and an absent note is emphatically not
 *    evidence that nothing was lost.
 *  - The parenthetical is conditional on the outcome. Advisories are recorded on BOTH
 *    statuses on purpose (a run that fails can still have reported an irreversible loss
 *    before it did), so on a red row a fixed "the sync itself did not fail" contradicts the
 *    `error` badge two lines above it.
 *
 * `line(s)` rather than a plurality branch: the count includes the store's truncation line
 * when the cap trips, so "advisories" would be off by one exactly when the operator most
 * needs to trust the number — and it matches the `(s)` convention the advisory lines
 * themselves use.
 */
export function syncAdvisoryHeading(count: number, status: string | null): string {
    const qualifier =
        status === 'error'
            ? 'reported separately from the failure above'
            : 'the sync itself did not fail';
    return `Last manual sync reported ${count} advisory line(s) — ${qualifier}`;
}

/**
 * A row's advisory note: what the last manual sync REPORTED but did not fail on (#289).
 *
 * Rendered whenever the column is non-empty, including while a new run is in flight — it
 * describes the last SETTLED manual run, exactly like the status Badge and timestamp above
 * it, and the point of the drop advisory is that it stays visible until a later run reports
 * clean.
 *
 * `warning`, never `danger`: an advisory that turned the row red would re-introduce in the UI
 * the misclassification the server's `isAdvisoryError` split exists to prevent. The frame
 * comes from {@link adminBannerFrame} so the amber treatment has one definition — this is
 * deliberately not an `AdminBanner`, which hardcodes `role="status"` and a mandatory Dismiss
 * button. Neither fits: the row's sr-only status element (#278) already owns the announced
 * sync lifecycle and an advisory list appearing mid-poll is not a lifecycle event, and there
 * is nothing to dismiss polled server state to.
 */
function SyncAdvisories({lines, status}: {lines: string[]; status: string | null}): JSX.Element {
    return (
        <div
            data-testid="sync-advisories"
            className={`rounded border px-3 py-2 text-sm text-foreground ${adminBannerFrame('warning')}`}
        >
            <div className="font-medium text-warning">{syncAdvisoryHeading(lines.length, status)}</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
                {lines.map((line, i) => (
                    // Index key: these are report LINES, not entities — they have no id, can
                    // legitimately repeat (one per repo), and the whole list is replaced
                    // wholesale by the next run.
                    <li key={i} className="break-words">
                        {line}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/**
 * The already-listed provider that would collide with `(type, container)`, or null when the
 * pair is free (#266).
 *
 * Comparison goes through the SERVER's {@link sameContainer}, so `Wireless_Media`,
 * `wireless_media` and `Wireless_Media ` all collide with each other exactly as the server's
 * `duplicate_container` guard says they do. Both sources are checked because both occupy a
 * `(type, container)` and both appear in this list: a connected DB provider and a read-only
 * config-file one.
 *
 * A blank container is not a collision, just an unfinished field; the empty-field state has
 * its own Save gate.
 *
 * There is deliberately no "exclude the row being edited" parameter: the only caller is the ADD
 * path (on edit the type and container fields are immutable and disabled since #264, so the pair
 * cannot change from inside the dialog), and a predicate whose only exerciser would be its own
 * unit test is scope without a caller. AC8 — "editing does not flag itself" — holds structurally
 * because the check does not run on the edit path at all, and is proven server-side by the PATCH
 * that only re-cases its own container.
 *
 * THIS IS AN AFFORDANCE, NOT THE ENFORCEMENT (the graduated #228 rule). The list it reads can
 * be stale and another admin can connect a provider between load and submit, so the server's
 * 409 stays authoritative and keeps rendering inline in the dialog.
 */
export function findContainerConflict(
    providers: AdminGitProvider[],
    type: GitProviderType,
    container: string,
): AdminGitProvider | null {
    if (isBlankContainer(container)) return null;
    return providers.find((p) => p.type === type && sameContainer(p.container, container)) ?? null;
}

/**
 * The inline field-level message for a container collision — it NAMES the owner as the table
 * spells it, so the admin can go find it, and states the remediation, which differs for a
 * config-file owner (it cannot be edited from the UI at all).
 *
 * Deliberately SHORT. The server's 409 carries the full explanation ("one container is one
 * independent data set: its imported commits, PRs and sync cursors all belong to that provider…"),
 * and `FormModal` already renders that inline on a stale list (AC10). Restating it here would be a
 * second copy of the same prose on the other side of the wire — which is how the two drift, and
 * #266's whole thesis is that a client and server must not hold two copies of one rule. The
 * PREDICATE is shared via `container.ts`; the explanation stays server-side.
 */
function containerConflictMessage(
    conflict: AdminGitProvider,
    containerLabel: string,
): string {
    const label = `${PROVIDER_META[conflict.type].label} · ${conflict.container}`;
    return conflict.source === 'config'
        ? `${label} already covers this ${containerLabel.toLowerCase()} — it is defined in the config file, so change it there.`
        : `${label} is already connected — edit or remove it instead of adding a second one.`;
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
 *
 * `providers` is the page's loaded list, used ONLY for the client-side
 * duplicate-container affordance (#266): a collision shows inline beside the container
 * input while typing and blocks Save, instead of costing a round-trip to learn it. The
 * server's 409 remains the guard.
 */
function ProviderFormModal({
    editing,
    providers,
    onDone,
    onCreated,
}: {
    editing: AdminGitProvider | null;
    providers: AdminGitProvider[];
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
            // Through the SHARED normalizer, not a local `.trim()` (#266 AC9): the value sent must
            // be the value the inline conflict check compared, or the client is validating one
            // string and transmitting another — the check/store asymmetry this whole change exists
            // to remove. The server re-normalizes regardless; this keeps the client honest.
            container: normalizeContainer(container),
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
    // re-entered token, the admin uses the row's "Test" button instead. Blankness goes through
    // the SHARED predicate, so this component has no second opinion about what "empty" means.
    const hasContainer = !isBlankContainer(container);
    const canTest = token.trim() !== '' && hasContainer && hasUsername;
    // The client-side duplicate-container check (#266). Recomputed on every keystroke from
    // the loaded list, so the collision surfaces while typing rather than on Save.
    //
    // ADD PATH ONLY. On edit the container is immutable (#264) and the field is disabled, so a
    // collision here could never be cleared from inside the dialog — and a collision with
    // ANOTHER row is reachable: if a config-file provider is later added for the same
    // container, this check would permanently disable Save on the connected provider, blocking
    // token rotation and enable/disable, neither of which touches the container. The server's
    // `duplicate_container`/`container_immutable` 409s remain the guard on that path.
    const containerConflict = isEdit ? null : findContainerConflict(providers, type, container);
    const containerError = containerConflict
        ? containerConflictMessage(containerConflict, meta.containerLabel)
        : null;
    const canSave =
        hasContainer && hasUsername && (isEdit || token.trim() !== '') && containerConflict === null;
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
                {/* Stays on the house `items-end`. The container field can grow a validation message
                    below its input (#266), which under `items-end` would lift the input out of line
                    — but that is handled inside `TextField` itself (`self-start` on its wrapper), so
                    it holds for every caller rather than only the one row that remembered. */}
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
                        // Inline, field-level, and case/whitespace-insensitive (#266).
                        error={containerError}
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
                        <p className="text-foreground">Could not check what this would remove.</p>
                        {/* The admin-standard inline error treatment, and the app-wide retry
                            wording ("Try again", as ErrorState uses) — not a second spelling. */}
                        <ErrorText error={impact.error} />
                        <AccentButton onClick={() => void impact.refetch()} disabled={impact.isFetching}>
                            {impact.isFetching ? 'Trying…' : 'Try again'}
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
        // Report what DID land: the recompute commits one period at a time, so claiming nothing
        // happened would send the operator hunting for a problem that may be half-fixed.
        lines.push(
            `The derived rollups were only partly recomputed (${aggregates.error}). ` +
                `${aggregates.periods} trend period(s) and ${aggregates.coachingPeriods} coaching ` +
                'period(s) did land; the rest still include the removed activity. ' +
                `Run \`toprope aggregate backfill --from ${aggregates.from ?? ''} --to ${aggregates.to ?? ''}\` ` +
                'to rebuild the trend rollups — note that command does not cover PR-review or ' +
                'coaching metrics, which the next scheduled weekly/monthly job refreshes only for ' +
                'its recent trailing window.',
        );
    } else if (aggregates.periods > 0) {
        lines.push(
            `${aggregates.periods} trend aggregate period(s) and ${aggregates.coachingPeriods} ` +
                `coaching period(s) recomputed for ${aggregates.from} → ${aggregates.to}.`,
        );
    }
    if (aggregates.truncated) {
        // The remedy belongs here as much as on the error branch: a capped range is the one case
        // where the delete succeeded completely and the rollups are still knowingly stale.
        lines.push(
            `The recomputed range was capped at ${aggregates.from} → ${aggregates.to}; periods outside ` +
                'it were not rebuilt and still include the removed activity. Run ' +
                `\`toprope aggregate backfill --from <the oldest affected day> --to ${aggregates.from ?? ''}\` ` +
                'to rebuild them.',
        );
    }
    if (aggregates.anomaliesNotRescanned) {
        lines.push(
            'Anomaly alerts for this range were deliberately not re-scanned — re-scanning would raise ' +
                'new “activity dropped” alerts for the removal itself. Existing alerts may still refer ' +
                'to the removed activity.',
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

    // --- Screen-reader announcement of the sync lifecycle (#278) ---
    //
    // Everything this row shows about a sync is silent to assistive tech once the run
    // is under way: the disabled "Syncing…" button conveys in-flight state, but the
    // terminal ok/error flip only changes the status cell's `<Badge>`, which is a plain
    // `<span>` with no role (components/Badge.tsx). So a blind admin triggers a sync and
    // has no way to learn it finished short of re-navigating to this row, hours later.
    //
    // Why a dedicated element rather than a role on something that already exists:
    //  - `Badge` is shared by ~10 screens. A role there would make every tag, tier and
    //    count pill in the app a live region — announcements for state nobody changed.
    //  - The progress line is deliberately NOT a live region (#270): its within-repo
    //    counter moves on nearly every 1s poll, so `role="status"` there announces a
    //    ~70-character string once a second for a multi-hour first sync.
    // So: a low-churn element carrying only the coarse stage and the terminal outcome.
    const activeSync = provider.active_sync;
    const stageAnnouncement = activeSync ? syncStageAnnouncement(activeSync) : null;
    // A live region speaks when its DOM CHANGES — not when a RUN changes. The latch below
    // reasons in run identities, but the announcement is a string, and two runs that settle
    // the same way produce a byte-identical one ("…: Sync failed" on a retry against the
    // same bad token). React bails out of a `setState` to an `Object.is`-equal value, so a
    // plain `setAnnouncement(text)` would leave the text node untouched and the second
    // outcome would be announced to nobody — silently, on exactly the retry loop this
    // feature exists for, and on the fast-settle path (never observed in flight) where no
    // stage text intervenes to break the tie.
    //
    // So the announcement carries a per-announcement `seq`, and `seq` is the KEY of the
    // element holding the text. A key change makes React replace that node rather than
    // reuse it, so identical text still arrives as a removal + insertion inside the live
    // region — content the AT has not seen before, in ONE commit.
    //
    // Deliberately not the two alternatives: a clear-then-set across two commits works only
    // if React commits the empty render before the refill lands, which is an assumption
    // about scheduler ordering rather than something the code enforces (lose that race and
    // the two updates coalesce and the bug is back); and a trailing-whitespace toggle can be
    // read as unchanged by AT that normalizes whitespace before diffing.
    const [announcement, setAnnouncement] = useState({seq: 0, text: ''});
    const announce = useCallback((text: string): void => {
        setAnnouncement((prev) => ({seq: prev.seq + 1, text}));
    }, []);
    // Which provider settled — with more than one row, a bare "Sync completed" is
    // ambiguous, and going to look it up is exactly the re-navigation this removes.
    const announceLabel = `${meta.label} · ${provider.container}`;

    // Runs THIS row triggered itself, identified by the 202 handle's `started_at`. This
    // is the second source the latch needs, and it is not redundant with the poll: a
    // trigger gets exactly ONE invalidation refetch, and polling is itself gated on
    // `active_sync` (`gitProvidersRefetchInterval`). So a run that starts and settles
    // before that single GET is served is never observed in flight, no later poll
    // revisits the row, and a poll-only latch would stay silent for precisely the
    // fast-failing run whose outcome an admin most needs to hear.
    //
    // `mutation.data` is a run IDENTITY, never an in-flight signal (it is cleared while
    // the next trigger is pending and set again on its 202) — the in-flight test stays
    // `stageAnnouncement !== null`. Both mutations can hold a handle, so take the later.
    const triggeredRunStartedAt = laterInstant(
        sync.data?.started_at ?? null,
        syncOlder.data?.started_at ?? null,
    );
    // The most recent run this row knows about right now, from either source.
    const knownRunStartedAt = laterInstant(activeSync?.started_at ?? null, triggeredRunStartedAt);

    // The derived identity goes null the moment a poll-observed run settles, so the run
    // has to be remembered; `laterInstant` keeps it monotone. That monotonicity is an
    // ASSUMPTION about the server: `started_at` is stamped at trigger time, so a run is
    // always later than the one before it. If a clock ever stepped backwards, this ref
    // would stay pinned to the older run and no terminal outcome would be announced again
    // for the rest of the page session (the unlatched stage branch would keep speaking, so
    // the row would look alive and simply never finish). Tracked as a follow-up, not
    // defended here — the wire carries no run id to key on instead.
    const knownRun = useRef<string | null>(null);
    // Whether the CURRENT known run was ever seen in flight. It decides how a
    // not-yet-recorded outcome is read (see below), and is consumed when the run is
    // announced.
    const observedInFlight = useRef(false);
    // Which run's terminal outcome has already been spoken. Without it a later dep change
    // would repeat it; with it, a SECOND run in the same page session announces exactly
    // once (its `started_at` differs) — the mechanism the feature rests on across a
    // session.
    const announcedRun = useRef<string | null>(null);
    useEffect(() => {
        knownRun.current = laterInstant(knownRun.current, knownRunStartedAt);
        if (stageAnnouncement !== null) {
            observedInFlight.current = true;
            // Deliberately NOT latched, unlike the terminal branch below: a page loaded
            // while another admin's run is in flight should say so. It is the settled
            // ok/error flip that must not be announced on mount.
            announce(`${announceLabel}: ${stageAnnouncement}`);
            return;
        }
        const run = knownRun.current;
        // Nothing this row saw in flight or triggered itself. A row whose last sync
        // settled before this page load stays silent — without this, mounting a row
        // carrying last week's 'error' would announce "Sync failed" on every page load.
        if (run === null || announcedRun.current === run) return;
        const recorded = outcomeBelongsToRun(provider.last_sync_at, run);
        // Knowing the run is OVER is not the same for the two sources, and conflating
        // them is what makes the announcement either premature or absent:
        //  - Observed in flight, now gone: the poll that shows `active_sync: null` is the
        //    same response that would carry the outcome, so this IS the settle. An
        //    unrecorded outcome here is the real thing — the in-flight registry is a
        //    process-local Map, so a restart mid-run loses it — and must be said as such.
        //  - Known only from our own 202: the registry entry is set BEFORE the 202 is
        //    answered, so any later list either shows the run in flight or shows it
        //    finished. A row that still carries the pre-run outcome is therefore just a
        //    response we haven't received yet, not a lost run — don't consume the latch on
        //    a claim of ignorance.
        //    Be clear about what "wait" means here: polling is gated on `active_sync`, and
        //    the trigger's one invalidation refetch has already been served, so there is no
        //    further response coming and this row will simply never announce that run. That
        //    is the accepted trade — a sighted admin gets nothing either (the badge keeps
        //    its pre-run value), whereas consuming the latch here would suppress the REAL
        //    outcome if it did arrive.
        if (!observedInFlight.current && !recorded) return;
        observedInFlight.current = false;
        announcedRun.current = run;
        // An outcome that does not belong to this run is passed as `null`, which is the
        // same "nothing this row can honestly name" input as a NULL column — one gate, in
        // the function that owns the fallback, rather than the same fallback spelled twice.
        announce(
            `${announceLabel}: ${syncTerminalAnnouncement(recorded ? provider.last_sync_status : null)}`,
        );
    }, [
        knownRunStartedAt,
        stageAnnouncement,
        announceLabel,
        provider.last_sync_at,
        provider.last_sync_status,
        announce,
    ]);

    // A run is in flight server-side (from the polled list) OR either trigger POST
    // (sync-now / sync-older-history) is still pending — either way the sync
    // controls stay down and show progress. Both triggers share the server's
    // in-flight registry, so only one can actually be running at a time.
    const syncRunning = activeSync !== null || sync.isPending || syncOlder.isPending;

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
                    {/* The sync lifecycle for assistive tech (#278) — see the block that
                        computes `announcement` in this component for why it lives here and
                        not on the Badge or the progress line.

                        Rendered UNCONDITIONALLY, empty until there is something to say: a
                        live region inserted into the DOM together with its first text is
                        unreliably announced, so the element has to already be present when
                        the text changes. It sits in the "Last sync" cell because that is the
                        cell whose visible state it is speaking for. */}
                    <span role="status" className="sr-only" data-testid="sync-announcement">
                        {/* Keyed on the announcement sequence — see `announce` above: the
                            key is what makes a REPEATED outcome ("Sync failed" twice) a real
                            DOM change instead of a no-op React bails out of. */}
                        <span key={announcement.seq}>{announcement.text}</span>
                    </span>
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
                        {/*
                          * NOT a live region (#270 review DUP-1). It used to be
                          * role="status", which was tolerable only because the old label
                          * was byte-identical for minutes at a time. The within-repo
                          * counter now changes on nearly every 1s poll for the whole
                          * fetching stage, so a polite live region would announce a
                          * ~70-character line once per second for the length of a
                          * multi-hour first sync — and the digit is the least useful part
                          * to hear.
                          *
                          * What a screen reader gets instead, since #278: the disabled
                          * "Syncing…" button conveys in-flight state, and the row's
                          * sr-only `role="status"` element in the "Last sync" cell
                          * announces the coarse stage plus the terminal completed/failed
                          * outcome. That is the low-churn placement — never this counter
                          * line, and never `Badge`, which ~10 other screens share.
                          */}
                        <span
                            className="flex items-center gap-2 text-sm text-muted"
                            data-testid="sync-progress"
                        >
                            <Spinner />
                            {syncProgressLabel(provider.active_sync)}
                        </span>
                    </td>
                </tr>
            ) : null}
            {provider.last_sync_advisories.length > 0 ? (
                <tr>
                    <td colSpan={7} className="px-3 pb-3">
                        <SyncAdvisories
                            lines={provider.last_sync_advisories}
                            status={provider.last_sync_status}
                        />
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
            {/* The delete is destructive, so its OUTCOME is reported rather than left silent
                (#264): the admin sees exactly how much history was retracted, and that no
                developer was deleted. Rendered ABOVE the empty state deliberately — deleting
                your only provider satisfies both conditions on the same render, and the report
                of what just happened must not sit below a "nothing here yet" panel. */}
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
            {showEmptyState ? <GitEmptyState /> : null}
            {/* No form renders until the admin asks for one. Keyed so add ⇄ edit
                ⇄ another row always remounts clean fields (#236 criterion 3). */}
            {formModal.mode !== 'closed' ? (
                <ProviderFormModal
                    key={formModal.editing?.id ?? 'new'}
                    editing={formModal.editing}
                    // Both sources, so a container owned by a read-only config-file provider
                    // is flagged the same way a connected one is (#266 AC7).
                    providers={providerList}
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
                ) : /* Only a load with NOTHING to show replaces the table. react-query keeps
                       `data` when a BACKGROUND refetch fails, and this list is polled once a
                       second while a sync runs (`gitProvidersRefetchInterval`), so blanking
                       the table on `isError` alone threw away every row — and with it every
                       ProviderRow's mount-scoped sync state: the #278 announcement latch
                       (`knownRun`/`observedInFlight`/`announcedRun`) and the mutation handles
                       holding the 202. The run that was in flight would then settle into a
                       remounted row that has never heard of it, and its outcome would never
                       be announced. A transient poll failure must not cost the announcement,
                       so the retained rows stay and the failure is reported above them. */
                providers.isError && !hasProviders ? (
                    <p className="text-sm text-danger">Failed to load: {providers.error.message}</p>
                ) : !hasProviders ? (
                    <p className="text-sm text-muted">
                        No providers connected yet. Use “＋ Add git provider” above to start
                        analyzing git activity.
                    </p>
                ) : (
                    <>
                        {providers.isError ? (
                            <p
                                className="mb-2 text-sm text-danger"
                                role="status"
                                data-testid="providers-refresh-error"
                            >
                                Failed to refresh: {providers.error.message}
                            </p>
                        ) : null}
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
                    </>
                )}
            </Card>
        </div>
    );
}
