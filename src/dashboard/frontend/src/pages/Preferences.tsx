import {Card} from '../components/Card';
import {
    useCoachingPreferences,
    usePreferences,
    useUpdateCoachingPreferences,
    useUpdatePreferences,
} from '../hooks/usePreferences';
import {useTheme} from '../theme/useTheme';
import {useApplyThemePreference} from '../theme/useApplyThemePreference';
import {PRESET_LABELS, PRESET_ORDER} from '../timeRange/range';
import type {CoachingPreferences, TimeRangePreset} from '../api/types';

const TIME_RANGES: {value: TimeRangePreset; label: string}[] = PRESET_ORDER.map((value) => ({
    value,
    label: PRESET_LABELS[value],
}));

// Display metadata for the developer coaching preferences (Task 5.10). Keys
// mirror the backend DEVELOPER_PREFERENCES registry; each control binds to the
// developer's own stored choice and is disabled (with the org's reason) when the
// org policy currently blocks it.
type CoachingField =
    | {key: string; label: string; help: string; type: 'boolean'}
    | {key: string; label: string; help: string; type: 'enum'; options: {value: string; label: string}[]};

const COACHING_FIELDS: CoachingField[] = [
    {
        key: 'capture_opt_in',
        label: 'Capture my prompts',
        help: 'Opt in to private, encrypted capture of your AI sessions.',
        type: 'boolean',
    },
    {
        key: 'capture_mechanism',
        label: 'Capture mechanism',
        help: 'How sessions are captured when capture is on.',
        type: 'enum',
        options: [
            {value: 'local_agent', label: 'Local agent'},
            {value: 'editor_extension', label: 'Editor extension'},
        ],
    },
    {
        key: 'capture_recovery_choice',
        label: 'Key recovery',
        help: 'No-recovery is most private; a recovery path is logged whenever used.',
        type: 'enum',
        options: [
            {value: 'no_recovery', label: 'No recovery (most private)'},
            {value: 'recovery_path', label: 'Recovery path'},
        ],
    },
    {
        key: 'cloud_analysis_opt_in',
        label: 'Allow cloud-model analysis',
        help: 'Let retrospectives use cloud models. Off keeps analysis fully local.',
        type: 'boolean',
    },
    {
        key: 'nudges_enabled',
        label: 'Real-time nudges',
        help: 'Show loop-detection and prompt-quality nudges while you work.',
        type: 'boolean',
    },
    {
        key: 'nudge_frequency',
        label: 'Nudge frequency',
        help: 'How often nudges may fire.',
        type: 'enum',
        options: [
            {value: 'low', label: 'Low'},
            {value: 'normal', label: 'Normal'},
            {value: 'high', label: 'High'},
        ],
    },
];

/**
 * The developer's own coaching opt-ins, resolved against the org boundary. A
 * control whose org policy is off is disabled and shows the org's reason — the
 * developer can see the choice exists but cannot enable what the org forbids.
 */
function CoachingPreferencesCard(): JSX.Element | null {
    const {data, isPending, isError, error} = useCoachingPreferences();
    const update = useUpdateCoachingPreferences();

    // A developer-linked account is required; admins without a developer profile
    // get a 404 here. Hide the card rather than show an error in that case.
    if (isError) {
        const status = (error as Error & {status?: number}).status;
        if (status === 404) {
            return null;
        }
        return (
            <Card title="Coaching preferences">
                <p className="text-sm text-danger">Failed to load: {error.message}</p>
            </Card>
        );
    }
    if (isPending || !data) {
        return (
            <Card title="Coaching preferences">
                <p className="text-sm text-muted">Loading…</p>
            </Card>
        );
    }

    function commit(key: string, value: boolean | string): void {
        update.mutate({[key]: value});
    }

    return (
        <Card title="Coaching preferences">
            <p className="mb-4 text-xs text-muted">
                Your personal coaching choices. Some options are set by your organization’s
                policy — those are shown disabled with the reason.
            </p>
            <div className="space-y-5">
                {COACHING_FIELDS.map((field) => (
                    <CoachingRow
                        key={field.key}
                        field={field}
                        prefs={data}
                        onChange={(value) => commit(field.key, value)}
                    />
                ))}
                {update.isError ? (
                    <p className="text-sm text-danger">Failed to save: {update.error.message}</p>
                ) : null}
            </div>
        </Card>
    );
}

function CoachingRow({
    field,
    prefs,
    onChange,
}: {
    field: CoachingField;
    prefs: CoachingPreferences;
    onChange: (value: boolean | string) => void;
}): JSX.Element {
    const pref = prefs[field.key];
    // Bind to the developer's own stored choice so the control shows what they
    // picked; `blocked` disables it and surfaces the org's reason.
    const stored = pref?.stored;
    const blocked = pref?.blocked ?? false;
    return (
        <div className="flex items-start justify-between gap-4">
            <div>
                <p className="text-sm font-medium text-foreground">{field.label}</p>
                <p className="text-xs text-muted">{field.help}</p>
                {blocked && pref?.reason ? (
                    <p className="mt-1 text-xs text-danger">{pref.reason}</p>
                ) : null}
            </div>
            {field.type === 'boolean' ? (
                <input
                    type="checkbox"
                    role="switch"
                    aria-label={field.label}
                    checked={Boolean(stored)}
                    disabled={blocked}
                    onChange={(e) => onChange(e.target.checked)}
                    className="mt-1 h-4 w-4 disabled:opacity-50"
                />
            ) : (
                <select
                    aria-label={field.label}
                    value={String(stored)}
                    disabled={blocked}
                    onChange={(e) => onChange(e.target.value)}
                    className="w-44 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
                >
                    {field.options.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}

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

    // The app shell already applies this preference on load; calling the shared
    // hook here keeps the page correct when rendered on its own (and in tests).
    useApplyThemePreference();

    function onToggleDarkMode(): void {
        const previous = theme;
        const next = theme !== 'dark';
        // Optimistically flip the live theme, but roll back if the write fails
        // so the visible theme never silently diverges from the persisted value.
        setTheme(next ? 'dark' : 'light');
        update.mutate({dark_mode: next}, {onError: () => setTheme(previous)});
    }

    function onChangeTimeRange(value: TimeRangePreset): void {
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
                                onChange={(e) => onChangeTimeRange(e.target.value as TimeRangePreset)}
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

            <CoachingPreferencesCard />
        </div>
    );
}
