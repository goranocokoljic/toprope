import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
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

export function deactivateUser(db: Database.Database, userId: string): boolean {
    const res = db
        .prepare('UPDATE users SET deactivated_at = ? WHERE id = ? AND deactivated_at IS NULL')
        .run(new Date().toISOString(), userId);
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
