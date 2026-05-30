export type UserRole = 'admin' | 'developer';

export interface User {
    id: string;
    email: string;
    password_hash: string;
    role: UserRole;
    developer_id: string | null;
    must_change_password: boolean;
    created_at: string;
    deactivated_at: string | null;
}

export interface Session {
    id: string;
    user_id: string;
    created_at: string;
    expires_at: string;
}

/**
 * The authenticated identity attached to a request by the session middleware.
 * `developerId` is the STRICT source of truth for scoping developer-facing
 * endpoints — it comes from the session-linked user, never from a request
 * parameter, so one developer can never read another's data.
 */
export interface AuthContext {
    userId: string;
    email: string;
    role: UserRole;
    developerId: string | null;
    mustChangePassword: boolean;
    sessionId: string;
}
