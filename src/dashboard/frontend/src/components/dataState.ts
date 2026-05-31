/**
 * Classifies a data scope into one of the honest data-states the dashboard
 * renders. The critical distinction is cold-start vs genuine-empty: both look
 * like "no numbers", but they mean opposite things — one is "we haven't
 * collected enough yet", the other is "we have collected enough, and the real
 * answer is zero" (e.g. a seat nobody uses). Conflating them would either make
 * a brand-new install look broken or make a genuinely unused seat look like it
 * just needs more time.
 *
 * The discriminator is how many real days of data back the scope, measured
 * against the platform's significance threshold (14 days — the same fortnight
 * the waste model uses to call a seat unused). Below the threshold we refuse to
 * call a scope "empty"; we can only honestly say we're still collecting.
 */

/** Days of real data before a scope's numbers are treated as conclusive. */
export const SIGNIFICANCE_DAYS = 14;

export type DataStateKind = 'loading' | 'error' | 'cold-start' | 'empty' | 'ready';

export interface DataStateInput {
    /** The query is still loading. */
    isLoading?: boolean;
    /** The query failed (any truthy error). */
    error?: unknown;
    /** At least one connector is configured for this scope. */
    connected?: boolean;
    /** Real days of data collected for this scope. */
    dataDays?: number;
    /** Whether the scope has any non-zero activity signal. */
    hasSignal?: boolean;
    /** Days below which collection is still "warming up". Defaults to SIGNIFICANCE_DAYS. */
    significanceDays?: number;
}

/**
 * Resolve a scope to a single data-state. Order matters: transient states
 * (error, loading) win over content states so we never render stale content
 * over a failed refetch.
 */
export function classifyDataState(input: DataStateInput): DataStateKind {
    const {isLoading, error, connected = false, dataDays = 0, hasSignal = false} = input;
    const significanceDays = input.significanceDays ?? SIGNIFICANCE_DAYS;

    if (error) return 'error';
    if (isLoading) return 'loading';

    // Nothing connected, or connected but not enough collected yet → cold-start.
    // We cannot honestly call a scope "empty" until we've collected enough days
    // to be confident the absence of activity is real and not just early days.
    if (!connected) return 'cold-start';
    if (dataDays < significanceDays) return 'cold-start';

    // Enough history, but genuinely no activity → real empty (e.g. unused seat).
    if (!hasSignal) return 'empty';

    return 'ready';
}
