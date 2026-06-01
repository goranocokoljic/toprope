import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {deleteSessionsForUser} from './sessions';
import type {User, UserRole} from './types';

interface UserRow {
    id: string;
    email: string;
    password_hash: string;
    role: string;
    developer_id: string | null;
    must_change_password: number;
    created_at: string;
    deactivated_at: string | null;
}

function rowToUser(row: UserRow): User {
    return {
        id: row.id,
        email: row.email,
        password_hash: row.password_hash,
        role: row.role as UserRole,
        developer_id: row.developer_id,
        must_change_password: row.must_change_password === 1,
        created_at: row.created_at,
        deactivated_at: row.deactivated_at,
    };
}

// Emails are stored and matched lowercased so logins are case-insensitive and
// the UNIQUE constraint can't be defeated by case variation.
function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export interface CreateUserParams {
    email: string;
    passwordHash: string;
    role: UserRole;
    developerId?: string | null;
    mustChangePassword?: boolean;
}

export function createUser(db: Database.Database, params: CreateUserParams): User {
    const id = randomUUID();
    const now = new Date().toISOString();
    const email = normalizeEmail(params.email);

    db.prepare(
        `INSERT INTO users
         (id, email, password_hash, role, developer_id, must_change_password, created_at, deactivated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
        id,
        email,
        params.passwordHash,
        params.role,
        params.developerId ?? null,
        params.mustChangePassword ? 1 : 0,
        now,
    );

    return {
        id,
        email,
        password_hash: params.passwordHash,
        role: params.role,
        developer_id: params.developerId ?? null,
        must_change_password: params.mustChangePassword ?? false,
        created_at: now,
        deactivated_at: null,
    };
}

/**
 * Look up an active (not deactivated) user by email. Returns null for unknown
 * or deactivated accounts so callers never authenticate a disabled user.
 */
export function getActiveUserByEmail(db: Database.Database, email: string): User | null {
    const row = db
        .prepare('SELECT * FROM users WHERE email = ? AND deactivated_at IS NULL')
        .get(normalizeEmail(email)) as UserRow | undefined;
    return row ? rowToUser(row) : null;
}

export function getUserById(db: Database.Database, id: string): User | null {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
}

/**
 * Replace a user's password hash and clear the must_change_password flag. Used
 * by the change-password flow once a new password has been validated.
 */
export function updatePassword(db: Database.Database, userId: string, passwordHash: string): void {
    db.prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    ).run(passwordHash, userId);
}

export interface UpdateUserParams {
    email?: string;
    role?: UserRole;
    developerId?: string | null;
}

/**
 * Patch a user's email, role, and/or developer link. Only provided keys are
 * written. Emails are normalized; the caller is responsible for handling the
 * UNIQUE-email constraint (a duplicate throws). Returns the updated user, or
 * null if it does not exist.
 */
export function updateUser(db: Database.Database, userId: string, params: UpdateUserParams): User | null {
    const existing = getUserById(db, userId);
    if (!existing) return null;

    const email = params.email !== undefined ? normalizeEmail(params.email) : existing.email;
    const role = params.role ?? existing.role;
    const developerId =
        params.developerId !== undefined ? params.developerId : existing.developer_id;

    db.prepare('UPDATE users SET email = ?, role = ?, developer_id = ? WHERE id = ?').run(
        email,
        role,
        developerId,
        userId,
    );
    return {...existing, email, role, developer_id: developerId};
}

/**
 * Admin-triggered password reset: store a new hash and force a change on next
 * login. Existing sessions are revoked so the old password's sessions can't be
 * used after a reset. Distinct from updatePassword, which CLEARS the
 * must_change_password flag for a user changing their own password.
 */
export function adminResetPassword(db: Database.Database, userId: string, passwordHash: string): boolean {
    const res = db
        .prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
        .run(passwordHash, userId);
    if (res.changes > 0) {
        deleteSessionsForUser(db, userId);
    }
    return res.changes > 0;
}

/** Reactivate a deactivated user. Returns true when a deactivated user was restored. */
export function reactivateUser(db: Database.Database, userId: string): boolean {
    const res = db
        .prepare('UPDATE users SET deactivated_at = NULL WHERE id = ? AND deactivated_at IS NOT NULL')
        .run(userId);
    return res.changes > 0;
}

export function deactivateUser(db: Database.Database, userId: string): boolean {
    const res = db
        .prepare('UPDATE users SET deactivated_at = ? WHERE id = ? AND deactivated_at IS NULL')
        .run(new Date().toISOString(), userId);
    if (res.changes > 0) {
        // Immediately revoke any live sessions so a deactivated user is locked
        // out at once, rather than relying solely on the per-request check.
        deleteSessionsForUser(db, userId);
    }
    return res.changes > 0;
}

export function countAdmins(db: Database.Database): number {
    const row = db
        .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND deactivated_at IS NULL")
        .get() as {cnt: number};
    return row.cnt;
}

export function listUsers(db: Database.Database): User[] {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
    return rows.map(rowToUser);
}
