import type {BadgeTone} from './Badge';
import type {DataQualityTier} from '../api/types';

/**
 * Presentation helpers for a team's data-quality tier (Task 4.9). A tier badge
 * appears beside every compared team so a fully-connected team (high) is never
 * visually equated with a git-only one (medium). Kept in one place so any
 * surface that shows a tier reads it identically.
 *
 * The tiers mirror the platform data-quality model: high = API tool data,
 * medium = git analysis, low = expense-only, none = no data. A team's tier is
 * the weakest best-signal among its data-bearing developers, so `high` means
 * every contributing developer is connected (see compute.ts on the backend).
 */

/** Short chip text for a tier. */
export function tierLabel(tier: DataQualityTier): string {
    switch (tier) {
        case 'high':
            return 'High — API';
        case 'medium':
            return 'Medium — git';
        case 'low':
            return 'Low — expense';
        case 'none':
        default:
            return 'No data';
    }
}

/** Badge tone for a tier — stronger signal reads more confident. */
export function tierTone(tier: DataQualityTier): BadgeTone {
    switch (tier) {
        case 'high':
            return 'success';
        case 'medium':
            return 'warning';
        case 'low':
            return 'danger';
        case 'none':
        default:
            return 'neutral';
    }
}

/** The longer "what this tier means" sentence, surfaced on hover. */
export function tierDescription(tier: DataQualityTier): string {
    switch (tier) {
        case 'high':
            return 'Every contributing developer has direct tool-API usage — the strongest data backing.';
        case 'medium':
            return 'At least one contributing developer is backed only by git analysis, so some metrics are estimated.';
        case 'low':
            return 'At least one contributing developer is backed only by expense data — usage is not measured.';
        case 'none':
        default:
            return 'No data-bearing developers on this team yet.';
    }
}
