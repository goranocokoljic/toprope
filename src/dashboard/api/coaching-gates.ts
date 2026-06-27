/**
 * Shared route-level privacy gates for the deep-coaching self-service surfaces
 * (extracted from the Task 5.7 retrospective routes).
 *
 * The session retrospective (Task 5.7 / #128) and the private "how could this be
 * better" tool (Task 6.5 / #174) both transiently decrypt a developer's OWN
 * session, so they share the exact same two gates and must enforce them
 * identically:
 *
 *  - CAPTURE ENABLED (opt-in #1): any operation that freshly decrypts plaintext
 *    is inert (403) once the developer has opted out of capture — opting out must
 *    halt new plaintext handling, not just new captures.
 *  - CLOUD ALLOWED (opt-in #2): cloud analysis is permitted only when the org
 *    permits cloud analysis AND the developer opted in; the preference resolver
 *    already forces the opt-in to false when the org forbids it, so a single live
 *    read is the whole gate.
 *
 * Both live here so the two features can't drift on the privacy contract.
 */

import type Database from 'better-sqlite3';
import type {FastifyReply} from 'fastify';
import {captureGate} from '../../capture/gate';
import {resolveDeveloperPreferences} from '../../settings/store';

/** Whether cloud analysis is currently permitted for this developer (org permits AND opted in). */
export function cloudAllowedFor(db: Database.Database, userId: string, team: string | null): boolean {
    return resolveDeveloperPreferences(db, userId, team).cloud_analysis_opt_in?.value === true;
}

/**
 * Enforce the capture opt-in gate (opt-in #1) for operations that TRANSIENTLY
 * decrypt session plaintext. Returns false and sends a 403 (`capture_not_enabled`)
 * when capture is not enabled; true when it is. Owner-scoped reads/deletes of
 * already-stored OUTPUT stay ungated — they touch no plaintext.
 */
export function ensureCaptureEnabled(
    db: Database.Database,
    userId: string,
    team: string | null,
    reply: FastifyReply,
): boolean {
    const gate = captureGate(db, userId, team);
    if (!gate.enabled) {
        reply.status(403).send({
            error: 'Forbidden',
            code: 'capture_not_enabled',
            message: gate.reason ?? 'Prompt capture is not enabled for your account.',
        });
        return false;
    }
    return true;
}
