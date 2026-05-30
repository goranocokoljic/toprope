import {describe, it, expect} from 'vitest';
import {
    hashPassword,
    verifyPassword,
    validatePasswordStrength,
    generateTempPassword,
    MIN_PASSWORD_LENGTH,
} from '../../src/auth/password';

describe('password hashing', () => {
    it('produces an argon2id hash, never plaintext', async () => {
        const hash = await hashPassword('s3cret-password');
        expect(hash).toMatch(/^\$argon2id\$/);
        expect(hash).not.toContain('s3cret-password');
    });

    it('verifies a correct password', async () => {
        const hash = await hashPassword('correct horse battery staple');
        expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    });

    it('rejects an incorrect password', async () => {
        const hash = await hashPassword('correct horse battery staple');
        expect(await verifyPassword(hash, 'wrong password')).toBe(false);
    });

    it('returns false (does not throw) for a malformed hash', async () => {
        expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
    });

    it('produces distinct hashes for the same input (random salt)', async () => {
        const a = await hashPassword('same-input-123');
        const b = await hashPassword('same-input-123');
        expect(a).not.toBe(b);
    });
});

describe('password strength', () => {
    it('rejects passwords below the minimum length', () => {
        const result = validatePasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1));
        expect(result.valid).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('accepts passwords at or above the minimum length', () => {
        expect(validatePasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH)).valid).toBe(true);
    });
});

describe('generateTempPassword', () => {
    it('generates a long, unique, url-safe password', () => {
        const a = generateTempPassword();
        const b = generateTempPassword();
        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
        expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});
