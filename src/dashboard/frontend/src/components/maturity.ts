import type {BadgeTone} from './Badge';
import type {MaturityBasis} from '../api/types';

/**
 * Presentation helpers for the AI maturity score's honesty labeling (Task
 * 3.12). The score is a git-based *estimate* at launch, and every surface that
 * shows it must say so — a short basis label, the longer basis sentence behind
 * it (mirroring the backend deriveDataBasis copy), and a confidence marker. Kept
 * in one place so the maturity chart and the summaries view never drift on how
 * the same basis reads.
 */

/** Short chip text for a basis — what the line/score is built from. */
export function maturityBasisLabel(basis: MaturityBasis | null): string {
    switch (basis) {
        case 'git_estimate':
            return 'Git-based estimate';
        case 'mixed':
            return 'Git + partial usage';
        case 'measured':
            return 'Measured usage';
        default:
            // Legacy/unknown basis: stay honest rather than implying measurement.
            return 'Estimate';
    }
}

/**
 * The longer "what the number is based on" sentence, surfaced on hover. Mirrors
 * the backend deriveDataBasis copy (src/summaries/input-builder.ts) so the
 * dashboard and the generated narratives describe the same basis identically.
 */
export function maturityBasisDescription(basis: MaturityBasis | null): string {
    switch (basis) {
        case 'git_estimate':
            return 'Based on git analysis and expense data — no direct tool usage is connected yet, so this is an estimate, not a measurement.';
        case 'mixed':
            return 'Based on git analysis, expense data, and partial direct tool usage.';
        case 'measured':
            return 'Based on direct tool usage plus git analysis and expense data.';
        default:
            return 'The basis for this score was not recorded.';
    }
}

/** Confidence tier for a basis. git-only is MEDIUM (inferred, not measured). */
export function maturityConfidence(basis: MaturityBasis | null): {label: string; tone: BadgeTone} {
    switch (basis) {
        case 'measured':
            return {label: 'HIGH confidence', tone: 'success'};
        case 'git_estimate':
        case 'mixed':
        default:
            return {label: 'MEDIUM confidence', tone: 'warning'};
    }
}
