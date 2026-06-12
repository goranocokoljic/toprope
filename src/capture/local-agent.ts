/**
 * Reference implementation: the LOCAL AGENT capture mechanism (Task 5.4 / #125).
 *
 * A lightweight process on the developer's machine that captures their AI-tool
 * interactions, encrypts them with the developer's key, and uploads the opaque
 * payload to the server. It is deliberately a thin wrapper over the shared
 * CaptureClient with `mechanism` fixed to `local_agent` — the local agent and
 * the editor extension differ ONLY in that field, so both produce identical
 * encrypted rows. Real OS/process hooks are out of scope here; this reference
 * implements the capture→encrypt→send contract that any real agent fulfills.
 */

import {CaptureClient, type CaptureClientConfig, type CaptureTransport} from './client';

/** Fixed mechanism for every capture this agent produces. */
export const LOCAL_AGENT_MECHANISM = 'local_agent' as const;

/**
 * Build a local-agent capture client. Callers supply the developer's key + key
 * id and a transport (typically `httpCaptureTransport` to /api/me/captures); the
 * mechanism is set for them so an agent can never mislabel its captures.
 */
export function createLocalAgent(
    config: Omit<CaptureClientConfig, 'mechanism'>,
    transport: CaptureTransport,
): CaptureClient {
    return new CaptureClient({...config, mechanism: LOCAL_AGENT_MECHANISM}, transport);
}
