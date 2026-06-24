import type {ContributionModel} from '../api/types';

/**
 * Model-aware copy for the create/edit entry points (Task 6.2.8 / #163).
 *
 * The browse UI's contribute affordances must "respect the active contribution model":
 * what publishing means differs by the viewer-team's model (6.2.2). Rather than hide or
 * mislabel the action, the entry point explains it — these are the single home for that
 * model-dependent wording, so the list page (contribute banner) and the detail page
 * (edit note) stay consistent.
 *
 *   * top_down  — a lead reviews before anything is published.
 *   * bottom_up — your practice publishes straight into the shared pool.
 *   * hybrid    — publishes into the pool; a lead may endorse the strong ones.
 */

/** A short, human label for a contribution model. */
export function contributionModelLabel(model: ContributionModel): string {
    switch (model) {
        case 'top_down':
            return 'Top-down';
        case 'bottom_up':
            return 'Bottom-up';
        case 'hybrid':
            return 'Hybrid';
    }
}

/** One encouraging sentence explaining what publishing means under the model. */
export function contributionModelExplainer(model: ContributionModel): string {
    switch (model) {
        case 'top_down':
            return 'Your team uses top-down sharing — a lead reviews and approves a practice before it’s published.';
        case 'bottom_up':
            return 'Your team uses bottom-up sharing — your practice publishes straight into the shared pool, where feedback ranks it.';
        case 'hybrid':
            return 'Your team uses hybrid sharing — your practice publishes into the shared pool, and a lead can endorse the strongest ones.';
    }
}
