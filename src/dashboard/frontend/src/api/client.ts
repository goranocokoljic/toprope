import type {
    AdminDataSources,
    AdminDeveloper,
    AdminPasswordReset,
    AdminSubscription,
    AdminTeam,
    AdminUser,
    AdminUserWithTempPassword,
    ApiEnvelope,
    AuthUser,
    CoverageData,
    GlobalSettings,
    Leaderboard,
    LeaderboardAvailability,
    LeaderboardMetric,
    MaturityTrend,
    MeActivity,
    MeJourney,
    MeOverview,
    MeTimeline,
    MeTools,
    OverviewData,
    OverviewTrend,
    PaginatedResponse,
    SummaryDetail,
    SummaryLevel,
    SummaryListItem,
    TeamDetail,
    TeamListItem,
    TeamProviders,
    TeamSettings,
    TeamTrend,
    ToolDistribution,
    UserPreferences,
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
        throw new ApiError(res.status, `Request to ${path} failed with ${res.status}`);
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

    async updateAdminDeveloperIdentities(
        id: string,
        identities: {
            github?: string;
            copilot?: string;
            claude?: string;
            windsurf?: string;
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

    /** Personal adoption journey: per-tool status + lifecycle milestones. */
    async getMeJourney(): Promise<MeJourney> {
        const body = await request<ApiEnvelope<MeJourney>>('/api/me/journey');
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

    // --- Preferences (own) ---
    async getPreferences(): Promise<UserPreferences> {
        const body = await request<ApiEnvelope<UserPreferences>>('/api/me/preferences');
        return body.data;
    },

    async patchPreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
        const body = await patchJson<ApiEnvelope<UserPreferences>>('/api/me/preferences', patch);
        return body.data;
    },
};
