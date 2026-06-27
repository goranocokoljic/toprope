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
import {decryptSessionToText, SessionDecryptError, type DecryptedSession} from '../../capture/session-decrypt';
import {selectGatedAnalyzer} from '../analysisGate';
import {listLoopEventsForSession} from '../realtime/store';
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

/**
 * Decrypt every capture in a session and concatenate the plaintext in chronological
 * order. Delegates to the shared `decryptSessionToText` (the single home for the
 * "blind ciphertext → in-memory plaintext, never persist or log" operation) and
 * re-types its failures as `RetrospectiveError` so the route keeps mapping them to
 * HTTP via its existing `RetrospectiveError` switch. The returned `plaintext` is
 * transient — the caller uses it for analysis and lets it fall out of scope.
 */
function decryptSession(db: Database.Database, developerId: string, sessionId: string, key: Buffer): DecryptedSession {
    try {
        return decryptSessionToText(db, developerId, sessionId, key);
    } catch (err) {
        if (err instanceof SessionDecryptError) {
            throw new RetrospectiveError(err.code, err.message);
        }
        throw err;
    }
}

/**
 * Select the analyser for a desired location via the shared cloud gate
 * (`selectGatedAnalyzer`), re-typing its refusal as a `RetrospectiveError` so this
 * feature keeps its route→HTTP mapping. The gate is fail-closed: anything that
 * isn't a permitted, configured cloud request resolves to the local default.
 */
function selectAnalyzer(
    location: AnalysisLocation,
    cloudAllowed: boolean,
    analyzers: RetrospectiveAnalyzers,
): RetrospectiveAnalyzer {
    const result = selectGatedAnalyzer(location, cloudAllowed, analyzers);
    if ('error' in result) {
        throw new RetrospectiveError(result.error.code, result.error.message);
    }
    return result.analyzer;
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
    const {plaintext, captureCount} = decryptSession(db, input.developerId, input.sessionId, input.key);
    const analysisInput: SessionAnalysisInput = {
        sessionId: input.sessionId,
        plaintext,
        // A stored LoopEvent is a structural superset of the LoopEventMeta the analyser
        // consumes, so the session-scoped rows are passed straight through.
        loopEvents: listLoopEventsForSession(db, input.developerId, input.sessionId),
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
        analyzedCaptureCount: captureCount,
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
    const {plaintext} = decryptSession(db, input.developerId, input.retrospective.sessionId, input.key);
    const analysisInput: SessionAnalysisInput = {
        sessionId: input.retrospective.sessionId,
        plaintext,
        loopEvents: listLoopEventsForSession(db, input.developerId, input.retrospective.sessionId),
    };
    return analyzer.followUp(analysisInput, input.retrospective.retrospectiveText, input.question);
}
