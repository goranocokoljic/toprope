/**
 * The codec for a TEXT column that holds a JSON array of strings.
 *
 * Two such columns exist — `sync_logs.errors` (the scheduled path's collected errors and
 * advisories) and `git_providers.last_sync_advisories` (#289, the scoped admin path's
 * advisories). They are written and read by different modules, so the encode/decode pair
 * lives here once rather than being cloned per column: a second copy is a second answer to
 * "what does an unparseable blob mean", and the two would drift the moment either side
 * gained a tolerance the other lacks.
 *
 * NULL means "nothing to record", never "an empty list": both writers encode an empty array
 * back to NULL so a row cannot carry `'[]'` and `NULL` as two spellings of the same state.
 */

/**
 * Encode a list for storage: JSON when there is anything to say, NULL when there is not.
 *
 * The NULL-for-empty rule is what lets a reader test the column itself for "did the last run
 * report anything", with no need to parse first.
 */
export function encodeStringArrayColumn(values: readonly string[]): string | null {
    return values.length > 0 ? JSON.stringify(values) : null;
}

/**
 * Decode a non-null column value into its entries.
 *
 * Tolerant on purpose, and the tolerance is the point: neither column carries a CHECK
 * constraint, so one hand-edited, legacy, or half-written row must not make the whole
 * surface unreadable. A value that is not a JSON array of strings is surfaced as a
 * single entry holding its RAW text — degraded, but never silently dropped, because
 * both columns exist precisely to stop something from vanishing unreported.
 *
 * Takes a non-null `string` so each caller keeps its own null semantics (`sync_logs`
 * distinguishes "no row data" as `null`; the provider DTO flattens it to `[]`).
 */
export function decodeStringArrayColumn(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return parsed.map((e) => String(e));
    } catch {
        // fall through — an unparseable blob is surfaced as-is below rather than thrown away
    }
    return [raw];
}
