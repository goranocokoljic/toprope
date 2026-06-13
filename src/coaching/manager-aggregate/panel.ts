/**
 * Unified manager coaching panel — the single team-aggregate surface
 * (Task 5.11 / #132).
 *
 * Composes the three pillar aggregates (PR/review §5.3, available-data churn §5.1,
 * loop/nudge patterns §5.6→aggregated here) plus the synthesized team coaching
 * opportunities into ONE admin-only payload. Bundling them behind one builder is
 * deliberate: the "team aggregate only, no individual drill-down" guarantee then
 * flows through a single place, and each pillar honors its own enable flag so a
 * pillar disabled by org/team policy (Task 5.10) is simply absent here.
 *
 * Crucially, this panel only ever calls the AGGREGATE read functions — there is no
 * code path here, nor anywhere it delegates to, that accepts a developer id or
 * returns one developer's coaching. The opportunities are derived from the same
 * floored aggregates, so the entire surface is structurally aggregate-only.
 */

import type Database from 'better-sqlite3';
import type {PeriodUnit} from '../period-window';
import {getOrgPRReviewCoaching, getTeamPRReviewCoaching} from '../pr-review/coaching';
import {getOrgCoaching, getTeamCoaching} from '../available/coaching';
import {
    isCoachingCapturePermitted,
    isCoachingPillar1Enabled,
    isCoachingPillar2Enabled,
} from '../../settings/store';
import {getOrgLoopNudgeAggregate, getTeamLoopNudgeAggregate} from './loop-nudge';
import {deriveTeamOpportunities} from './opportunities';
import type {ManagerCoachingPanel} from './types';

/**
 * Whether the Pillar 3 (capture-derived loop/nudge) section should be shown for a
 * scope. When capture isn't permitted there is, by construction, no opted-in
 * cohort, so the section is hidden rather than shown empty.
 *
 * For a TEAM this is just the team-resolved `coaching_capture_permitted`. For the
 * ORG roll-up it is global-OR-any-team: `coaching_capture_permitted` is
 * team-overridable, and the opted-in cohort is resolved per the developer's OWN
 * team (capture/gate.ts), so a team that turns capture on while the global flag is
 * off still has valid opted-in contributors. Gating the org section on the global
 * flag alone would hide those developers from the org view even though they show
 * on their team's panel — a silent gap. Checking any-team keeps the org roll-up
 * consistent with where the data actually lives.
 */
function isLoopNudgeEnabled(db: Database.Database, team: string | null): boolean {
    if (team !== null) {
        return isCoachingCapturePermitted(db, team);
    }
    if (isCoachingCapturePermitted(db, null)) {
        return true;
    }
    const teams = db.prepare('SELECT name FROM teams').all() as Array<{name: string}>;
    return teams.some((t) => isCoachingCapturePermitted(db, t.name));
}

/**
 * Build the manager coaching panel for a scope. `team` is null for the org-wide
 * roll-up (each pillar then gates on its GLOBAL flag) or a team name (each pillar
 * gates on the value resolved for that team). The caller (the route) owns
 * existence checks and the admin guard; this function assumes an authorized,
 * real scope and just assembles the aggregates.
 */
function buildPanel(
    db: Database.Database,
    scope: string,
    team: string | null,
    unit: PeriodUnit,
    now: Date,
): ManagerCoachingPanel {
    const pillar2On = isCoachingPillar2Enabled(db, team);
    const pillar1On = isCoachingPillar1Enabled(db, team);
    const pillar3On = isLoopNudgeEnabled(db, team);

    const prReview = pillar2On
        ? team === null
            ? getOrgPRReviewCoaching(db, unit, now)
            : getTeamPRReviewCoaching(db, team, unit, now)
        : null;
    const available = pillar1On
        ? team === null
            ? getOrgCoaching(db, unit, now)
            : getTeamCoaching(db, team, unit, now)
        : null;
    const loopNudge = pillar3On
        ? team === null
            ? getOrgLoopNudgeAggregate(db, unit, now)
            : getTeamLoopNudgeAggregate(db, team, unit, now)
        : null;

    return {
        scope,
        period_unit: unit,
        pr_review: prReview ? {enabled: true, ...prReview} : {enabled: false},
        available: available ? {enabled: true, ...available} : {enabled: false},
        loop_nudge: loopNudge ? {enabled: true, ...loopNudge} : {enabled: false},
        // Opportunities are derived only from the pillars that are enabled — a
        // disabled pillar contributes none, never a stale or leaking suggestion.
        opportunities: deriveTeamOpportunities(prReview, available, loopNudge),
    };
}

/** Org-wide manager coaching panel — every pillar gates on its global flag. */
export function getOrgManagerCoachingPanel(
    db: Database.Database,
    unit: PeriodUnit,
    now: Date = new Date(),
): ManagerCoachingPanel {
    return buildPanel(db, 'org', null, unit, now);
}

/** One team's manager coaching panel — every pillar gates on the team-resolved flag. */
export function getTeamManagerCoachingPanel(
    db: Database.Database,
    team: string,
    unit: PeriodUnit,
    now: Date = new Date(),
): ManagerCoachingPanel {
    return buildPanel(db, team, team, unit, now);
}
