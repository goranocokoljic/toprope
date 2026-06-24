/**
 * Tag-based auto-surfacing — practices appear next to the metric they relate to
 * (Task 6.2.5 / #160).
 *
 * The contextual-surfacing differentiator (Phase 6 design §4.1/§4.3): rather than a
 * docs graveyard, a best practice tagged `churn` auto-surfaces beside the churn
 * figure a developer is looking at. This module answers the one question that powers
 * that — "given a metric being displayed to this viewer, which practices should
 * surface, and in what order?" — by COMPOSING the primitives the earlier tasks
 * already built, adding no new tables and no parallel stacks (Epic 6.2 cross-cutting
 * criterion):
 *
 *   1. TAG MATCH + SCOPE. The candidate set is the published best practices tagged
 *      with the metric, within the viewer's scope. This reuses the 6.1.5 search
 *      ({@link searchContributions}) with a tag filter, so scope enforcement and
 *      per-team hides (6.1.4) come for free and live in exactly one place — a viewer
 *      can never be surfaced a practice they could not otherwise see.
 *   2. SUPPRESSION RESPECT (6.2.6). A lead may suppress a practice for a metric via
 *      `practice_metric_pins`. The override rows are append-only, so the current
 *      decision per (contribution, metric) is the LATEST row — a later pin cancels an
 *      earlier suppress and vice-versa. {@link resolveCurrentMetricOverrides} reduces
 *      the rows to that current decision; surfacing drops the suppressed ones.
 *   3. RANKING (respects contribution model). The visible set is ordered by the
 *      viewer-team's active contribution model via {@link orderPracticePool}:
 *      endorsed-first then helpful-ratio under hybrid, helpful-ratio under bottom_up,
 *      recency under top_down. "Endorsed/helpful first" falls straight out of reusing
 *      that one ranking, so surfacing order and pool order can never drift apart.
 *
 * Manual override merge (6.2.6 / #161): a lead's PIN force-surfaces a practice at a
 * metric even when it is not tagged with it, and a SUPPRESS removes an auto-surfaced
 * one. Both decisions come from {@link resolveCurrentMetricOverrides}. The merge
 * stays inside the same scope/published guarantees as auto-surfacing — a pinned
 * practice is force-surfaced ONLY if it is published and the viewer could already see
 * it, so a pin can never leak a practice past the viewer's scope — and pinned
 * practices are elevated above the auto-surfaced ones (lead precision wins placement),
 * model-ordered within each group.
 *
 * Pure composition over a single writer: every DB read goes through the existing
 * stores, so this module holds no SQL of its own and inherits their concurrency
 * posture.
 */

import type Database from 'better-sqlite3';
import {searchContributions} from '../contributions/search';
import {resolveVisibleForViewer} from '../contributions/scope';
import {getContribution} from '../contributions/store';
import type {Contribution} from '../contributions/types';
import {PRACTICE_CONTENT_TYPE} from './authoring';
import {resolveContributionModel} from './contributionModel';
import {orderPracticePool, type RankedPractice} from './contributionEngine';
import {listMetricPins} from './store';

/**
 * The current manual override decision for a metric, reduced from the append-only
 * `practice_metric_pins` rows: the set of contribution ids currently PINNED to the
 * metric and the set currently SUPPRESSED for it. A contribution appears in at most
 * one set — its latest override row wins — and a contribution with no override row
 * for the metric appears in neither.
 */
export interface MetricOverrides {
    /** Contributions whose current decision for the metric is `pin` (force-surface — consumed by 6.2.6). */
    pinned: Set<string>;
    /** Contributions whose current decision for the metric is `suppress` (hidden from the metric). */
    suppressed: Set<string>;
}

/**
 * Reduce the append-only metric-pin rows for one metric to the CURRENT decision per
 * contribution. {@link listMetricPins} returns rows newest-first, so the first row
 * seen for a contribution is its latest — later (older) rows for the same
 * contribution are ignored. This makes pin/suppress a last-write-wins toggle: a
 * suppress recorded after a pin suppresses, a pin recorded after a suppress
 * un-suppresses, with no row deletion required.
 *
 * A blank metric never has meaningful overrides; it yields two empty sets without a
 * query (the surfacing path treats a blank metric as "nothing to surface" anyway).
 */
export function resolveCurrentMetricOverrides(db: Database.Database, metric: string): MetricOverrides {
    const pinned = new Set<string>();
    const suppressed = new Set<string>();
    if (metric.trim() === '') {
        return {pinned, suppressed};
    }
    const seen = new Set<string>();
    for (const pin of listMetricPins(db, {metric})) {
        if (seen.has(pin.contributionId)) {
            continue; // an older override row for a contribution already decided — skip.
        }
        seen.add(pin.contributionId);
        if (pin.action === 'pin') {
            pinned.add(pin.contributionId);
        } else {
            suppressed.add(pin.contributionId);
        }
    }
    return {pinned, suppressed};
}

/** A practice chosen to surface next to a metric, with the ranking signals that placed it. */
export interface SurfacedPractice {
    /** The surfaced practice's spine row. */
    contribution: Contribution;
    /** Its place + signals in the model-ordered pool (endorsed flag, feedback counts, rank score). */
    ranking: RankedPractice;
    /**
     * Whether a lead PINNED this practice to the metric (6.2.6). Pinned practices are
     * force-surfaced (even when untagged) and listed above the auto-surfaced ones; the
     * flag rides along so the display (6.2.7) can mark a lead's deliberate choice.
     */
    pinned: boolean;
}

/** What to surface, and for whom. */
export interface SurfacePracticesInput {
    /** The metric being displayed (e.g. `churn`). Matched against contribution tags; blank → nothing surfaces. */
    metric: string;
    /**
     * The viewer's team, for SCOPE ENFORCEMENT and to resolve the active contribution
     * model. `null`/omitted is a teamless viewer, who sees only org-scoped practices.
     */
    viewerTeam?: string | null;
    /**
     * Whether the viewer's per-team hides are honored (the resolved 6.1.4 permission).
     * Defaults to `true`; `false` ignores stored hides so a hidden org practice can
     * resurface, mirroring the settings resolver ignoring an override when its flag is off.
     */
    hidesPermitted?: boolean;
    /** Cap the number of surfaced practices (applied after ranking). Omit for no cap. */
    limit?: number;
}

/**
 * The surfacing set for a metric: the published best practices tagged with it that
 * the viewer may see and that are not suppressed for it, ordered by the viewer-team's
 * active contribution model.
 *
 * Pipeline:
 *   1. Candidates = published `best_practice` contributions tagged with the metric,
 *      already scope-resolved by {@link searchContributions} (6.1.5 → 6.1.4).
 *   2. Drop any whose CURRENT override decision for the metric is `suppress`.
 *   3. Force-surface PINNED practices (6.2.6) not already in the candidate set —
 *      including untagged ones — after putting them through the SAME published +
 *      viewer-scope guarantees as the tag-matched candidates, so a pin can never widen
 *      what the viewer may see.
 *   4. Order with {@link orderPracticePool} under the resolved model (endorsed/helpful
 *      first where the model uses them; recency under top_down), then ELEVATE the
 *      pinned practices above the auto-surfaced ones (model order kept within each
 *      group).
 *
 * A blank metric short-circuits to an empty list — there is no "tag" to match and a
 * blank tag would spuriously collide with empty free-form tags. Returns at most
 * `limit` practices when one is given.
 */
export function surfacePractices(db: Database.Database, input: SurfacePracticesInput): SurfacedPractice[] {
    const metric = input.metric.trim();
    if (metric === '') {
        return [];
    }

    // 1. Tag-matched, published, scope-resolved candidates. The tag filter selects
    //    practices carrying the metric tag; the search's scope tail removes anything
    //    outside the viewer's scope (including per-team hides).
    const hits = searchContributions(db, {
        tag: metric,
        filters: {contentType: PRACTICE_CONTENT_TYPE, state: 'published'},
        viewerTeam: input.viewerTeam,
        hidesPermitted: input.hidesPermitted,
    });

    // 2. Resolve the current override decision per contribution for this metric, then
    //    drop the suppressed ones from the tag-matched set.
    const {pinned, suppressed} = resolveCurrentMetricOverrides(db, metric);
    const byId = new Map<string, Contribution>();
    for (const hit of hits) {
        if (!suppressed.has(hit.contribution.id)) {
            byId.set(hit.contribution.id, hit.contribution);
        }
    }

    // 3. Force-surface pinned practices that the tag match did not already include
    //    (e.g. a pinned-but-untagged practice). Each must clear the SAME gates the
    //    auto-surfaced ones did: it must be published (the non-published filter below
    //    via orderPracticePool would drop it regardless, but skipping it here avoids
    //    even loading it into the pool) and visible to the viewer. resolveVisibleForViewer
    //    is the exact scope tail searchContributions uses, so a pin honours per-team
    //    scope and hides identically — a lead cannot pin a practice into a viewer's
    //    view that the viewer could not otherwise see.
    for (const id of pinned) {
        if (byId.has(id)) {
            continue; // already a tag match; it will simply be flagged pinned below.
        }
        const contribution = getContribution(db, id);
        if (!contribution || contribution.state !== 'published') {
            continue; // a pin only force-surfaces a real, published practice.
        }
        const [visible] = resolveVisibleForViewer(
            db,
            [contribution],
            input.viewerTeam,
            input.hidesPermitted ?? true,
        );
        if (visible !== undefined) {
            byId.set(id, contribution);
        }
    }

    // 4. Rank by the viewer-team's active contribution model, then elevate the pinned
    //    practices above the auto-surfaced ones. orderPracticePool only returns
    //    published ids from the input set, all of which are in `byId`.
    const model = resolveContributionModel(db, input.viewerTeam);
    const ranked = orderPracticePool(db, model, [...byId.keys()]);

    const pinnedSurfaced: SurfacedPractice[] = [];
    const autoSurfaced: SurfacedPractice[] = [];
    for (const ranking of ranked) {
        const contribution = byId.get(ranking.contributionId);
        if (contribution === undefined) {
            continue; // unreachable: every ranked id came from byId. Defensive, not a real branch.
        }
        const isPinned = pinned.has(ranking.contributionId);
        (isPinned ? pinnedSurfaced : autoSurfaced).push({contribution, ranking, pinned: isPinned});
    }
    // Pinned first (lead precision wins placement), model order preserved within each group.
    const surfaced = [...pinnedSurfaced, ...autoSurfaced];

    return input.limit !== undefined ? surfaced.slice(0, input.limit) : surfaced;
}
