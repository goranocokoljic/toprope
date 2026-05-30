import {useEffect, useState} from 'react';
import {Card} from '../components/Card';
import {
    useGlobalSettings,
    useTeamNames,
    useTeamSettings,
    useUpdateGlobalSettings,
    useUpdateTeamSettings,
} from '../hooks/useSettings';
import type {GlobalSettings} from '../api/types';

type Field =
    | {key: keyof GlobalSettings; label: string; type: 'boolean'; teamOverridable: boolean}
    | {key: keyof GlobalSettings; label: string; type: 'number'; teamOverridable: boolean; step?: number};

// Display metadata for each setting, shared by the global and per-team panels.
const FIELDS: Field[] = [
    {key: 'leaderboard_enabled', label: 'Leaderboard enabled', type: 'boolean', teamOverridable: true},
    {
        key: 'leaderboard_managers_can_enable',
        label: 'Managers may enable leaderboard',
        type: 'boolean',
        teamOverridable: false,
    },
    {key: 'roi_threshold', label: 'ROI threshold', type: 'number', teamOverridable: true, step: 0.1},
    {key: 'roi_settling_days', label: 'ROI settling days', type: 'number', teamOverridable: true, step: 1},
    {
        key: 'roi_managers_can_override',
        label: 'Managers may override ROI',
        type: 'boolean',
        teamOverridable: false,
    },
];

function BooleanRow({
    label,
    checked,
    disabled,
    onChange,
}: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
}): JSX.Element {
    return (
        <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-foreground">{label}</span>
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="h-4 w-4 disabled:opacity-50"
            />
        </label>
    );
}

function NumberRow({
    label,
    value,
    step,
    disabled,
    onChange,
}: {
    label: string;
    value: number;
    step?: number;
    disabled?: boolean;
    onChange: (next: number) => void;
}): JSX.Element {
    return (
        <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-foreground">{label}</span>
            <input
                type="number"
                value={value}
                step={step}
                disabled={disabled}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-28 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
            />
        </label>
    );
}

function GlobalPanel(): JSX.Element {
    const {data, isPending, isError, error} = useGlobalSettings();
    const update = useUpdateGlobalSettings();
    const [draft, setDraft] = useState<GlobalSettings | null>(null);

    useEffect(() => {
        if (data) {
            setDraft(data);
        }
    }, [data]);

    if (isPending || !draft) {
        return <Card title="Global settings"><p className="text-sm text-muted">Loading…</p></Card>;
    }
    if (isError) {
        return (
            <Card title="Global settings">
                <p className="text-sm text-danger">Failed to load: {error.message}</p>
            </Card>
        );
    }

    return (
        <Card title="Global settings">
            <div className="space-y-4">
                {FIELDS.map((field) =>
                    field.type === 'boolean' ? (
                        <BooleanRow
                            key={field.key}
                            label={field.label}
                            checked={draft[field.key] as boolean}
                            onChange={(next) => setDraft({...draft, [field.key]: next})}
                        />
                    ) : (
                        <NumberRow
                            key={field.key}
                            label={field.label}
                            value={draft[field.key] as number}
                            step={field.step}
                            onChange={(next) => setDraft({...draft, [field.key]: next})}
                        />
                    ),
                )}
                <div className="flex items-center gap-3 pt-2">
                    <button
                        type="button"
                        onClick={() => update.mutate(draft)}
                        disabled={update.isPending}
                        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                    >
                        {update.isPending ? 'Saving…' : 'Save global settings'}
                    </button>
                    {update.isError ? (
                        <span className="text-sm text-danger">{update.error.message}</span>
                    ) : null}
                    {update.isSuccess ? <span className="text-sm text-muted">Saved.</span> : null}
                </div>
            </div>
        </Card>
    );
}

function TeamPanel(): JSX.Element {
    const {data: teamNames} = useTeamNames();
    const [team, setTeam] = useState<string | null>(null);
    const {data: settings} = useTeamSettings(team);
    const update = useUpdateTeamSettings(team ?? '');

    const overridableFields = FIELDS.filter((f) => f.teamOverridable);

    return (
        <Card title="Per-team settings">
            <div className="space-y-4">
                <label className="flex items-center gap-3">
                    <span className="text-sm text-foreground">Team</span>
                    <select
                        value={team ?? ''}
                        onChange={(e) => setTeam(e.target.value || null)}
                        className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                    >
                        <option value="">Select a team…</option>
                        {(teamNames ?? []).map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>

                {team && settings ? (
                    <div className="space-y-4">
                        <p className="text-xs text-muted">
                            Overrides apply only to settings whose global “managers may…” flag is on.
                            Disabled rows are governed by a flag that is currently off.
                        </p>
                        {overridableFields.map((field) => {
                            const allowed = settings.overridable[field.key];
                            const effective = settings.effective[field.key];
                            if (field.type === 'boolean') {
                                return (
                                    <div key={field.key}>
                                        <BooleanRow
                                            label={field.label}
                                            checked={effective as boolean}
                                            disabled={!allowed}
                                            onChange={(next) => update.mutate({[field.key]: next})}
                                        />
                                        {!allowed ? (
                                            <p className="text-xs text-muted">Override disabled by global policy.</p>
                                        ) : null}
                                    </div>
                                );
                            }
                            return (
                                <div key={field.key}>
                                    <NumberRow
                                        label={field.label}
                                        value={effective as number}
                                        step={field.step}
                                        disabled={!allowed}
                                        onChange={(next) => update.mutate({[field.key]: next})}
                                    />
                                    {!allowed ? (
                                        <p className="text-xs text-muted">Override disabled by global policy.</p>
                                    ) : null}
                                </div>
                            );
                        })}
                        {update.isError ? (
                            <p className="text-sm text-danger">{update.error.message}</p>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </Card>
    );
}

/**
 * Admin settings area (Task 2.16): global configuration plus per-team overrides.
 * Reached only by admins — the nav link and route are role-gated, and the API
 * rejects non-admins regardless.
 */
export function Settings(): JSX.Element {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
                <p className="mt-1 text-sm text-muted">
                    Global configuration and per-team overrides for the organization.
                </p>
            </div>
            <GlobalPanel />
            <TeamPanel />
        </div>
    );
}
