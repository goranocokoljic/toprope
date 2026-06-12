/**
 * The shared capture client (Task 5.4 / #125) — the CLIENT half of the pipeline.
 *
 * Both reference mechanisms (the local agent and the editor extension) are thin
 * wrappers over this one client. That is the whole point of the design: capture
 * → encrypt (client-side) → send is identical regardless of mechanism, so both
 * paths produce identical `prompt_captures` rows that differ only in the
 * `mechanism` field. Encryption happens HERE, on the developer's machine, with
 * the developer's key — so the payload that leaves the client is already opaque
 * ciphertext and the server never receives plaintext.
 *
 * The transport is injected so the encryption/serialization logic is testable in
 * isolation and a deployment can choose how payloads reach the server (the
 * provided `httpCaptureTransport` POSTs JSON; a test can substitute anything).
 */

import {encryptCapture, type EncryptionMeta} from './encryption';
import type {CaptureMechanism} from './types';
import type {CoachResult, RealtimeCoach} from '../coaching/realtime/coach';

/** The exact JSON body the ingestion route accepts. All ciphertext, no plaintext. */
export interface CaptureWirePayload {
    session_id: string;
    captured_at: string;
    tool?: string;
    /** base64-encoded ciphertext. */
    ciphertext: string;
    encryption_meta: EncryptionMeta;
    mechanism: CaptureMechanism;
    prompt_count?: number;
}

/** A captured session as the client sees it BEFORE encryption (plaintext stays local). */
export interface CaptureInput {
    sessionId: string;
    /** The raw captured prompts/responses — encrypted here and never transmitted as-is. */
    plaintext: string;
    /** When the interaction happened; defaults to now. */
    capturedAt?: string;
    tool?: string | null;
    promptCount?: number | null;
}

export interface CaptureClientConfig {
    /** The developer's AES-256 key (32 bytes). Never leaves the client. */
    key: Buffer;
    /** Reference id for the key (stored in meta; managed in Task 5.5). */
    keyId: string;
    mechanism: CaptureMechanism;
    /**
     * Optional local real-time coach (Task 5.6). When present, the client can run
     * loop detection + structural nudges on an outgoing prompt via `observe`,
     * entirely on the machine — the prompt is consumed locally for coaching and is
     * never placed on the (already client-side) coach's metadata output. Both
     * capture mechanisms wrap this one client, so attaching the coach here is what
     * makes loop detection run at the capture layer for the agent AND the extension.
     */
    coach?: RealtimeCoach;
}

/**
 * Encrypt a capture client-side and build the wire payload the server ingests.
 * Pure (no I/O): the local agent, the editor extension, and tests all use this
 * to produce a payload that is guaranteed to carry only ciphertext + public meta.
 */
export function buildCapturePayload(config: CaptureClientConfig, input: CaptureInput): CaptureWirePayload {
    const {ciphertext, meta} = encryptCapture(input.plaintext, config.key, config.keyId);
    const payload: CaptureWirePayload = {
        session_id: input.sessionId,
        captured_at: input.capturedAt ?? new Date().toISOString(),
        ciphertext: ciphertext.toString('base64'),
        encryption_meta: meta,
        mechanism: config.mechanism,
    };
    if (input.tool != null) {
        payload.tool = input.tool;
    }
    if (input.promptCount != null) {
        payload.prompt_count = input.promptCount;
    }
    return payload;
}

/** Delivers an (already-encrypted) payload to the server. Injected for testability. */
export type CaptureTransport = (payload: CaptureWirePayload) => Promise<void>;

/**
 * The capture client a mechanism instantiates. `capture` encrypts client-side
 * and hands the resulting opaque payload to the transport, returning it so a
 * caller (or test) can inspect exactly what was sent.
 */
export class CaptureClient {
    constructor(
        private readonly config: CaptureClientConfig,
        private readonly transport: CaptureTransport,
    ) {}

    async capture(input: CaptureInput): Promise<CaptureWirePayload> {
        const payload = buildCapturePayload(this.config, input);
        await this.transport(payload);
        return payload;
    }

    /**
     * Run the attached local coach on one outgoing prompt (Task 5.6). Pure-local:
     * the prompt is observed on the machine and only the returned CoachResult
     * METADATA (counts/types/timestamps) is ever suitable to sync — the prompt
     * text never leaves here. Returns null when no coach is attached, so a caller
     * that didn't opt into coaching pays nothing.
     */
    observe(prompt: string): CoachResult | null {
        return this.config.coach ? this.config.coach.observePrompt(prompt) : null;
    }
}

/**
 * An HTTP transport that POSTs the encrypted payload to the capture endpoint with
 * the developer's session/API token. `fetchImpl` defaults to the global fetch so
 * it works on modern Node and can be substituted in tests. A non-2xx response
 * throws so the agent/extension can surface (and retry) a failed send.
 */
export function httpCaptureTransport(opts: {
    endpoint: string;
    token: string;
    fetchImpl?: typeof fetch;
}): CaptureTransport {
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
        throw new Error('No fetch implementation available; pass fetchImpl to httpCaptureTransport');
    }
    return async (payload: CaptureWirePayload): Promise<void> => {
        const res = await doFetch(opts.endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${opts.token}`,
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(`Capture upload failed: HTTP ${res.status}`);
        }
    };
}
