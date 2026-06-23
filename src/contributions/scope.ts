/**
 * Org/Team inheritance + scope resolution for the contribution spine (Task 6.1.4 / #154).
 *
 * The feature-agnostic primitive that answers "given a viewer (their team) and a
 * set of contributions, what may they see?". It owns exactly the visibility model
 * the spine store (6.1.1) deliberately leaves as raw `scope`/`scope_target`
 * columns, and nothing the state machine (6.1.2) or versioning (6.1.3) own:
 *
 *   * org-scoped content  → visible to ALL teams,
 *   * team-scoped content → visible ONLY to that team,
 *   * a team may HIDE an org item for itself (a per-team override), permission-gated.
 *
 * Consistent with the Phase 2 settings inheritance pattern (src/settings/store.ts):
 * an org item is the org-level default visible everywhere; a per-team hide is the
 * analog of a `settings` team override row, and — exactly like a settings override —
 * it is only HONORED while the governing permission is on. When hiding is not
 * permitted, stored hides are ignored and the org item is visible again, mirroring
 * `resolveSetting` refusing to honor an override whose managers_can_* flag is off.
 *
 * Decoupling: like the state machine taking its review `gate` as a parameter rather
 * than reading the settings registry, this module takes the hide PERMISSION as a
 * parameter (`permitted` on the mutations, `hidesPermitted` on the DB-backed
 * resolver). A consuming feature (6.2/6.3) resolves the relevant org setting for the
 * team and passes the boolean in, so no settings- or feature-specific logic leaks
 * into the spine.
 *
 * Scope vs lifecycle: this resolver filters on SCOPE only — it is orthogonal to
 * lifecycle `state`. A browse surface that should show only `published` items
 * composes a state filter (via the store's `ContributionFilters`) with this scope
 * resolution; the DB-backed `listVisibleForViewer` accepts those filters so the two
 * compose in one call.
 *
 * Concurrency: like the rest of the spine this assumes a single writer.
 * better-sqlite3 is synchronous and single-threaded, so a hide's existence check
 * and its insert cannot interleave within one process; the write is wrapped in a
 * transaction so the hide row and its audit event land together or not at all.
 */

import type Database from 'better-sqlite3';
import {addReviewEvent, getContribution, listContributions} from './store';
import type {Contribution, ContributionFilters, ContributionScope} from './types';

/**
 * The minimal shape the visibility rule needs: a contribution's id and its scope.
 * Typed structurally (not as the full {@link Contribution}) so the pure resolvers
 * work on anything carrying scope — a spine row, or a feature row that has joined
 * the scope columns in — keeping the primitive genuinely feature-agnostic.
 */
export interface ScopedContribution {
    id: string;
    scope: ContributionScope;
    /** The team name when team-scoped; null for org-wide. */
    scopeTarget: string | null;
}

function nowIso(): string {
    return new Date().toISOString();
}

// --- Pure visibility rule ----------------------------------------------------

/**
 * Whether a single contribution is visible to a viewer on the given team, BEFORE
 * any per-team hide is applied. The core scope rule, in one place:
 *
 *   * `org`  → visible to everyone (every team, and a viewer with no team);
 *   * `team` → visible only when the viewer's team equals the contribution's
 *     `scopeTarget`. A viewer with no team (null/undefined) therefore sees no
 *     team-scoped content at all.
 *
 * A `team`-scoped row whose `scopeTarget` is null (a malformed row that should not
 * exist) is visible to NO ONE — fail-closed, never broadened to org-wide.
 */
export function isInViewerScope(
    contribution: ScopedContribution,
    viewerTeam: string | null | undefined,
): boolean {
    if (contribution.scope === 'org') {
        return true;
    }
    // team-scoped: only the target team sees it (and only when both sides are a
    // real, equal team — a null target or a teamless viewer can never match).
    return contribution.scopeTarget !== null && viewerTeam != null && contribution.scopeTarget === viewerTeam;
}

/**
 * Whether a contribution is visible to a viewer, accounting for per-team hides.
 * Extends {@link isInViewerScope} with the override step: an org item the viewer's
 * team has hidden (its id is in `hiddenIds`) is not visible to that viewer, while
 * remaining visible to every other team. Hides only ever apply to org items, so a
 * team-scoped row is unaffected even if its id somehow appears in the set.
 *
 * `hiddenIds` is the set of contribution ids hidden FOR THE VIEWER'S TEAM. The
 * caller decides what it contains: pass an empty set (the default) to ignore hides
 * entirely — which is how a "hiding not permitted" policy is expressed, mirroring
 * the settings resolver ignoring an override when its flag is off.
 */
export function isVisibleToViewer(
    contribution: ScopedContribution,
    viewerTeam: string | null | undefined,
    hiddenIds: ReadonlySet<string> = new Set(),
): boolean {
    if (!isInViewerScope(contribution, viewerTeam)) {
        return false;
    }
    // Per-team hide only overrides org items; a team item is never "hidden" this way.
    if (contribution.scope === 'org' && hiddenIds.has(contribution.id)) {
        return false;
    }
    return true;
}

/**
 * THE resolution helper: given a viewer's team and a set of contributions, return
 * the subset they may see, preserving the input order. Pure — no DB access — so it
 * can resolve any candidate list (a store query, a feature-joined query, an
 * in-memory set) the same way. Applies the scope rule and subtracts per-team hides
 * (see {@link isVisibleToViewer}). Pass `hiddenIds` empty (the default) when hiding
 * is not permitted so stored hides are not honored.
 */
export function resolveVisible<T extends ScopedContribution>(
    candidates: readonly T[],
    viewerTeam: string | null | undefined,
    hiddenIds: ReadonlySet<string> = new Set(),
): T[] {
    return candidates.filter((c) => isVisibleToViewer(c, viewerTeam, hiddenIds));
}

// --- Per-team hide store -----------------------------------------------------

interface HideRow {
    contribution_id: string;
    team: string;
    hidden_by: string;
    hidden_at: string;
}

/** A recorded per-team hide of an org contribution. */
export interface TeamHide {
    contributionId: string;
    team: string;
    hiddenBy: string;
    hiddenAt: string;
}

function rowToHide(row: HideRow): TeamHide {
    return {
        contributionId: row.contribution_id,
        team: row.team,
        hiddenBy: row.hidden_by,
        hiddenAt: row.hidden_at,
    };
}

/**
 * The ids of org contributions a team has hidden for itself, as a Set for O(1)
 * membership in {@link resolveVisible}. This is the raw stored state, independent
 * of whether hiding is currently permitted — the permission gate is applied by the
 * caller (or by {@link listVisibleForViewer}), exactly as the settings store reads
 * a raw override separately from deciding whether to honor it.
 *
 * Self-defending: the query joins back to `contributions.scope = 'org'` so the set
 * only ever contains ORG contribution ids — the same invariant the write path
 * enforces (only org items can be hidden, see {@link requireHidableOrgItem}). The
 * pure resolver re-checks org-scope before subtracting a hide too, but constraining
 * it here means a direct consumer of this accessor cannot mistakenly treat a stray
 * team-row hide as meaningful: the privacy-relevant rule does not hinge on a single
 * downstream `&&`.
 */
export function getHiddenContributionIdsForTeam(db: Database.Database, team: string): Set<string> {
    const rows = db
        .prepare(
            `SELECT h.contribution_id
             FROM contribution_team_hides h
             JOIN contributions c ON c.id = h.contribution_id AND c.scope = 'org'
             WHERE h.team = ?`,
        )
        .all(team) as {contribution_id: string}[];
    return new Set(rows.map((r) => r.contribution_id));
}

/** Whether a specific contribution is hidden for a specific team (raw, pre-permission). */
export function isHiddenForTeam(db: Database.Database, contributionId: string, team: string): boolean {
    const row = db
        .prepare('SELECT 1 AS x FROM contribution_team_hides WHERE contribution_id = ? AND team = ?')
        .get(contributionId, team) as {x: number} | undefined;
    return row !== undefined;
}

/** Every per-team hide recorded for a contribution (across teams), newest first. */
export function listHidesForContribution(db: Database.Database, contributionId: string): TeamHide[] {
    const rows = db
        .prepare(
            'SELECT * FROM contribution_team_hides WHERE contribution_id = ? ORDER BY hidden_at DESC, team ASC',
        )
        .all(contributionId) as HideRow[];
    return rows.map(rowToHide);
}

// --- Hide / unhide mutations -------------------------------------------------

/** Stable error codes the caller (route/service) can switch on without matching message text. */
export type ScopeErrorCode = 'not_found' | 'not_org_scoped' | 'not_permitted' | 'invalid_actor' | 'invalid_team';

/** A typed failure from the scope-resolution engine, carrying a code the caller maps to an HTTP status. */
export class ScopeError extends Error {
    constructor(
        readonly code: ScopeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ScopeError';
    }
}

/** Fields needed to hide (or un-hide) an org contribution for one team. */
export interface HideInput {
    contributionId: string;
    /** The team hiding the org item for itself. */
    team: string;
    /** The acting user — recorded on the hide row and the audit event. */
    actorId: string;
    /** Optional human note attached to the audit event. */
    note?: string | null;
    /** UTC ISO timestamp for the hide row and its audit event; defaults to now. */
    timestamp?: string;
}

/**
 * Reject a missing or blank actor. The hide's `hidden_by` and the audit event's
 * actor are only as real as the id handed in; a whitespace-only id would satisfy
 * the NOT NULL column yet leave an anonymous governance action, so enforce a
 * non-blank actor here (mirroring the state machine / versioning `requireActor`).
 */
function requireActor(actorId: string): void {
    if (actorId.trim() === '') {
        throw new ScopeError('invalid_actor', 'A non-empty actorId is required to hide or un-hide an item.');
    }
}

/** Reject a missing or blank team — a hide is meaningless without the team it scopes to. */
function requireTeam(team: string): void {
    if (team.trim() === '') {
        throw new ScopeError('invalid_team', 'A non-empty team is required to hide or un-hide an item.');
    }
}

/**
 * Load the contribution and assert it is an ORG item — the only thing a per-team
 * hide may target. Returns the contribution so callers don't re-read. Throws
 * `not_found` when it does not exist, `not_org_scoped` when it is team-scoped (a
 * team item is already confined to its team; there is nothing to override).
 */
function requireHidableOrgItem(db: Database.Database, contributionId: string): Contribution {
    const contribution = getContribution(db, contributionId);
    if (!contribution) {
        throw new ScopeError('not_found', `Contribution '${contributionId}' not found.`);
    }
    if (contribution.scope !== 'org') {
        throw new ScopeError(
            'not_org_scoped',
            `Contribution '${contributionId}' is team-scoped; only org items can be hidden per team.`,
        );
    }
    return contribution;
}

/**
 * Hide an org contribution for one team — a per-team visibility override.
 * PERMISSION-GATED: `permitted` must be true (the feature resolves the governing
 * org setting for the team and passes the boolean), else this is refused with
 * `not_permitted` and nothing is written. Mirrors the state machine taking its
 * review gate as a parameter rather than reading settings in the spine.
 *
 * Idempotent: hiding an item the team has already hidden is a no-op that returns
 * `false` (no duplicate row, no second audit event); a newly recorded hide returns
 * `true` and appends a `hidden` event to the contribution's audit trail (the
 * cross-cutting "every governance action is recorded" criterion). The row and the
 * audit event are written in one transaction so they can never diverge.
 *
 * Throws `invalid_actor`/`invalid_team` for blank inputs, `not_found` when the
 * contribution does not exist, `not_org_scoped` when it is team-scoped.
 */
export function hideOrgItemForTeam(db: Database.Database, input: HideInput & {permitted: boolean}): boolean {
    requireActor(input.actorId);
    requireTeam(input.team);
    if (!input.permitted) {
        throw new ScopeError(
            'not_permitted',
            `Team '${input.team}' is not permitted to hide org items.`,
        );
    }
    requireHidableOrgItem(db, input.contributionId);
    const ts = input.timestamp ?? nowIso();

    return db.transaction((): boolean => {
        const res = db
            .prepare(
                `INSERT OR IGNORE INTO contribution_team_hides (contribution_id, team, hidden_by, hidden_at)
                 VALUES (?, ?, ?, ?)`,
            )
            .run(input.contributionId, input.team, input.actorId, ts);
        if (res.changes === 0) {
            // Already hidden — idempotent no-op, no duplicate audit event.
            return false;
        }
        addReviewEvent(db, {
            contributionId: input.contributionId,
            event: 'hidden',
            actorId: input.actorId,
            note: input.note ?? `Hidden for team ${input.team}`,
            occurredAt: ts,
        });
        return true;
    })();
}

/**
 * Un-hide an org contribution for one team, restoring the org default (visible).
 *
 * Deliberately NOT permission-gated: hiding is the gated, restrictive action;
 * un-hiding only RESTORES the org-wide default visibility, so it must stay
 * available even if the hide permission has since been revoked — otherwise
 * revoking permission would strand items a team had already hidden. (This is the
 * same spirit as the settings resolver, where turning a flag off causes overrides
 * to stop being honored, i.e. visibility returns to the default.)
 *
 * Idempotent: returns `true` and appends an `unhidden` audit event when a hide was
 * actually removed, `false` when there was nothing to un-hide. Throws
 * `invalid_actor`/`invalid_team` for blank inputs. Unlike hide it does not assert
 * org-scope: there can only be a hide row to remove for an org item anyway, and a
 * spurious team-scoped id simply finds nothing to remove.
 */
export function unhideOrgItemForTeam(db: Database.Database, input: HideInput): boolean {
    requireActor(input.actorId);
    requireTeam(input.team);
    const ts = input.timestamp ?? nowIso();

    return db.transaction((): boolean => {
        const res = db
            .prepare('DELETE FROM contribution_team_hides WHERE contribution_id = ? AND team = ?')
            .run(input.contributionId, input.team);
        if (res.changes === 0) {
            return false;
        }
        addReviewEvent(db, {
            contributionId: input.contributionId,
            event: 'unhidden',
            actorId: input.actorId,
            note: input.note ?? `Un-hidden for team ${input.team}`,
            occurredAt: ts,
        });
        return true;
    })();
}

// --- DB-backed resolution ----------------------------------------------------

/** Options for {@link listVisibleForViewer}. */
export interface VisibleForViewerOptions {
    /**
     * Store filters applied to the candidate set BEFORE scope resolution — the seam
     * for composing lifecycle/type/etc. filtering with scope filtering. A browse
     * surface typically passes `{state: 'published'}` here. Note `scope`/`scopeTarget`
     * filters would fight the scope resolution and are normally left unset.
     */
    filters?: ContributionFilters;
    /**
     * Whether per-team hides are currently honored — the resolved permission for the
     * viewer's team. Defaults to `true` (hides honored). Pass `false` to ignore
     * stored hides entirely, so an org item a team hid becomes visible again,
     * mirroring `resolveSetting` ignoring a team override when its flag is off.
     */
    hidesPermitted?: boolean;
}

/**
 * The single, authoritative "enforce viewer scope" step every surface shares: given
 * a set of candidate rows (however they were produced — a plain list, an FTS-ranked
 * search, …), resolve the viewer's per-team hides (when `hidesPermitted`) and return
 * only what the viewer may see, in the candidates' original order.
 *
 * This is the privacy-critical tail and MUST live in exactly one place — both the
 * browse surface ({@link listVisibleForViewer}) and search call it, so a change to
 * the visibility rule can never apply to one surface and not the other.
 *
 * A teamless viewer (`viewerTeam` null/undefined) gets only org items — there are
 * no team rows they can match and no hides keyed to a team. When `hidesPermitted`
 * is false the hidden set is empty, so hides are not subtracted.
 */
export function resolveVisibleForViewer<T extends ScopedContribution>(
    db: Database.Database,
    candidates: readonly T[],
    viewerTeam: string | null | undefined,
    hidesPermitted = true,
): T[] {
    // Only build the hidden set when hides are honored AND the viewer has a team —
    // a teamless viewer has no per-team hides to apply.
    const hiddenIds =
        hidesPermitted && viewerTeam != null
            ? getHiddenContributionIdsForTeam(db, viewerTeam)
            : new Set<string>();
    return resolveVisible(candidates, viewerTeam, hiddenIds);
}

/**
 * The DB-backed resolution helper a feature calls to get a viewer's visible set in
 * one step: it lists candidate contributions from the spine (narrowed by any
 * `filters`), then enforces viewer scope via {@link resolveVisibleForViewer},
 * returning only what the viewer may see, newest-first as the store orders them.
 */
export function listVisibleForViewer(
    db: Database.Database,
    viewerTeam: string | null | undefined,
    options: VisibleForViewerOptions = {},
): Contribution[] {
    const candidates = listContributions(db, options.filters ?? {});
    return resolveVisibleForViewer(db, candidates, viewerTeam, options.hidesPermitted ?? true);
}
