/**
 * Improvement-review generator for the private "How Could This Be Better" tool
 * (Task 6.5 / #174): transient decrypt → gated analyze → store OUTPUT.
 *
 * This operationalises the same privacy contract as the Phase 5 retrospective,
 * reusing its shared primitives rather than re-implementing them:
 *
 *   1. The developer's key arrives transiently (the route accepts it for this one
 *      operation; it is never stored). Captures are the server's blind ciphertext;
 *      decryption happens HERE, in memory (via the shared `decryptSessionToText`),
 *      producing plaintext that lives only as a local variable for the call.
 *   2. Analysis runs on that plaintext. DEFAULT is a LOCAL analyser — the raw
 *      prompts never leave org infrastructure. A CLOUD analyser is selected ONLY
 *      under the Phase 5 double-opt-in, enforced by the shared `selectGatedAnalyzer`
 *      gate; the caller resolves the live permission and passes `cloudAllowed`.
 *   3. Only the analysis OUTPUT (narrative + suggestions + where it ran) is
 *      persisted. The key and the plaintext are NEVER written to the DB and NEVER
 *      logged — there is deliberately no console/logger call in this module that
 *      touches either.
 *
 * There is NO publish path and NO manager path anywhere in this module: an
 * improvement review is private to the developer, full stop.
 */

import type Database from 'better-sqlite3';
import {decryptSessionToText, SessionDecryptError} from '../../capture/session-decrypt';
import {selectGatedAnalyzer, type AnalyzerPair} from '../analysisGate';
import {listLoopEventsForSession} from '../realtime/store';
import type {ImprovementAnalyzer, SessionAnalysisInput} from './analyzer';
import {insertImprovementReview} from './store';
import type {AnalysisLocation, ImprovementReview} from './types';

/** Stable error codes the route maps to HTTP statuses without string-matching messages. */
export type ImprovementErrorCode =
    | 'no_captures'
    | 'cloud_not_allowed'
    | 'cloud_not_configured'
    | 'decrypt_failed';

/** A typed failure from generation, carrying a code the route can switch on. */
export class ImprovementError extends Error {
    constructor(
        readonly code: ImprovementErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ImprovementError';
    }
}

/** The analysers a deployment wires in: a required local default + an optional cloud one. */
export type ImprovementAnalyzers = AnalyzerPair<ImprovementAnalyzer>;

export interface GenerateImprovementInput {
    developerId: string;
    sessionId: string;
    /** The developer's AES-256 key, supplied transiently for this operation only. */
    key: Buffer;
    /** What the developer asked for; defaults to 'local'. Honored only within the gate. */
    requestedLocation: AnalysisLocation;
    /** True only when the org permits cloud analysis AND the developer opted in (opt-in #2). */
    cloudAllowed: boolean;
    analyzers: ImprovementAnalyzers;
}

/**
 * Select the analyser for a desired location via the shared cloud gate, re-typing
 * its refusal as an `ImprovementError` so this feature keeps its route→HTTP
 * mapping. Fail-closed: anything that isn't a permitted, configured cloud request
 * resolves to the local default.
 */
function selectAnalyzer(
    location: AnalysisLocation,
    cloudAllowed: boolean,
    analyzers: ImprovementAnalyzers,
): ImprovementAnalyzer {
    const result = selectGatedAnalyzer(location, cloudAllowed, analyzers);
    if ('error' in result) {
        throw new ImprovementError(result.error.code, result.error.message);
    }
    return result.analyzer;
}

/**
 * Generate an improvement review for one of the developer's OWN captured
 * conversations. Decrypts transiently, runs the gated analyser, and persists ONLY
 * the output. Returns the stored review (which records `analysis_location` so the
 * developer can always see where analysis ran).
 */
export async function generateImprovementReview(
    db: Database.Database,
    input: GenerateImprovementInput,
): Promise<ImprovementReview> {
    const analyzer = selectAnalyzer(input.requestedLocation, input.cloudAllowed, input.analyzers);
    // Decrypt only AFTER the gate passes, so a forbidden cloud request never even
    // produces plaintext in memory.
    let plaintext: string;
    let captureCount: number;
    try {
        const decrypted = decryptSessionToText(db, input.developerId, input.sessionId, input.key);
        plaintext = decrypted.plaintext;
        captureCount = decrypted.captureCount;
    } catch (err) {
        if (err instanceof SessionDecryptError) {
            throw new ImprovementError(err.code, err.message);
        }
        throw err;
    }

    const analysisInput: SessionAnalysisInput = {
        sessionId: input.sessionId,
        plaintext,
        // A stored LoopEvent is a structural superset of the LoopEventMeta the analyser
        // consumes, so the session-scoped rows are passed straight through.
        loopEvents: listLoopEventsForSession(db, input.developerId, input.sessionId),
    };
    const result = await analyzer.analyze(analysisInput);
    return insertImprovementReview(db, {
        developerId: input.developerId,
        sessionId: input.sessionId,
        generatedAt: new Date().toISOString(),
        analysisModel: analyzer.model,
        analysisLocation: analyzer.location,
        reviewText: result.reviewText,
        suggestions: result.suggestions,
        analyzedCaptureCount: captureCount,
    });
}
