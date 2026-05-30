/**
 * Types mirroring the Phase 1 REST API responses. Kept hand-written (rather
 * than generated) for now — the surface is small and these document the exact
 * shape the dashboard depends on. The backend wraps payloads in `{ data: ... }`.
 */

export interface ApiEnvelope<T> {
    data: T;
}

export type DataQuality = 'high' | 'medium' | 'low' | 'none';

export interface OverviewData {
    total_developers: number;
    active_developers: number;
    total_subscriptions: number;
    total_monthly_cost: number;
    active_tools: string[];
    data_quality_distribution: Record<DataQuality, number>;
    active_waste_alert_count: number;
    total_monthly_waste: number;
}

export type UserRole = 'admin' | 'developer';

/** The current session identity, as returned by GET /api/auth/me. */
export interface AuthUser {
    email: string;
    role: UserRole;
    developer_id: string | null;
    must_change_password: boolean;
}
