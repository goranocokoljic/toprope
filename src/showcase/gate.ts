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
 * Whether a specific scope is currently permitted for a developer's team, per
 * `showcase_scope_permitted`. Team scope is ALWAYS available once showcasing is
 * enabled — narrowing to `team_only` never removes the ability to share within
 * one's own team; org scope additionally requires the org to permit `org_wide`.
 *
 * (A "list every permitted scope" helper for a scope-selection UI is deliberately
 * NOT exported yet — there is no caller until the Task 5.9 browse/selection surface,
 * which can add it when it has a concrete use.)
 */
export function isScopePermittedForTeam(db: Database.Database, team: string | null | undefined, scope: ShowcaseScope): boolean {
    if (scope === 'team') {
        return true;
    }
    return resolveSetting(db, 'showcase_scope_permitted', team) === 'org_wide';
}

/**
 * Whether the optional AI prompt-technique annotation (Task 6.3.7 / #170) is enabled
 * for a developer's team, per `showcase_ai_annotation_enabled`. OFF by default —
 * resolved live so an org turning it off takes effect immediately. The annotation
 * generator consults this before ever calling the model, so a disabled team neither
 * generates nor stores an annotation.
 */
export function isAiAnnotationEnabledForTeam(db: Database.Database, team?: string | null): boolean {
    return resolveSetting(db, 'showcase_ai_annotation_enabled', team) === true;
}
