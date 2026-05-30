import type {ApiEnvelope, AuthUser, OverviewData} from './types';

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
};
