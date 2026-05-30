import type {
    ApiEnvelope,
    AuthUser,
    GlobalSettings,
    OverviewData,
    TeamSettings,
    UserPreferences,
} from './types';

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

    /** Team names, for the per-team settings selector. */
    async getTeamNames(): Promise<string[]> {
        const body = await request<{data: {name: string}[]}>('/api/teams?limit=100');
        return body.data.map((t) => t.name);
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
