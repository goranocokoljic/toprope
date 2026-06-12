/**
 * Shared types for the prompt-capture feature (Task 5.4 / #125).
 */

import {CAPTURE_MECHANISM_OPTIONS} from '../settings/registry';

/** The two capture mechanisms a developer can pick; both write identical rows. */
export type CaptureMechanism = (typeof CAPTURE_MECHANISM_OPTIONS)[number];

export function isCaptureMechanism(value: unknown): value is CaptureMechanism {
    return typeof value === 'string' && (CAPTURE_MECHANISM_OPTIONS as readonly string[]).includes(value);
}

/**
 * The already-encrypted payload an agent/extension submits to the server. By the
 * time it reaches the server it is ALL ciphertext + public meta — there is no
 * plaintext field here by construction, which is the design guarantee that the
 * server never receives, logs, or stores anything it could read.
 */
export interface CaptureIngestInput {
    developerId: string;
    sessionId: string;
    capturedAt: string;
    tool: string | null;
    /** Opaque encrypted bytes (client-side AES-256-GCM). */
    ciphertext: Buffer;
    /** JSON-serializable public crypto descriptor (algo/iv/auth_tag/key_id). */
    encryptionMeta: Record<string, unknown>;
    mechanism: CaptureMechanism;
    promptCount: number | null;
}

/** A stored capture as the owning developer reads it back (metadata + ciphertext). */
export interface PromptCapture {
    id: string;
    developerId: string;
    sessionId: string;
    capturedAt: string;
    tool: string | null;
    /** base64-encoded ciphertext — only the owner ever receives this. */
    ciphertext: string;
    encryptionMeta: Record<string, unknown>;
    mechanism: CaptureMechanism;
    promptCount: number | null;
    createdAt: string;
}

/** A capture's non-sensitive metadata, WITHOUT the ciphertext (listing view). */
export type PromptCaptureSummary = Omit<PromptCapture, 'ciphertext'>;
