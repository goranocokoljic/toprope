import {useEffect, useState} from 'react';
import type {TimeRangePreset} from '../api/types';
import {
    PRESET_ORDER,
    PRESET_SHORT_LABELS,
    isValidDateString,
    presetValue,
    type TimeRangeValue,
    type ResolveOptions,
} from '../timeRange/range';

export interface TimeRangeSelectorProps {
    value: TimeRangeValue;
    onChange: (value: TimeRangeValue) => void;
    /** Earliest available data date (YYYY-MM-DD) — drives the lifetime window. */
    earliest?: string | null;
    /** Override "now" for deterministic rendering/tests. */
    now?: Date;
}

/**
 * The canonical time-range control for every time-series surface: preset chips
 * (30d / 90d / Year / All) plus a Custom mode with a from/to date picker. It is
 * controlled — the parent owns the value (typically via `useTimeRange`) so the
 * selection can be persisted and shared across charts on a screen.
 *
 * Custom validates from ≤ to and only emits a change once both dates are valid,
 * so a half-entered or inverted range never propagates to data queries.
 */
export function TimeRangeSelector({value, onChange, earliest, now}: TimeRangeSelectorProps): JSX.Element {
    const resolveOpts: ResolveOptions = {earliest, now};
    const [customMode, setCustomMode] = useState(value.kind === 'custom');
    const [from, setFrom] = useState(value.kind === 'custom' ? value.from : '');
    const [to, setTo] = useState(value.kind === 'custom' ? value.to : '');

    // Keep the local custom draft in step if the parent swaps in a custom value.
    useEffect(() => {
        if (value.kind === 'custom') {
            setCustomMode(true);
            setFrom(value.from);
            setTo(value.to);
        }
    }, [value]);

    const customError = validateCustom(from, to);

    function selectPreset(preset: TimeRangePreset): void {
        setCustomMode(false);
        onChange(presetValue(preset, resolveOpts));
    }

    function updateCustom(nextFrom: string, nextTo: string): void {
        setFrom(nextFrom);
        setTo(nextTo);
        if (validateCustom(nextFrom, nextTo) === null) {
            onChange({kind: 'custom', from: nextFrom, to: nextTo});
        }
    }

    return (
        <div className="flex flex-col gap-2" data-testid="time-range-selector">
            <div className="inline-flex flex-wrap items-center gap-1 rounded-md border border-border bg-surface p-1">
                {PRESET_ORDER.map((preset) => {
                    const active = !customMode && value.kind === preset;
                    return (
                        <button
                            key={preset}
                            type="button"
                            aria-pressed={active}
                            onClick={() => selectPreset(preset)}
                            className={[
                                'rounded px-2.5 py-1 text-sm font-medium transition-colors',
                                active ? 'bg-accent text-white' : 'text-muted hover:bg-surface-raised hover:text-foreground',
                            ].join(' ')}
                        >
                            {PRESET_SHORT_LABELS[preset]}
                        </button>
                    );
                })}
                <button
                    type="button"
                    aria-pressed={customMode}
                    onClick={() => setCustomMode(true)}
                    className={[
                        'rounded px-2.5 py-1 text-sm font-medium transition-colors',
                        customMode ? 'bg-accent text-white' : 'text-muted hover:bg-surface-raised hover:text-foreground',
                    ].join(' ')}
                >
                    Custom
                </button>
            </div>

            {customMode ? (
                <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <label className="flex items-center gap-1 text-muted">
                            <span>From</span>
                            <input
                                type="date"
                                aria-label="From date"
                                value={from}
                                max={to || undefined}
                                onChange={(e) => updateCustom(e.target.value, to)}
                                className="rounded-md border border-border bg-surface px-2 py-1 text-foreground"
                            />
                        </label>
                        <label className="flex items-center gap-1 text-muted">
                            <span>To</span>
                            <input
                                type="date"
                                aria-label="To date"
                                value={to}
                                min={from || undefined}
                                onChange={(e) => updateCustom(from, e.target.value)}
                                className="rounded-md border border-border bg-surface px-2 py-1 text-foreground"
                            />
                        </label>
                    </div>
                    {customError ? (
                        <p className="text-xs text-danger" role="alert">
                            {customError}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/** Returns an error message for an invalid custom range, or null when valid. */
function validateCustom(from: string, to: string): string | null {
    if (!from || !to) {
        return 'Select both a start and end date';
    }
    if (!isValidDateString(from) || !isValidDateString(to)) {
        return 'Enter valid dates';
    }
    if (from > to) {
        return 'Start date must be on or before the end date';
    }
    return null;
}
