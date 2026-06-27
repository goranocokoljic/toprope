/**
 * Shared local-vs-cloud analyser selection gate for the deep-coaching features
 * (extracted from the Task 5.7 retrospective generator).
 *
 * Both the session retrospective (Task 5.7 / #128) and the private improvement
 * tool (Task 6.5 / #174) make the SAME privacy-critical decision: which analyser
 * runs over a developer's freshly-decrypted session. Local is always available
 * and is the default. Cloud is selected ONLY when BOTH the resolved permission
 * (`cloudAllowed` — org permits cloud analysis AND the developer opted in,
 * opt-in #2) AND a configured cloud analyser are present; either missing is a
 * distinct, named failure so a route can tell "you may not" apart from "this
 * deployment has no cloud model".
 *
 * The gate is the one home for that rule so the two features can't drift on it.
 * It returns a typed result rather than throwing, so each feature can wrap the
 * code in its OWN error type (RetrospectiveError / ImprovementError) and keep its
 * route→HTTP mapping per-feature.
 */

import type {AnalysisLocation} from './retrospective/types';

/** Stable codes for the two ways the cloud gate can refuse a cloud request. */
export type CloudGateErrorCode = 'cloud_not_allowed' | 'cloud_not_configured';

/** A pair of analysers a deployment wires in: a required local default + an optional cloud one. */
export interface AnalyzerPair<A extends {readonly location: AnalysisLocation}> {
    local: A;
    /** Present only when the deployment configured a cloud model; absence is itself a gate. */
    cloud?: A;
}

/** The gate's decision: the chosen analyser, or a typed refusal the caller maps to its error. */
export type GateResult<A> = {analyzer: A} | {error: {code: CloudGateErrorCode; message: string}};

/**
 * Select the analyser for a desired location, enforcing the cloud gate. Inverted
 * so the permissive (cloud) branch is the only explicitly named one and anything
 * that isn't a permitted, configured cloud request falls through to the safe
 * local default — a fail-closed posture: an unknown/garbled location can never
 * pick cloud.
 */
export function selectGatedAnalyzer<A extends {readonly location: AnalysisLocation}>(
    location: AnalysisLocation,
    cloudAllowed: boolean,
    analyzers: AnalyzerPair<A>,
): GateResult<A> {
    if (location === 'cloud') {
        if (!cloudAllowed) {
            return {
                error: {
                    code: 'cloud_not_allowed',
                    message: 'Cloud analysis requires both organization permission and your opt-in (opt-in #2).',
                },
            };
        }
        if (!analyzers.cloud) {
            return {error: {code: 'cloud_not_configured', message: 'No cloud analysis model is configured for this deployment.'}};
        }
        return {analyzer: analyzers.cloud};
    }
    return {analyzer: analyzers.local};
}
