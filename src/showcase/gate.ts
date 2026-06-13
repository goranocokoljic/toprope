/**
 * The org-policy gate for showcasing (Task 5.8 / #129), resolved live per request.
 *
 * Two org settings (Task 5.10) bound what a developer may publish, resolved for
 * the developer's TEAM so a per-team override is honored:
 *
 *   * `showcase_enabled` — the org/team master switch. When off, the showcase
 *     feature is inert: no promote, no publish.
 *   * `showcase_scope_permitted` — the widest sharing reach permitted. `team_only`
 *     (the default) confines publishing to the author's own team; `org_wide`
 *     additionally allows org-wide publishing.
 *
 * Reading these live on every request is what makes an org turning showcase off
 * (or narrowing scope) take effect immediately, with no cached enablement to go
 * stale. This is the single home for "what may this developer publish right now",
 * shared by the draft and publish routes so the policy lives in exactly one place.
 */

import type Database from 'better-sqlite3';
import {resolveSetting} from '../settings/store';
import type {ShowcaseScope} from './types';

/** Whether the showcase feature is enabled for a developer's team (org master switch). */
export function isShowcaseEnabledForTeam(db: Database.Database, team?: string | null): boolean {
    return resolveSetting(db, 'showcase_enabled', team) === true;
}

/**
 * The scopes a developer's team may publish at, derived from
 * `showcase_scope_permitted`: `team_only` → only team scope; `org_wide` → team
 * AND org. Team scope is always available once showcasing is enabled — narrowing
 * to team-only never removes the ability to share within one's own team.
 */
export function permittedScopesForTeam(db: Database.Database, team?: string | null): ShowcaseScope[] {
    const permitted = resolveSetting(db, 'showcase_scope_permitted', team);
    return permitted === 'org_wide' ? ['team', 'org'] : ['team'];
}

/** Whether a specific scope is currently permitted for a developer's team. */
export function isScopePermittedForTeam(db: Database.Database, team: string | null | undefined, scope: ShowcaseScope): boolean {
    return permittedScopesForTeam(db, team).includes(scope);
}
