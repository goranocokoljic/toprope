import {useEffect, useRef} from 'react';
import {Card} from '../components/Card';
import {usePreferences, useUpdatePreferences} from '../hooks/usePreferences';
import {useTheme} from '../theme/useTheme';
import type {TimeRange} from '../api/types';

const TIME_RANGES: {value: TimeRange; label: string}[] = [
    {value: '7d', label: 'Last 7 days'},
    {value: '30d', label: 'Last 30 days'},
    {value: '90d', label: 'Last 90 days'},
];

/**
 * Per-user UI preferences (Task 2.16): default time range and dark mode. The
 * dark-mode preference is the persistent source of truth — when it loads (or is
 * changed) we drive the live theme from it, so the choice survives across
 * devices/sessions rather than living only in localStorage.
 */
export function Preferences(): JSX.Element {
    const {data, isPending, isError, error} = usePreferences();
    const update = useUpdatePreferences();
    const {theme, setTheme} = useTheme();

    // Apply the persisted dark-mode preference to the live theme once, on first
    // load. A ref guards against re-applying on every render/refetch so the user
    // can still flip the theme afterward without it snapping back.
    const synced = useRef(false);
    useEffect(() => {
        if (data && !synced.current) {
            synced.current = true;
            setTheme(data.dark_mode ? 'dark' : 'light');
        }
    }, [data, setTheme]);

    function onToggleDarkMode(): void {
        const previous = theme;
        const next = theme !== 'dark';
        // Optimistically flip the live theme, but roll back if the write fails
        // so the visible theme never silently diverges from the persisted value.
        setTheme(next ? 'dark' : 'light');
        update.mutate({dark_mode: next}, {onError: () => setTheme(previous)});
    }

    function onChangeTimeRange(value: TimeRange): void {
        update.mutate({default_time_range: value});
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Preferences</h1>
                <p className="mt-1 text-sm text-muted">Personal settings for your dashboard experience.</p>
            </div>

            {isPending ? <p className="text-sm text-muted">Loading preferences…</p> : null}
            {isError ? (
                <Card>
                    <p className="text-sm text-danger">Failed to load preferences: {error.message}</p>
                </Card>
            ) : null}

            {data ? (
                <Card title="Display">
                    <div className="space-y-5">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-foreground">Dark mode</p>
                                <p className="text-xs text-muted">Use the dark colour theme.</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={theme === 'dark'}
                                aria-label="Dark mode"
                                onClick={onToggleDarkMode}
                                className={[
                                    'inline-flex h-6 w-11 items-center rounded-full transition-colors',
                                    theme === 'dark' ? 'bg-accent' : 'bg-border',
                                ].join(' ')}
                            >
                                <span
                                    className={[
                                        'inline-block h-5 w-5 transform rounded-full bg-white transition-transform',
                                        theme === 'dark' ? 'translate-x-5' : 'translate-x-1',
                                    ].join(' ')}
                                />
                            </button>
                        </div>

                        <div className="flex items-center justify-between">
                            <div>
                                <label htmlFor="default-time-range" className="text-sm font-medium text-foreground">
                                    Default time range
                                </label>
                                <p className="text-xs text-muted">Pre-selected range when opening dashboards.</p>
                            </div>
                            <select
                                id="default-time-range"
                                value={data.default_time_range}
                                onChange={(e) => onChangeTimeRange(e.target.value as TimeRange)}
                                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                            >
                                {TIME_RANGES.map((r) => (
                                    <option key={r.value} value={r.value}>
                                        {r.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {update.isError ? (
                            <p className="text-sm text-danger">Failed to save: {update.error.message}</p>
                        ) : null}
                    </div>
                </Card>
            ) : null}
        </div>
    );
}
