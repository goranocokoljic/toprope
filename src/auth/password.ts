import argon2 from 'argon2';
import {randomBytes} from 'crypto';

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Hash a plaintext password with argon2id (memory-hard, the current OWASP
 * recommendation). Returns the encoded hash string (algorithm + params + salt
 * + digest) which is what gets stored in users.password_hash.
 */
export function hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, {type: argon2.argon2id});
}

/**
 * Verify a plaintext password against a stored argon2 hash. Returns false (never
 * throws) on a malformed hash so callers can treat any failure as "wrong
 * password" without leaking detail.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
        return await argon2.verify(hash, plain);
    } catch {
        return false;
    }
}

export interface PasswordValidationResult {
    valid: boolean;
    error?: string;
}

export function validatePasswordStrength(password: string): PasswordValidationResult {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return {valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`};
    }
    return {valid: true};
}

/**
 * Generate a random, URL-safe temporary password for admin-provisioned
 * accounts. The recipient is forced to change it on first login.
 */
export function generateTempPassword(): string {
    return randomBytes(12).toString('base64url');
}
