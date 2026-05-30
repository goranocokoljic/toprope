import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    createUser,
    getActiveUserByEmail,
    getUserById,
    updatePassword,
    deactivateUser,
    countAdmins,
} from '../../src/auth/users';

describe('users store', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
    });

    it('creates and looks up a user case-insensitively by email', () => {
        createUser(db, {email: 'Admin@Test.com', passwordHash: 'h', role: 'admin'});
        const found = getActiveUserByEmail(db, 'admin@test.com');
        expect(found?.email).toBe('admin@test.com');
        expect(found?.role).toBe('admin');
    });

    it('rejects a duplicate email regardless of case', () => {
        createUser(db, {email: 'dup@test.com', passwordHash: 'h', role: 'admin'});
        expect(() => createUser(db, {email: 'DUP@test.com', passwordHash: 'h', role: 'admin'})).toThrow();
    });

    it('does not return deactivated users from the active lookup', () => {
        const user = createUser(db, {email: 'gone@test.com', passwordHash: 'h', role: 'admin'});
        expect(deactivateUser(db, user.id)).toBe(true);
        expect(getActiveUserByEmail(db, 'gone@test.com')).toBeNull();
        // ...but still retrievable by id (for audit / FK integrity).
        expect(getUserById(db, user.id)?.deactivated_at).toBeTruthy();
    });

    it('updatePassword clears the must_change_password flag', () => {
        const user = createUser(db, {
            email: 'change@test.com',
            passwordHash: 'old',
            role: 'admin',
            mustChangePassword: true,
        });
        updatePassword(db, user.id, 'newhash');
        const after = getUserById(db, user.id);
        expect(after?.password_hash).toBe('newhash');
        expect(after?.must_change_password).toBe(false);
    });

    it('counts only active admins', () => {
        createUser(db, {email: 'a1@test.com', passwordHash: 'h', role: 'admin'});
        const a2 = createUser(db, {email: 'a2@test.com', passwordHash: 'h', role: 'admin'});
        createUser(db, {email: 'd1@test.com', passwordHash: 'h', role: 'developer'});
        expect(countAdmins(db)).toBe(2);
        deactivateUser(db, a2.id);
        expect(countAdmins(db)).toBe(1);
    });
});
