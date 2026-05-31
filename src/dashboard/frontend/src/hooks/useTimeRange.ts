import {useCallback, useEffect, useRef, useState} from 'react';
import {usePreferences, useUpdatePreferences} from './usePreferences';
import {
    DEFAULT_PRESET,
    presetValue,
    smartDefaultPreset,
    type TimeRangeValue,
} from '../timeRange/range';

export interface UseTimeRangeOptions {
    /** Earliest available data date (YYYY-MM-DD) for the scope being viewed. */
    earliest?: string | null;
    /** Override "now" for deterministic tests. */
    now?: Date;
}

export interface UseTimeRange {
    range: TimeRangeValue;
    setRange: (value: TimeRangeValue) => void;
    /** True while the persisted preference is still loading. */
    isPending: boolean;
}

/**
 * State + persistence for a screen's time range. It reconciles three things:
 *
 *  1. Smart default — until anything is known, the window is the smallest preset
 *     that contains the scope's history (`smartDefaultPreset`).
 *  2. Remembered choice — once preferences load, an explicit stored preset
 *     (anything other than the registry default) wins, so the user's choice
 *     survives across sessions. A stored value equal to the default is treated
 *     as "no explicit choice", so the smart default still applies.
 *  3. Live interaction — once the user picks a range here, that wins for the
 *     session; preset picks are persisted back to /api/me/preferences (custom
 *     ranges are session-local, since the preference holds a single preset).
 */
export function useTimeRange(options: UseTimeRangeOptions = {}): UseTimeRange {
    const {earliest = null} = options;
    // Freeze "now" for the lifetime of the hook so windows don't drift between
    // renders (and tests stay deterministic).
    const nowRef = useRef(options.now ?? new Date());
    const resolveOpts = {earliest, now: nowRef.current};

    const {data: prefs, isPending} = usePreferences();
    const update = useUpdatePreferences();

    const userTouched = useRef(false);
    const [range, setRangeState] = useState<TimeRangeValue>(() =>
        presetValue(smartDefaultPreset(resolveOpts), resolveOpts),
    );
    // Mirror of `range` for `setRange` to read without a stale closure (and
    // without taking `range` as a callback dep, which would churn the identity).
    const rangeRef = useRef(range);
    rangeRef.current = range;

    // Adopt the remembered preference (or smart default) once it loads, and keep
    // the window correct if `earliest` arrives after the preference. Stops as
    // soon as the user interacts, so we never snap their selection back.
    useEffect(() => {
        if (userTouched.current || !prefs) {
            return;
        }
        const stored = prefs.default_time_range;
        const preset = stored !== DEFAULT_PRESET ? stored : smartDefaultPreset({earliest, now: nowRef.current});
        setRangeState(presetValue(preset, {earliest, now: nowRef.current}));
    }, [prefs, earliest]);

    const setRange = useCallback(
        (value: TimeRangeValue) => {
            userTouched.current = true;
            const previousKind = rangeRef.current.kind;
            setRangeState(value);
            // Persist preset choices so they're remembered next session, but only
            // when the preset actually changed — re-picking the current one would
            // be a redundant PATCH. Custom ranges carry dates a single-string
            // preference can't hold, so they stay session-local by design.
            if (value.kind !== 'custom' && value.kind !== previousKind) {
                update.mutate({default_time_range: value.kind});
            }
        },
        [update],
    );

    return {range, setRange, isPending};
}
