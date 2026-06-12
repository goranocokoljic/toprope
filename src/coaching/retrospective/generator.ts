/**
 * Session-retrospective generator (Task 5.7 / #128): transient decrypt → analyze
 * → store OUTPUT.
 *
 * This is the one place the deep-coaching privacy contract is operationalised:
 *
 *   1. The developer's key arrives transiently (the route accepts it for this one
 *      operation; it is never stored). Captures are the server's blind ciphertext;
 *      decryption happens HERE, in memory, producing plaintext that lives only as
 *      a local variable for the duration of the call.
 *   2. Analysis runs on that plaintext. DEFAULT is a LOCAL analyser — the raw
 *      prompts never leave org infrastructure. A CLOUD analyser is selected ONLY
 *      when the org permits cloud analysis AND the developer opted in (opt-in #2);
 *      the caller resolves that gate and passes `cloudAllowed`.
 *   3. Only the analysis OUTPUT (narrative + highlights + where it ran) is
 *      persisted. The key and the plaintext are NEVER written to the DB and NEVER
 *      logged — there is deliberately no console/logger call in this module that
 *      touches either.
 *
 * Follow-up ("why was this flagged?") re-runs the same transient-decrypt against
 * the same session and answers with the SAME location the retrospective used, so a
 * conversational turn can never widen the privacy boundary the developer consented
 * to.
 */

import type Database from 'better-sqlite3';
import {decryptCapture, type EncryptionMeta} from '../../capture/encryption';
import {listSessionCapturesForDeveloper} from '../../capture/store';
import {listLoopEventsForSession} from '../realtime/store';
import type {LoopEventMeta} from '../realtime/types';
import type {RetrospectiveAnalyzer, SessionAnalysisInput} from './analyzer';
import {insertRetrospective} from './store';
import type {AnalysisLocation, Retrospective} from './types';

/** Stable error codes the route maps to HTTP statuses without string-matching messages. */
export type RetrospectiveErrorCode =
    | 'no_captures'
    | 'cloud_not_allowed'
    | 'cloud_not_configured'
    | 'decrypt_failed';

/** A typed failure from generation/follow-up, carrying a code the route can switch on. */
export class RetrospectiveError extends Error {
    constructor(
        readonly code: RetrospectiveErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'RetrospectiveError';
    }
}

/** The analysers a deployment wires in: a required local default + an optional cloud one. */
export interface RetrospectiveAnalyzers {
    local: RetrospectiveAnalyzer;
    /** Present only when the deployment configured a cloud model; absence is itself a gate. */
    cloud?: RetrospectiveAnalyzer;
}

export interface GenerateRetrospectiveInput {
    developerId: string;
    sessionId: string;
    /** The developer's AES-256 key, supplied transiently for this operation only. */
    key: Buffer;
    /** What the developer asked for; defaults to 'local'. Honored only within the gate. */
    requestedLocation: AnalysisLocation;
    /** True only when the org permits cloud analysis AND the developer opted in (opt-in #2). */
    cloudAllowed: boolean;
    analyzers: RetrospectiveAnalyzers;
}

export interface FollowUpInput {
    developerId: string;
    /** The retrospective being asked about (carries the location to stay within). */
    retrospective: Retrospective;
    /** The developer's key, again supplied transiently to re-decrypt the session. */
    key: Buffer;
    question: string;
    /** Re-resolved at follow-up time: a cloud retrospective can only continue while still permitted. */
    cloudAllowed: boolean;
    analyzers: RetrospectiveAnalyzers;
}

/** Coerce a stored public meta object into the EncryptionMeta decryptCapture needs. */
function toEncryptionMeta(meta: Record<string, unknown>): EncryptionMeta {
    const {algo, iv, auth_tag, key_id} = meta;
    if (
        typeof algo !== 'string' ||
        typeof iv !== 'string' ||
        typeof auth_tag !== 'string' ||
        typeof key_id !== 'string'
    ) {
        throw new RetrospectiveError('decrypt_failed', 'Capture encryption metadata is malformed');
    }
    return {algo, iv, auth_tag, key_id};
}

/**
 * Decrypt every capture in a session and concatenate the plaintext in chronological
 * order. The returned string is transient — the caller uses it for analysis and
 * lets it fall out of scope; it is never persisted or logged. A wrong key (or any
 * tampering) makes GCM verification throw, surfaced as a typed `decrypt_failed`.
 */
function decryptSession(db: Database.Database, developerId: string, sessionId: string, key: Buffer): string {
    const captures = listSessionCapturesForDeveloper(db, developerId, sessionId);
    if (captures.length === 0) {
        throw new RetrospectiveError('no_captures', 'No captured session found to analyze');
    }
    const parts: string[] = [];
    for (const capture of captures) {
        const meta = toEncryptionMeta(capture.encryptionMeta);
        const ciphertext = Buffer.from(capture.ciphertext, 'base64');
        try {
            parts.push(decryptCapture(ciphertext, meta, key));
        } catch {
            // Never include the underlying crypto error detail or any bytes — just the
            // typed code. A bad key and a tampered blob are intentionally indistinguishable.
            throw new RetrospectiveError('decrypt_failed', 'Could not decrypt the session with the provided key');
        }
    }
    return parts.join('\n');
}

/**
 * The session's loop metadata (Task 5.6) — counts only, no content. A stored
 * LoopEvent is a structural superset of the LoopEventMeta the analyser consumes,
 * so the session-scoped rows are passed straight through (no re-mapping needed).
 */
function loopEventsForSession(db: Database.Database, developerId: string, sessionId: string): LoopEventMeta[] {
    return listLoopEventsForSession(db, developerId, sessionId);
}

/**
 * Select the analyser for a desired location, enforcing the cloud gate. Local is
 * always available. Cloud requires BOTH the resolved permission (`cloudAllowed`)
 * AND a configured cloud analyser; either missing is a distinct, typed failure so
 * the route can tell "you may not" apart from "this deployment has no cloud model".
 */
function selectAnalyzer(
    location: AnalysisLocation,
    cloudAllowed: boolean,
    analyzers: RetrospectiveAnalyzers,
): RetrospectiveAnalyzer {
    if (location === 'cloud') {
        if (!cloudAllowed) {
            throw new RetrospectiveError(
                'cloud_not_allowed',
                'Cloud analysis requires both organization permission and your opt-in (opt-in #2).',
            );
        }
        if (!analyzers.cloud) {
            throw new RetrospectiveError('cloud_not_configured', 'No cloud analysis model is configured for this deployment.');
        }
        return analyzers.cloud;
    }
    return analyzers.local;
}

/**
 * Generate a retrospective for one captured session. Decrypts transiently, runs
 * the gated analyser, and persists ONLY the output. Returns the stored
 * retrospective (which records `analysis_location` so the developer can see where
 * analysis ran).
 */
export async function generateRetrospective(
    db: Database.Database,
    input: GenerateRetrospectiveInput,
): Promise<Retrospective> {
    const analyzer = selectAnalyzer(input.requestedLocation, input.cloudAllowed, input.analyzers);
    // Decrypt only AFTER the gate passes, so a forbidden cloud request never even
    // produces plaintext in memory.
    const plaintext = decryptSession(db, input.developerId, input.sessionId, input.key);
    const analysisInput: SessionAnalysisInput = {
        sessionId: input.sessionId,
        plaintext,
        loopEvents: loopEventsForSession(db, input.developerId, input.sessionId),
    };
    const result = await analyzer.analyze(analysisInput);
    return insertRetrospective(db, {
        developerId: input.developerId,
        sessionId: input.sessionId,
        generatedAt: new Date().toISOString(),
        analysisModel: analyzer.model,
        analysisLocation: analyzer.location,
        retrospectiveText: result.retrospectiveText,
        highlights: result.highlights,
    });
}

/**
 * Answer a developer's conversational follow-up about their OWN retrospective.
 * Re-decrypts the same session transiently and answers using the SAME location the
 * retrospective was generated at — so a follow-up never sends prompts somewhere the
 * original run didn't. A cloud retrospective additionally re-checks `cloudAllowed`,
 * so a revoked permission (org turned cloud off, or the developer opted out) stops
 * further cloud turns. The answer is conversational and intentionally NOT persisted.
 */
export async function answerFollowUp(db: Database.Database, input: FollowUpInput): Promise<string> {
    const analyzer = selectAnalyzer(input.retrospective.analysisLocation, input.cloudAllowed, input.analyzers);
    const plaintext = decryptSession(db, input.developerId, input.retrospective.sessionId, input.key);
    const analysisInput: SessionAnalysisInput = {
        sessionId: input.retrospective.sessionId,
        plaintext,
        loopEvents: loopEventsForSession(db, input.developerId, input.retrospective.sessionId),
    };
    return analyzer.followUp(analysisInput, input.retrospective.retrospectiveText, input.question);
}
