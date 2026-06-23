/**
 * Best-Practice contribution model — the "what a model means" layer (Task 6.2.2 / #157).
 *
 * A team runs best-practice sharing in one of three switchable models. This module
 * owns the pure facts about each model: its name, how it configures the 6.1.2
 * review gate, whether it lead-gates publishing, and whether it uses endorsement —
 * plus resolving the active model for a team from settings. The orchestration that
 * drives the state machine under a model lives in `contributionEngine.ts`; nothing
 * here touches the database except `resolveContributionModel` (a settings read).
 *
 * Switching the model is a settings write, never a schema change — so a team can
 * change model at runtime with no migration (6.2.2 acceptance criterion).
 */

import type Database from 'better-sqlite3';
import {resolveSetting} from '../settings/store';
import {CONTRIBUTION_MODEL_OPTIONS} from '../settings/registry';
import type {ReviewGate} from '../contributions/stateMachine';

/**
 * The three contribution models:
 *   * `top_down` (default) — only leads/curators publish; a submission passes a
 *     lead-approval gate before it is published. Lowest noise.
 *   * `bottom_up` — anyone publishes; submissions auto-publish into a pool that is
 *     ordered by feedback (6.2.4).
 *   * `hybrid` — anyone publishes into a pool; a lead's endorsement elevates the
 *     strong ones (`practice_details.endorsed`).
 */
export type ContributionModel = (typeof CONTRIBUTION_MODEL_OPTIONS)[number];

/** The known contribution models, in declaration order (default first). */
export const CONTRIBUTION_MODELS = CONTRIBUTION_MODEL_OPTIONS;

/** The settings key carrying the active model (global default + per-team override). */
export const CONTRIBUTION_MODEL_SETTING_KEY = 'best_practice_contribution_model';

/** The fallback model when nothing is configured / a stored value is corrupt. */
export const DEFAULT_CONTRIBUTION_MODEL: ContributionModel = 'top_down';

/** Runtime validator — a settings string or route param could be anything. */
export function isContributionModel(value: unknown): value is ContributionModel {
    return typeof value === 'string' && (CONTRIBUTION_MODELS as readonly string[]).includes(value);
}

/**
 * The 6.1.2 review gate a model configures:
 *   * `top_down` → `required-approval` (a lead must approve before publish), so a
 *     non-lead submission cannot reach `published` on its own.
 *   * `bottom_up` / `hybrid` → `auto-publish` (submitting carries straight to
 *     published; quality is sorted out afterwards by feedback / endorsement).
 */
export function gateForModel(model: ContributionModel): ReviewGate {
    return model === 'top_down' ? 'required-approval' : 'auto-publish';
}

/**
 * Whether the model restricts publishing to leads/curators. Only `top_down` does:
 * this is the "non-leads cannot publish" rule the engine enforces before it ever
 * touches the state machine, so a non-lead is rejected on authority rather than
 * incidentally on the unsatisfied approval gate.
 */
export function modelRequiresLeadToPublish(model: ContributionModel): boolean {
    return model === 'top_down';
}

/**
 * Whether the model uses lead endorsement as its elevation lever. Only `hybrid`
 * does — endorsement is meaningless under `top_down` (leads already curate what is
 * published) and under `bottom_up` (the pool is ranked purely by feedback).
 */
export function modelUsesEndorsement(model: ContributionModel): boolean {
    return model === 'hybrid';
}

/**
 * The active contribution model for a team (or the global default when `team` is
 * omitted). Reads the setting through the standard team-override-aware resolver,
 * then re-validates: a stored value outside the known set (registry drift, a
 * hand-edited row) falls back to {@link DEFAULT_CONTRIBUTION_MODEL} with a warning
 * rather than letting an unknown string flow into the engine as a model. Because
 * the value comes from settings, a per-team change takes effect immediately on the
 * next read — no migration, no restart.
 */
export function resolveContributionModel(db: Database.Database, team?: string | null): ContributionModel {
    const raw = resolveSetting(db, CONTRIBUTION_MODEL_SETTING_KEY, team);
    if (isContributionModel(raw)) {
        return raw;
    }
    console.warn(
        `[practices] unrecognized contribution model '${String(raw)}'; falling back to ${DEFAULT_CONTRIBUTION_MODEL}`,
    );
    return DEFAULT_CONTRIBUTION_MODEL;
}
