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
    isCoachingPillar1Enabled,
    isCoachingPillar2Enabled,
    resolveSetting,
} from '../../settings/store';
import {getOrgLoopNudgeAggregate, getTeamLoopNudgeAggregate} from './loop-nudge';
import {deriveTeamOpportunities} from './opportunities';
import type {ManagerCoachingPanel} from './types';

/**
 * Whether Pillar 3 (capture-derived loop/nudge) signals may be aggregated for a
 * scope. Gated on `coaching_capture_permitted`: when the org/team does not permit
 * capture there is, by construction, no opted-in cohort, so the section is hidden
 * rather than shown empty. Resolved for the team so a per-team override is honored.
 */
function isLoopNudgeEnabled(db: Database.Database, team: string | null): boolean {
    return resolveSetting(db, 'coaching_capture_permitted', team) === true;
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
