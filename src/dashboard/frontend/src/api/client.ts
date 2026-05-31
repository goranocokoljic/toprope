import type {
    ApiEnvelope,
    AuthUser,
    CoverageData,
    GlobalSettings,
    OverviewData,
    OverviewTrend,
    TeamSettings,
    ToolDistribution,
    UserPreferences,
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
     * Team names, for the per-team settings selector. `/api/teams` caps `limit`
     * at 100, so we page through until every team is collected rather than
     * silently truncating the selector for orgs with >100 teams.
     */
    async getTeamNames(): Promise<string[]> {
        const names: string[] = [];
        for (let page = 1; ; page += 1) {
            const body = await request<{
                data: {name: string}[];
                pagination: {page: number; limit: number; total: number};
            }>(`/api/teams?page=${page}&limit=100`);
            names.push(...body.data.map((t) => t.name));
            const {limit, total} = body.pagination;
            if (body.data.length === 0 || page * limit >= total) {
                break;
            }
        }
        return names;
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
