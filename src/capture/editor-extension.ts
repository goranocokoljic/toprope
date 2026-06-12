/**
 * Reference implementation: the EDITOR/IDE EXTENSION capture mechanism
 * (Task 5.4 / #125).
 *
 * Same capture→encrypt→send contract as the local agent, delivered via an editor
 * extension instead of a standalone process — some developers won't run a
 * background agent but will install an extension, and vice versa. Like the local
 * agent it is a thin wrapper over the shared CaptureClient with `mechanism` fixed
 * (here to `editor_extension`), so the two mechanisms produce identical encrypted
 * rows that differ only in that field. The editor-specific capture hooks are out
 * of scope; this reference implements the contract any real extension fulfills.
 */

import {CaptureClient, type CaptureClientConfig, type CaptureTransport} from './client';

/** Fixed mechanism for every capture this extension produces. */
export const EDITOR_EXTENSION_MECHANISM = 'editor_extension' as const;

/**
 * Build an editor-extension capture client. Identical surface to the local
 * agent's factory — only the recorded mechanism differs — so a developer can
 * switch mechanisms without any change to how captures are encrypted or stored.
 */
export function createEditorExtension(
    config: Omit<CaptureClientConfig, 'mechanism'>,
    transport: CaptureTransport,
): CaptureClient {
    return new CaptureClient({...config, mechanism: EDITOR_EXTENSION_MECHANISM}, transport);
}
