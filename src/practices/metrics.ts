/**
 * The canonical best-practice metric vocabulary (Task 6.2.3 / #158).
 *
 * The shared allowlist of metric identifiers a practice may reference. It serves
 * two consumers that MUST agree on the same names:
 *
 *   1. The rich authoring editor (6.2.3) — an embedded `{{metric}}` reference is
 *      only rendered as a metric chip, and only contributes an auto-surfacing tag,
 *      when its name is in this set. An unknown `{{foo}}` is left as literal text so
 *      a typo is visible in the preview rather than silently creating a dead tag.
 *   2. The later surfacing tasks (tag-based auto-surfacing 6.2.5, contextual display
 *      6.2.7) — they match a practice to the metric a developer is looking at by the
 *      SAME identifier the editor tagged it with. Defining the names here once keeps
 *      the authoring side and the surfacing side from drifting apart.
 *
 * The names mirror the metric keys the schema's `practice_metric_pins.metric`
 * column documents (`churn | acceptance_rate | cost_per_pr | …`) and the aggregate
 * surface already computes (acceptance rate, code churn, cost per PR, AI-signature
 * score, estimated cost). The column itself carries no CHECK — pins/surfacing accept
 * any string so the metric set can grow without a migration — but the AUTHORING
 * surface deliberately gates references to this known set, so an editor only ever
 * mints a tag a surfacing query will later understand.
 */

/**
 * The metric identifiers the authoring editor recognises in `{{metric}}` references.
 * Lowercase snake_case, matching the surfacing/aggregate vocabulary. Extending the
 * set is a code change here (no schema migration), exactly like adding a content
 * type to the spine.
 */
export const PRACTICE_METRICS = [
    'churn',
    'acceptance_rate',
    'cost_per_pr',
    'ai_signature_score',
    'estimated_cost',
] as const;

/** A metric identifier known to the authoring/surfacing vocabulary. */
export type PracticeMetric = (typeof PRACTICE_METRICS)[number];

const PRACTICE_METRIC_SET: ReadonlySet<string> = new Set(PRACTICE_METRICS);

/**
 * Whether `value` is a recognised practice metric. Used both to decide whether a
 * `{{metric}}` reference becomes a chip + tag and to identify which of a
 * contribution's existing tags are metric-derived (so a save can reconcile them
 * without disturbing free-form, non-metric tags).
 */
export function isPracticeMetric(value: string): value is PracticeMetric {
    return PRACTICE_METRIC_SET.has(value);
}
