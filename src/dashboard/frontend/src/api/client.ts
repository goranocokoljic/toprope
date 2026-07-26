import type {
    AdminDataSources,
    AdminDeveloper,
    AdminDeveloperCreated,
    AdminDeveloperInput,
    AuthorCandidate,
    AdminPasswordReset,
    AdminSubscription,
    AdminTeam,
    AdminGitProvider,
    AdminUser,
    AdminUserWithTempPassword,
    AnomalyAlert,
    AnomalyConfig,
    AnomalyConfigPatch,
    AnomalyStatus,
    ApiEnvelope,
    AuthUser,
    CompareTable,
    CoverageData,
    DeveloperIdentity,
    DeveloperJourney,
    MyPRReviewCoaching,
    GitProviderInput,
    GitProviderProbeResult,
    GitProviderRepo,
    GitProviderSyncHandle,
    GlobalSettings,
    Leaderboard,
    LeaderboardAvailability,
    LeaderboardMetric,
    MaturityTrend,
    MeActivity,
    MeOverview,
    MeTimeline,
    MeTools,
    OverviewData,
    OverviewTrend,
    PaginatedResponse,
    PRReviewPeriodUnit,
    ReconciliationResult,
    ReconciliationRunSummary,
    ReconciliationStatus,
    SummaryDetail,
    SummaryLevel,
    SummaryListItem,
    TeamComparison,
    TeamDetail,
    TeamListItem,
    ManagerCoachingPanel,
    TeamProviders,
    TeamSettings,
    TeamTrend,
    ToolDistribution,
    UserPreferences,
    CoachingPreferences,
    CoachingPreferencesPatch,
    RelatedPractices,
    PracticeBrowseList,
    BrowsePracticeDetail,
    PracticeHistoryEntry,
    PracticeFeedbackSignal,
    PracticeFeedbackResult,
    PracticePreview,
    OwnedPracticeView,
    CreatedPractice,
    ShowcaseGalleryList,
    BrowseShowcaseDetail,
    ShowcaseRemovalNotice,
    WasteAlert,
    WasteResolutionReason,
    WasteTeamSummary,
} from './types';

/**
 * Query params for a time-windowed request. Either a named preset (`range`) or
 * an explicit custom window (`from`+`to`); the backend recomputes preset windows
 * server-side, so for presets we send only `range`.
 */
export interface TimeRangeQuery {
    range?: string;
    from?: string;
    to?: string;
}

function timeRangeQueryString(params: TimeRangeQuery): string {
    const search = new URLSearchParams();
    if (params.range) {
        search.set('range', params.range);
    } else {
        if (params.from) search.set('from', params.from);
        if (params.to) search.set('to', params.to);
    }
    const qs = search.toString();
    return qs ? `?${qs}` : '';
}

/**
 * Typed, fetch-based client for the Phase 1 API. In production the SPA is
 * served from the same origin as the API (Fastify at /dashboard), so the base
 * is empty and requests are relative. VITE_API_BASE can point elsewhere for
 * local development against a remote backend.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        // Send the session cookie with every request (same-origin in prod).
        credentials: 'include',
        headers: {
            Accept: 'application/json',
            ...init?.headers,
        },
    });

    if (!res.ok) {
        // Prefer the server's typed error body ({error, message}) so the UI can
        // show "A sync is already in progress…" instead of a bare status code.
        // Only 4xx and 503 qualify: those are DELIBERATE messages written for
        // users (validation errors, conflicts, the 503 key-setup remediation —
        // see serviceUnavailable in admin/helpers.ts). Other 5xx bodies come
        // from Fastify's default handler echoing a raw internal err.message
        // (SQLite constraints etc.) — keep the generic line for those.
        const isTypedStatus = (res.status >= 400 && res.status < 500) || res.status === 503;
        let message = `Request to ${path} failed with ${res.status}`;
        if (isTypedStatus) {
            try {
                const body = (await res.json()) as {message?: unknown};
                if (typeof body.message === 'string' && body.message.trim() !== '') {
                    message = body.message;
                }
            } catch {
                // Non-JSON error body — keep the generic message.
            }
        }
        throw new ApiError(res.status, message);
    }

    return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
}

async function deleteJson<T>(path: string): Promise<T> {
    return request<T>(path, {method: 'DELETE'});
}

/**
 * Collect every row of a paginated endpoint. The API caps `limit` at 100, so
 * callers that need the full set (sorted/merged client-side) page through here
 * rather than each re-implementing the same termination logic. `pathFor`
 * builds the request path for a given 1-based page.
 */
async function fetchAllPages<T>(pathFor: (page: number) => string): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; ; page += 1) {
        const body = await request<PaginatedResponse<T>>(pathFor(page));
        rows.push(...body.data);
        const {limit, total} = body.pagination;
        if (body.data.length === 0 || page * limit >= total) {
            break;
        }
    }
    return rows;
}

export const api = {
    async getOverview(): Promise<OverviewData> {
        const body = await request<ApiEnvelope<OverviewData>>('/api/overview');
        return body.data;
    },

    /** Per-tool seat/developer/cost distribution across the org (admin). */
    async getToolDistribution(): Promise<ToolDistribution> {
        const body = await request<ApiEnvelope<ToolDistribution>>('/api/tools/distribution');
        return body.data;
    },

    /** Active-developer adoption trend over a time window (admin). */
    async getOverviewTrend(params: TimeRangeQuery): Promise<OverviewTrend> {
        const body = await request<ApiEnvelope<OverviewTrend>>(
            `/api/overview/trend${timeRangeQueryString(params)}`,
        );
        return body.data;
    },

    /** Data-coverage snapshot: per-developer quality, connectors, git providers (admin). */
    async getCoverage(): Promise<CoverageData> {
        const body = await request<ApiEnvelope<CoverageData>>('/api/coverage');
        return body.data;
    },

    /** Per-team open-waste rollup, ordered by waste descending. */
    async getWasteSummary(): Promise<WasteTeamSummary[]> {
        const body = await request<ApiEnvelope<WasteTeamSummary[]>>('/api/waste/summary');
        return body.data;
    },

    /**
     * Every team's list-row summary. The teams list sorts client-side, so we
     * collect all pages rather than truncating an org with >100 teams.
     */
    async getTeams(): Promise<TeamListItem[]> {
        return fetchAllPages<TeamListItem>((page) => `/api/teams?page=${page}&limit=100`);
    },

    /** Full detail (summary + per-developer aggregates) for one team. */
    async getTeamDetail(team: string): Promise<TeamDetail> {
        const body = await request<ApiEnvelope<TeamDetail>>(
            `/api/teams/${encodeURIComponent(team)}`,
        );
        return body.data;
    },

    /** Adoption trend scoped to one team over a time window (admin). */
    async getTeamTrend(team: string, params: TimeRangeQuery): Promise<TeamTrend> {
        const body = await request<ApiEnvelope<TeamTrend>>(
            `/api/teams/${encodeURIComponent(team)}/trend${timeRangeQueryString(params)}`,
        );
        return body.data;
    },

    /**
     * Rich side-by-side comparison of 2–4 teams over a time window (admin). The
     * caller passes the selected team names; the server validates the 2–4 bound
     * and assembles per-metric rows, tiers, and one trend line per team.
     */
    async getCompare(teams: string[], params: TimeRangeQuery): Promise<TeamComparison> {
        const search = new URLSearchParams();
        search.set('teams', teams.join(','));
        if (params.range) {
            search.set('range', params.range);
        } else {
            if (params.from) search.set('from', params.from);
            if (params.to) search.set('to', params.to);
        }
        const body = await request<ApiEnvelope<TeamComparison>>(`/api/compare?${search.toString()}`);
        return body.data;
    },

    /**
     * Sortable all-teams ranking table for one period (admin). Reads the
     * pre-computed quarterly rollup, so it stays fast for many teams. Omit
     * `period` to get the latest rolled-up quarter; the response echoes the
     * resolved period and lists the available quarters for the selector.
     */
    async getCompareTable(period?: string): Promise<CompareTable> {
        const qs = period ? `?period=${encodeURIComponent(period)}` : '';
        const body = await request<ApiEnvelope<CompareTable>>(`/api/teams/compare-table${qs}`);
        return body.data;
    },

    /** Git provider(s) hosting a team's repos, by developer git activity. */
    async getTeamProviders(team: string): Promise<TeamProviders> {
        const body = await request<ApiEnvelope<TeamProviders>>(
            `/api/teams/${encodeURIComponent(team)}/providers`,
        );
        return body.data;
    },

    /** Open waste alerts scoped to one team (all pages). */
    async getTeamWaste(team: string): Promise<WasteAlert[]> {
        const q = encodeURIComponent(team);
        return fetchAllPages<WasteAlert>((page) => `/api/waste?team=${q}&page=${page}&limit=100`);
    },

    /**
     * Every active (unresolved) waste alert across the org. The waste screen
     * computes its own totals and per-type breakdown client-side, so it needs
     * the full set rather than one page.
     */
    async getWasteAlerts(): Promise<WasteAlert[]> {
        return fetchAllPages<WasteAlert>((page) => `/api/waste?page=${page}&limit=100`);
    },

    /**
     * Resolved waste alerts — the audit trail. The endpoint returns the full set
     * unpaginated today; if it ever gains pagination (as /api/waste already has),
     * switch this to fetchAllPages so the audit view can't silently truncate.
     */
    async getResolvedWaste(): Promise<WasteAlert[]> {
        const body = await request<ApiEnvelope<WasteAlert[]>>('/api/waste/resolved');
        return body.data;
    },

    /** Mark an active alert resolved with a structured reason. */
    async resolveWaste(id: string, reason: WasteResolutionReason): Promise<WasteAlert> {
        const body = await postJson<ApiEnvelope<WasteAlert>>(
            `/api/waste/${encodeURIComponent(id)}/resolve`,
            {reason},
        );
        return body.data;
    },

    /**
     * Fetch the current session identity. Returns null when not authenticated
     * (401) instead of throwing, so the auth provider can treat "no session" as
     * a normal state rather than an error.
     */
    async getMe(): Promise<AuthUser | null> {
        try {
            const body = await request<ApiEnvelope<AuthUser>>('/api/auth/me');
            return body.data;
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                return null;
            }
            throw err;
        }
    },

    async login(email: string, password: string): Promise<void> {
        await postJson<ApiEnvelope<unknown>>('/api/auth/login', {email, password});
    },

    async logout(): Promise<void> {
        await postJson<ApiEnvelope<unknown>>('/api/auth/logout', {});
    },

    async changePassword(currentPassword: string, newPassword: string): Promise<void> {
        await postJson<ApiEnvelope<unknown>>('/api/auth/change-password', {
            current_password: currentPassword,
            new_password: newPassword,
        });
    },

    /**
     * Team names, for the per-team settings selector. Pages through every team
     * rather than silently truncating the selector for orgs with >100 teams.
     */
    async getTeamNames(): Promise<string[]> {
        const teams = await fetchAllPages<{name: string}>((page) => `/api/teams?page=${page}&limit=100`);
        return teams.map((t) => t.name);
    },

    // --- Settings (admin) ---
    async getGlobalSettings(): Promise<GlobalSettings> {
        const body = await request<ApiEnvelope<GlobalSettings>>('/api/settings/global');
        return body.data;
    },

    async patchGlobalSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
        const body = await patchJson<ApiEnvelope<GlobalSettings>>('/api/settings/global', patch);
        return body.data;
    },

    async getTeamSettings(team: string): Promise<TeamSettings> {
        const body = await request<ApiEnvelope<TeamSettings>>(
            `/api/settings/team/${encodeURIComponent(team)}`,
        );
        return body.data;
    },

    async patchTeamSettings(team: string, patch: Partial<GlobalSettings>): Promise<TeamSettings> {
        const body = await patchJson<ApiEnvelope<TeamSettings>>(
            `/api/settings/team/${encodeURIComponent(team)}`,
            patch,
        );
        return body.data;
    },

    // --- Anomaly detection config (Task 4.12) ---
    async getAnomalyConfig(): Promise<AnomalyConfig> {
        const body = await request<ApiEnvelope<AnomalyConfig>>('/api/settings/anomaly');
        return body.data;
    },

    async patchAnomalyConfig(patch: AnomalyConfigPatch): Promise<AnomalyConfig> {
        const body = await patchJson<ApiEnvelope<AnomalyConfig>>('/api/settings/anomaly', patch);
        return body.data;
    },

    // --- Optional leaderboard (Task 2.17) ---
    /**
     * Whether a leaderboard is available to the current principal. Returns a
     * not-available result instead of throwing on 401/403, so the nav can treat
     * "leaderboard off / not permitted" as a normal state and simply hide the
     * entry point rather than surfacing an error.
     */
    async getLeaderboardAvailability(): Promise<LeaderboardAvailability> {
        try {
            const body = await request<ApiEnvelope<LeaderboardAvailability>>('/api/leaderboard/availability');
            return body.data;
        } catch (err) {
            if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
                return {available: false};
            }
            throw err;
        }
    },

    /** Ranked leaderboard for a team by the chosen metric (admin/manager). */
    async getLeaderboard(team: string, metric: LeaderboardMetric): Promise<Leaderboard> {
        const body = await request<ApiEnvelope<Leaderboard>>(
            `/api/leaderboard/${encodeURIComponent(team)}?metric=${encodeURIComponent(metric)}`,
        );
        return body.data;
    },

    // --- Admin: users ---
    async getAdminUsers(): Promise<AdminUser[]> {
        const body = await request<ApiEnvelope<AdminUser[]>>('/api/admin/users');
        return body.data;
    },

    async createAdminUser(input: {
        email: string;
        role: string;
        developer_id?: string | null;
    }): Promise<AdminUserWithTempPassword> {
        const body = await postJson<ApiEnvelope<AdminUserWithTempPassword>>('/api/admin/users', input);
        return body.data;
    },

    async updateAdminUser(
        id: string,
        patch: {email?: string; role?: string; developer_id?: string | null; active?: boolean},
    ): Promise<AdminUser> {
        const body = await patchJson<ApiEnvelope<AdminUser>>(
            `/api/admin/users/${encodeURIComponent(id)}`,
            patch,
        );
        return body.data;
    },

    async resetAdminUserPassword(id: string): Promise<AdminPasswordReset> {
        const body = await postJson<ApiEnvelope<AdminPasswordReset>>(
            `/api/admin/users/${encodeURIComponent(id)}/reset-password`,
            {},
        );
        return body.data;
    },

    // --- Admin: teams ---
    async getAdminTeams(): Promise<AdminTeam[]> {
        const body = await request<ApiEnvelope<AdminTeam[]>>('/api/admin/teams');
        return body.data;
    },

    async createAdminTeam(input: {
        name: string;
        department?: string | null;
        manager?: string | null;
    }): Promise<AdminTeam> {
        const body = await postJson<ApiEnvelope<AdminTeam>>('/api/admin/teams', input);
        return body.data;
    },

    async updateAdminTeam(
        name: string,
        patch: {department?: string | null; manager?: string | null; archived?: boolean},
    ): Promise<AdminTeam> {
        const body = await patchJson<ApiEnvelope<AdminTeam>>(
            `/api/admin/teams/${encodeURIComponent(name)}`,
            patch,
        );
        return body.data;
    },

    // --- Admin: developers (identity mapping + team move) ---
    async getAdminDevelopers(): Promise<AdminDeveloper[]> {
        const body = await request<ApiEnvelope<AdminDeveloper[]>>('/api/admin/developers');
        return body.data;
    },

    /**
     * Create a developer. The server also replays their retained git authorship in
     * the same transaction, so `dates_attributed` reports how much history the
     * create actually recovered — the confirmation the review queue shows.
     */
    async createAdminDeveloper(input: AdminDeveloperInput): Promise<AdminDeveloperCreated> {
        const body = await postJson<ApiEnvelope<AdminDeveloper> & {replay?: {dates_attributed?: number}}>(
            '/api/admin/developers',
            input,
        );
        return {developer: body.data, dates_attributed: body.replay?.dates_attributed ?? 0};
    },

    async getAdminDeveloperCandidates(): Promise<AuthorCandidate[]> {
        const body = await request<ApiEnvelope<AuthorCandidate[]>>(
            '/api/admin/developers/candidates',
        );
        return body.data;
    },

    async updateAdminDeveloperIdentities(
        id: string,
        identities: {
            github?: string;
            copilot?: string;
            claude?: string;
            windsurf?: string;
            cursor?: string;
            bitbucket?: string;
            gitlab?: string;
            git_emails?: string[];
        },
    ): Promise<AdminDeveloper> {
        const body = await patchJson<ApiEnvelope<AdminDeveloper>>(
            `/api/admin/developers/${encodeURIComponent(id)}/identities`,
            identities,
        );
        return body.data;
    },

    async moveAdminDeveloper(id: string, team: string): Promise<AdminDeveloper> {
        const body = await patchJson<ApiEnvelope<AdminDeveloper>>(
            `/api/admin/developers/${encodeURIComponent(id)}`,
            {team},
        );
        return body.data;
    },

    // --- Admin: subscriptions ---
    async getAdminSubscriptions(): Promise<AdminSubscription[]> {
        const body = await request<ApiEnvelope<AdminSubscription[]>>('/api/admin/subscriptions');
        return body.data;
    },

    async assignAdminSubscription(input: {
        developer_id: string;
        tool: string;
        plan?: string | null;
        monthly_cost?: number | null;
        billing_model?: string;
    }): Promise<AdminSubscription> {
        const body = await postJson<ApiEnvelope<AdminSubscription>>('/api/admin/subscriptions', input);
        return body.data;
    },

    async endAdminSubscription(id: string): Promise<AdminSubscription> {
        const body = await patchJson<ApiEnvelope<AdminSubscription>>(
            `/api/admin/subscriptions/${encodeURIComponent(id)}`,
            {active: false},
        );
        return body.data;
    },

    // --- Admin: data sources (read-only) ---
    async getAdminDataSources(): Promise<AdminDataSources> {
        const body = await request<ApiEnvelope<AdminDataSources>>('/api/admin/data-sources');
        return body.data;
    },

    // --- Admin: git providers (GC1 / #200) ---
    // Every route is admin-gated server-side. Tokens are write-only: they are
    // sent on create/update and NEVER returned — responses carry only the mask.
    async getAdminGitProviders(): Promise<AdminGitProvider[]> {
        const body = await request<ApiEnvelope<AdminGitProvider[]>>('/api/admin/git/providers');
        return body.data;
    },

    async createAdminGitProvider(input: GitProviderInput): Promise<AdminGitProvider> {
        const body = await postJson<ApiEnvelope<AdminGitProvider>>('/api/admin/git/providers', input);
        return body.data;
    },

    async updateAdminGitProvider(id: string, patch: GitProviderInput): Promise<AdminGitProvider> {
        const body = await patchJson<ApiEnvelope<AdminGitProvider>>(
            `/api/admin/git/providers/${encodeURIComponent(id)}`,
            patch,
        );
        return body.data;
    },

    async deleteAdminGitProvider(id: string): Promise<{id: string; deleted: boolean}> {
        const body = await deleteJson<ApiEnvelope<{id: string; deleted: boolean}>>(
            `/api/admin/git/providers/${encodeURIComponent(id)}`,
        );
        return body.data;
    },

    /**
     * List a SAVED provider's repositories for the repo-scope picker (GC1.9 /
     * #201). Returns `{name, archived, defaultBranch}` per repo. A failed listing
     * is a 502 on the server, so this rejects (ApiError) rather than resolving —
     * the picker surfaces the error and the admin can still choose "monitor all".
     */
    async getAdminGitProviderRepos(id: string): Promise<GitProviderRepo[]> {
        const body = await request<ApiEnvelope<GitProviderRepo[]>>(
            `/api/admin/git/providers/${encodeURIComponent(id)}/repos`,
        );
        return body.data;
    },

    /** Probe a SAVED provider (DB row or read-only config) by id. */
    async testAdminGitProvider(id: string): Promise<GitProviderProbeResult> {
        return postJson<GitProviderProbeResult>(
            `/api/admin/git/providers/${encodeURIComponent(id)}/test`,
            {},
        );
    },

    /** Probe a DRAFT (unsaved) provider from the form body — nothing is persisted. */
    async testDraftGitProvider(input: GitProviderInput): Promise<GitProviderProbeResult> {
        return postJson<GitProviderProbeResult>('/api/admin/git/providers/test', input);
    },

    /**
     * Trigger a sync for one saved DB provider (fire-and-forget). `months` sets the
     * first-sync history window and is sent only when provided (the server defaults
     * it and ignores it entirely once the provider has a stored cursor).
     */
    async syncAdminGitProvider(id: string, months?: number): Promise<GitProviderSyncHandle> {
        const body = await postJson<ApiEnvelope<GitProviderSyncHandle>>(
            `/api/admin/git/providers/${encodeURIComponent(id)}/sync`,
            months === undefined ? {} : {months},
        );
        return body.data;
    },

    /**
     * Extend one saved provider's synced window BACKWARD (#229) — "Sync older
     * history". `months` is the ABSOLUTE amount of history to keep (e.g. 12 = "show
     * me 12 months"), not a relative delta. Fire-and-forget like the normal sync;
     * the outcome lands on the row. The server additively fetches only the
     * never-synced older slice and rejects (409) when the window wouldn't extend
     * further back than already synced.
     */
    async syncOlderHistoryAdminGitProvider(id: string, months: number): Promise<GitProviderSyncHandle> {
        const body = await postJson<ApiEnvelope<GitProviderSyncHandle>>(
            `/api/admin/git/providers/${encodeURIComponent(id)}/sync-older-history`,
            {months},
        );
        return body.data;
    },

    // --- Admin: expense reconciliation (Task 4.4 / #99) ---
    async getReconciliation(status: ReconciliationStatus | 'all'): Promise<ReconciliationResult[]> {
        const body = await request<ApiEnvelope<ReconciliationResult[]>>(
            `/api/admin/reconciliation?status=${encodeURIComponent(status)}`,
        );
        return body.data;
    },

    async runReconciliation(input: {period?: string; tolerance?: number}): Promise<ReconciliationRunSummary> {
        const body = await postJson<ApiEnvelope<ReconciliationRunSummary>>(
            '/api/admin/reconciliation/run',
            input,
        );
        return body.data;
    },

    async resolveReconciliation(id: string, resolution: string): Promise<ReconciliationResult> {
        const body = await postJson<ApiEnvelope<ReconciliationResult>>(
            `/api/admin/reconciliation/${encodeURIComponent(id)}/resolve`,
            {resolution},
        );
        return body.data;
    },

    async ignoreReconciliation(id: string, note?: string): Promise<ReconciliationResult> {
        const body = await postJson<ApiEnvelope<ReconciliationResult>>(
            `/api/admin/reconciliation/${encodeURIComponent(id)}/ignore`,
            note ? {note} : {},
        );
        return body.data;
    },

    // --- Developer "My Dashboard" (Task 2.8): session-scoped to the caller ---
    /** Personal stat summary over a time window. */
    async getMeOverview(params: TimeRangeQuery): Promise<MeOverview> {
        const body = await request<ApiEnvelope<MeOverview>>(`/api/me/overview${timeRangeQueryString(params)}`);
        return body.data;
    },

    /** Personal activity timeline (AI interactions + git) over a time window. */
    async getMeTimeline(params: TimeRangeQuery): Promise<MeTimeline> {
        const body = await request<ApiEnvelope<MeTimeline>>(`/api/me/timeline${timeRangeQueryString(params)}`);
        return body.data;
    },

    /**
     * Personal adoption journey (Task 4.11): per-tool status + lifecycle
     * milestones, plus the timeline bounds, weekly trajectory, annotated key
     * moments, and data tier.
     */
    async getMeJourney(): Promise<DeveloperJourney> {
        const body = await request<ApiEnvelope<DeveloperJourney>>('/api/me/journey');
        return body.data;
    },

    /**
     * Manager's aggregate view of a developer's adoption journey (Task 4.11).
     * Same shape as the developer's own journey — no prompt content, nothing
     * rankable — framed as journey/health on the manager surface.
     */
    async getDeveloperJourney(id: string): Promise<DeveloperJourney> {
        const body = await request<ApiEnvelope<DeveloperJourney>>(
            `/api/developers/${encodeURIComponent(id)}/journey`,
        );
        return body.data;
    },

    /** Developer identity (name/team) for the manager developer-detail header. */
    async getDeveloperIdentity(id: string): Promise<DeveloperIdentity> {
        const body = await request<ApiEnvelope<DeveloperIdentity>>(
            `/api/developers/${encodeURIComponent(id)}`,
        );
        return body.data;
    },

    /** Per-tool usage detail (My Tools, Task 2.9) over a time window. */
    async getMeTools(params: TimeRangeQuery): Promise<MeTools> {
        const body = await request<ApiEnvelope<MeTools>>(`/api/me/tools${timeRangeQueryString(params)}`);
        return body.data;
    },

    /** Personal git activity totals + per-provider breakdown (My Activity, Task 2.9). */
    async getMeActivity(params: TimeRangeQuery): Promise<MeActivity> {
        const body = await request<ApiEnvelope<MeActivity>>(`/api/me/activity${timeRangeQueryString(params)}`);
        return body.data;
    },

    // --- PR/review coaching (Task 5.3) ---
    /**
     * The developer's OWN PR/review coaching trajectory (session-scoped) — both
     * scope variants, framed as a trend over time. `unit` picks weekly/monthly.
     */
    async getMyPRReviewCoaching(unit: PRReviewPeriodUnit): Promise<MyPRReviewCoaching> {
        const body = await request<ApiEnvelope<MyPRReviewCoaching>>(
            `/api/me/pr-coaching?unit=${encodeURIComponent(unit)}`,
        );
        return body.data;
    },

    // --- Manager aggregate coaching panel (Task 5.11) ---
    // The manager team-aggregate PR/review surface is now folded into the unified
    // panel below (getManagerCoachingPanel), which the Team Coaching page consumes;
    // the per-pillar /api/coaching/pr-review/* routes remain on the server as a
    // finer-grained API but have no dedicated client method.
    /**
     * The unified manager coaching panel for a scope (`org` or a team name): all
     * three pillar aggregates plus team coaching opportunities. TEAM-LEVEL ONLY —
     * never an individual's coaching, and there is no drill-down counterpart.
     */
    async getManagerCoachingPanel(scope: string, unit: PRReviewPeriodUnit): Promise<ManagerCoachingPanel> {
        const path =
            scope === 'org'
                ? `/api/coaching/manager/org?unit=${encodeURIComponent(unit)}`
                : `/api/coaching/manager/team/${encodeURIComponent(scope)}?unit=${encodeURIComponent(unit)}`;
        const body = await request<ApiEnvelope<ManagerCoachingPanel>>(path);
        return body.data;
    },

    // --- Phase 3: maturity trend + AI summaries (Task 3.12) ---
    /**
     * Maturity score over a time window for a scope — a real team name or the
     * literal `org` for the developer-count-weighted org roll-up. Honestly
     * labeled a git-based estimate by the UI via each point's `basis`.
     */
    async getMaturityTrend(scope: string, params: TimeRangeQuery): Promise<MaturityTrend> {
        const body = await request<ApiEnvelope<MaturityTrend>>(
            `/api/maturity/${encodeURIComponent(scope)}/trend${timeRangeQueryString(params)}`,
        );
        return body.data;
    },

    /**
     * Summaries for a scope, most recent first. `scope` is the API token: 'org'
     * or 'team:<name>'. The panel filters cadences client-side, so the optional
     * server-side ?level= filter is intentionally not surfaced here.
     */
    async getSummaries(filter: {scope: string}): Promise<SummaryListItem[]> {
        const search = new URLSearchParams({scope: filter.scope});
        const body = await request<ApiEnvelope<SummaryListItem[]>>(`/api/summaries?${search.toString()}`);
        return body.data;
    },

    /** One summary's full narrative text + metadata. */
    async getSummary(id: string): Promise<SummaryDetail> {
        const body = await request<ApiEnvelope<SummaryDetail>>(`/api/summaries/${encodeURIComponent(id)}`);
        return body.data;
    },

    /** Regenerate an existing summary, optionally with a focus instruction. */
    async regenerateSummary(id: string, focus?: string): Promise<SummaryDetail> {
        const body = await postJson<ApiEnvelope<SummaryDetail>>(
            `/api/summaries/${encodeURIComponent(id)}/regenerate`,
            focus ? {focus} : {},
        );
        return body.data;
    },

    /** Generate a summary on demand (used for quarterly/yearly). */
    async generateSummary(input: {level: SummaryLevel; period: string; scope: string}): Promise<SummaryDetail> {
        const body = await postJson<ApiEnvelope<SummaryDetail>>('/api/summaries/generate', input);
        return body.data;
    },

    // --- Anomaly surfacing (Task 4.8) ---
    /** Team anomalies by status (default open) — the manager panel + inline flags. */
    async getAnomalies(status: AnomalyStatus = 'open'): Promise<AnomalyAlert[]> {
        const body = await request<ApiEnvelope<AnomalyAlert[]>>(
            `/api/anomalies?status=${encodeURIComponent(status)}`,
        );
        return body.data;
    },

    /** Mark an anomaly acknowledged (drops it from the open list). */
    async acknowledgeAnomaly(id: string): Promise<AnomalyAlert> {
        const body = await postJson<ApiEnvelope<AnomalyAlert>>(
            `/api/anomalies/${encodeURIComponent(id)}/acknowledge`,
            {},
        );
        return body.data;
    },

    /** Mark an anomaly resolved (drops it from the open list). */
    async resolveAnomaly(id: string): Promise<AnomalyAlert> {
        const body = await postJson<ApiEnvelope<AnomalyAlert>>(
            `/api/anomalies/${encodeURIComponent(id)}/resolve`,
            {},
        );
        return body.data;
    },

    // --- Preferences (own) ---
    async getPreferences(): Promise<UserPreferences> {
        const body = await request<ApiEnvelope<UserPreferences>>('/api/me/preferences');
        return body.data;
    },

    async patchPreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
        const body = await patchJson<ApiEnvelope<UserPreferences>>('/api/me/preferences', patch);
        return body.data;
    },

    // --- Developer coaching preferences (own, Task 5.10) ---
    async getCoachingPreferences(): Promise<CoachingPreferences> {
        const body = await request<ApiEnvelope<CoachingPreferences>>('/api/me/coaching-preferences');
        return body.data;
    },

    async patchCoachingPreferences(patch: CoachingPreferencesPatch): Promise<CoachingPreferences> {
        const body = await patchJson<ApiEnvelope<CoachingPreferences>>(
            '/api/me/coaching-preferences',
            patch,
        );
        return body.data;
    },

    // --- Contextual best-practice display (Task 6.2.7) ---
    /**
     * Best practices to surface next to a metric for the logged-in developer.
     * Viewer-scoped server-side (the developer's own team); returns the ranked set
     * plus the encouraging intro copy. An empty list is a normal result.
     */
    async getRelatedPractices(metric: string, limit?: number): Promise<RelatedPractices> {
        const search = new URLSearchParams({metric});
        if (limit !== undefined) {
            search.set('limit', String(limit));
        }
        const body = await request<ApiEnvelope<RelatedPractices>>(
            `/api/me/practices/related?${search.toString()}`,
        );
        return body.data;
    },

    /**
     * Record that the developer viewed a surfaced practice next to a metric (feeds
     * the 6.2.4 usage signal). Server gates this on the practice actually being
     * surfaced to the viewer for that metric.
     */
    async recordPracticeView(id: string, metric: string): Promise<void> {
        await postJson<ApiEnvelope<unknown>>(
            `/api/me/practices/${encodeURIComponent(id)}/view`,
            {metric},
        );
    },

    // --- Best-practice browse UI (Task 6.2.8) ---
    /**
     * Browse / search the published practices the viewer may see. Free text plus
     * tag/team/scope filters all flow through 6.1.5 search server-side; the response
     * carries the viewer-team's active contribution model for the contribute entry point.
     */
    async browsePractices(filters: PracticeBrowseFilters = {}): Promise<PracticeBrowseList> {
        const search = new URLSearchParams();
        if (filters.q) search.set('q', filters.q);
        if (filters.tag) search.set('tag', filters.tag);
        if (filters.team) search.set('team', filters.team);
        if (filters.scope) search.set('scope', filters.scope);
        const qs = search.toString();
        const body = await request<ApiEnvelope<PracticeBrowseList>>(
            `/api/me/practices/browse${qs ? `?${qs}` : ''}`,
        );
        return body.data;
    },

    /** Full detail of one practice the viewer may see (rendered content, feedback, history access). */
    async getPracticeDetail(id: string): Promise<BrowsePracticeDetail> {
        const body = await request<ApiEnvelope<BrowsePracticeDetail>>(
            `/api/me/practices/browse/${encodeURIComponent(id)}`,
        );
        return body.data;
    },

    /** Version history of a practice the viewer may see, oldest-first. */
    async getPracticeHistory(id: string): Promise<PracticeHistoryEntry[]> {
        const body = await request<ApiEnvelope<PracticeHistoryEntry[]>>(
            `/api/me/practices/browse/${encodeURIComponent(id)}/history`,
        );
        return body.data;
    },

    /** Toggle the viewer's helpful / not-helpful feedback on a practice (6.2.4). */
    async togglePracticeFeedback(
        id: string,
        signal: PracticeFeedbackSignal,
    ): Promise<PracticeFeedbackResult> {
        const body = await postJson<ApiEnvelope<PracticeFeedbackResult>>(
            `/api/me/practices/browse/${encodeURIComponent(id)}/feedback`,
            {signal},
        );
        return body.data;
    },

    // --- Best-practice authoring editor (Task 6.2.3, used by the 6.2.8 entry points) ---
    /** Live markdown preview: sanitized HTML + the metric tags it implies. Persists nothing. */
    async previewPractice(markdown: string): Promise<PracticePreview> {
        const body = await postJson<ApiEnvelope<PracticePreview>>('/api/me/practices/preview', {markdown});
        return body.data;
    },

    /** Create a draft practice from markdown. Team scope pins to the author's own team. */
    async createPractice(input: {
        title: string;
        scope: 'org' | 'team';
        markdown: string;
    }): Promise<CreatedPractice> {
        const body = await postJson<ApiEnvelope<CreatedPractice>>('/api/me/practices', input);
        return body.data;
    },

    /** Load one of the viewer's OWN practices for editing (owner-scoped; 404 otherwise). */
    async getOwnedPractice(id: string): Promise<OwnedPracticeView> {
        const body = await request<ApiEnvelope<OwnedPracticeView>>(
            `/api/me/practices/${encodeURIComponent(id)}`,
        );
        return body.data;
    },

    /** Save an edit to one of the viewer's OWN practices (appends a new version). */
    async savePractice(id: string, markdown: string): Promise<void> {
        await postJson<ApiEnvelope<unknown>>(
            `/api/me/practices/${encodeURIComponent(id)}/save`,
            {markdown},
        );
    },

    // --- Showcase browse/governance (Task 6.3.9) ---
    /**
     * Browse / search the published showcases the viewer may see. Free text plus
     * tag/team/scope filters all flow through 6.1.5 search server-side; results are
     * scope-enforced so a showcase outside the viewer's scope never appears.
     */
    async browseShowcases(filters: ShowcaseBrowseFilters = {}): Promise<ShowcaseGalleryList> {
        const search = new URLSearchParams();
        if (filters.q) search.set('q', filters.q);
        if (filters.tag) search.set('tag', filters.tag);
        if (filters.team) search.set('team', filters.team);
        if (filters.scope) search.set('scope', filters.scope);
        const qs = search.toString();
        const body = await request<ApiEnvelope<ShowcaseGalleryList>>(
            `/api/me/showcase-units/browse${qs ? `?${qs}` : ''}`,
        );
        return body.data;
    },

    /** Full detail of one showcase the viewer may see (note + outcome + annotated turns + AI + cross-links). */
    async getShowcaseDetail(id: string): Promise<BrowseShowcaseDetail> {
        const body = await request<ApiEnvelope<BrowseShowcaseDetail>>(
            `/api/me/showcase-units/${encodeURIComponent(id)}`,
        );
        return body.data;
    },

    /** Owner unpublish: remove one's OWN showcase from the gallery (author-scoped). */
    async unpublishShowcase(id: string): Promise<BrowseShowcaseDetail['state']> {
        const body = await postJson<ApiEnvelope<{state: string}>>(
            `/api/me/showcase-units/${encodeURIComponent(id)}/unpublish`,
            {},
        );
        return body.data.state;
    },

    /** The author's removal-notification feed — lead removals of their own showcases, newest first. */
    async getShowcaseRemovals(): Promise<ShowcaseRemovalNotice[]> {
        const body = await request<ApiEnvelope<ShowcaseRemovalNotice[]>>('/api/me/showcase-units/removals');
        return body.data;
    },
};

/** Query filters for {@link api.browsePractices}. */
export interface PracticeBrowseFilters {
    q?: string;
    tag?: string;
    team?: string;
    scope?: 'org' | 'team';
}

/** Query filters for {@link api.browseShowcases}. */
export interface ShowcaseBrowseFilters {
    q?: string;
    tag?: string;
    team?: string;
    scope?: 'org' | 'team';
}
