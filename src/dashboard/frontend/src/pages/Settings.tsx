import {useEffect, useMemo, useState} from 'react';
import {Card} from '../components/Card';
import {
    useAnomalyConfig,
    useGlobalSettings,
    useTeamNames,
    useTeamSettings,
    useUpdateAnomalyConfig,
    useUpdateGlobalSettings,
    useUpdateTeamSettings,
} from '../hooks/useSettings';
import type {
    AnomalyConfigPatch,
    AnomalyMethod,
    GlobalSettings,
    MetricConfig,
} from '../api/types';

// A settings section groups related keys under a labeled subheading, so the
// global and per-team panels render Leaderboard / ROI / Surveys / Anomaly alerts
// as distinct blocks rather than one flat list (Task 4.12).
type Section = 'Leaderboard' | 'ROI' | 'Surveys' | 'Anomaly alerts' | 'Coaching' | 'Best Practices';

const SECTION_ORDER: Section[] = ['Leaderboard', 'ROI', 'Surveys', 'Anomaly alerts', 'Coaching', 'Best Practices'];

interface BaseField {
    key: keyof GlobalSettings;
    label: string;
    section: Section;
    teamOverridable: boolean;
}

type Field =
    | (BaseField & {type: 'boolean'})
    | (BaseField & {type: 'number'; step?: number})
    | (BaseField & {type: 'enum'; options: {value: string; label: string}[]});

// Display metadata for each setting, shared by the global and per-team panels.
// Order within a section is the render order; SECTION_ORDER controls section
// order. Keys mirror the backend registry (src/settings/registry.ts).
const FIELDS: Field[] = [
    {key: 'leaderboard_enabled', label: 'Leaderboard enabled', type: 'boolean', section: 'Leaderboard', teamOverridable: true},
    {
        key: 'leaderboard_managers_can_enable',
        label: 'Managers may enable leaderboard',
        type: 'boolean',
        section: 'Leaderboard',
        teamOverridable: false,
    },
    {key: 'roi_threshold', label: 'ROI threshold', type: 'number', section: 'ROI', teamOverridable: true, step: 0.1},
    {key: 'roi_settling_days', label: 'ROI settling days', type: 'number', section: 'ROI', teamOverridable: true, step: 1},
    {
        key: 'roi_managers_can_override',
        label: 'Managers may override ROI',
        type: 'boolean',
        section: 'ROI',
        teamOverridable: false,
    },
    {key: 'survey_usage_drop_auto', label: 'Auto-send: usage drop', type: 'boolean', section: 'Surveys', teamOverridable: true},
    {key: 'survey_unused_new_seat_auto', label: 'Auto-send: unused new seat', type: 'boolean', section: 'Surveys', teamOverridable: true},
    {key: 'survey_plan_change_auto', label: 'Auto-send: plan change', type: 'boolean', section: 'Surveys', teamOverridable: true},
    {key: 'survey_anomaly_auto', label: 'Auto-send: anomaly', type: 'boolean', section: 'Surveys', teamOverridable: true},
    {
        key: 'survey_managers_can_override',
        label: 'Managers may override survey auto-send',
        type: 'boolean',
        section: 'Surveys',
        teamOverridable: false,
    },
    {key: 'anomaly_alerts_enabled', label: 'Anomaly Slack alerts enabled', type: 'boolean', section: 'Anomaly alerts', teamOverridable: true},
    {
        key: 'anomaly_alert_min_severity',
        label: 'Alert severity floor',
        type: 'enum',
        section: 'Anomaly alerts',
        teamOverridable: true,
        options: [
            {value: 'notable', label: 'Notable & high'},
            {value: 'high', label: 'High only'},
        ],
    },
    {
        key: 'anomaly_managers_can_override',
        label: 'Managers may override anomaly settings',
        type: 'boolean',
        section: 'Anomaly alerts',
        teamOverridable: false,
    },
    // Coaching policy (Task 5.10): the org boundary for the Phase 5 coaching
    // features. Pillars/permissions/showcase/nudge defaults are per-team
    // overridable (gated by coaching_managers_can_override); the gate flag itself
    // is global-only.
    {key: 'coaching_pillar1_enabled', label: 'Available-data coaching (Pillar 1)', type: 'boolean', section: 'Coaching', teamOverridable: true},
    {key: 'coaching_pillar2_enabled', label: 'PR/review coaching (Pillar 2)', type: 'boolean', section: 'Coaching', teamOverridable: true},
    {key: 'coaching_capture_permitted', label: 'Permit prompt capture (Pillar 3)', type: 'boolean', section: 'Coaching', teamOverridable: true},
    {key: 'coaching_cloud_analysis_permitted', label: 'Permit cloud-model analysis', type: 'boolean', section: 'Coaching', teamOverridable: true},
    {key: 'showcase_enabled', label: 'Showcase enabled', type: 'boolean', section: 'Coaching', teamOverridable: true},
    {
        key: 'showcase_scope_permitted',
        label: 'Showcase sharing scope',
        type: 'enum',
        section: 'Coaching',
        teamOverridable: true,
        options: [
            {value: 'team_only', label: 'Team only'},
            {value: 'org_wide', label: 'Org-wide'},
        ],
    },
    {key: 'showcase_ai_annotation_enabled', label: 'Showcase AI annotation enabled', type: 'boolean', section: 'Coaching', teamOverridable: true},
    {
        key: 'nudge_default_frequency',
        label: 'Default nudge frequency',
        type: 'enum',
        section: 'Coaching',
        teamOverridable: true,
        options: [
            {value: 'low', label: 'Low'},
            {value: 'normal', label: 'Normal'},
            {value: 'high', label: 'High'},
        ],
    },
    {key: 'nudge_dismissible_default', label: 'Nudges dismissible by default', type: 'boolean', section: 'Coaching', teamOverridable: true},
    {
        key: 'coaching_managers_can_override',
        label: 'Managers may override coaching settings',
        type: 'boolean',
        section: 'Coaching',
        teamOverridable: false,
    },
    // Best Practices & curation (Task 6.4 / #173). The master switch, the per-team
    // contribution model, and who may curate — all overridable per team under the
    // same coaching_managers_can_override flag as the Coaching section above.
    {key: 'bestpractices_enabled', label: 'Best practices enabled', type: 'boolean', section: 'Best Practices', teamOverridable: true},
    {
        key: 'best_practice_contribution_model',
        label: 'Contribution model',
        type: 'enum',
        section: 'Best Practices',
        teamOverridable: true,
        options: [
            {value: 'top_down', label: 'Top-down (leads publish)'},
            {value: 'bottom_up', label: 'Bottom-up (anyone, feedback-ranked)'},
            {value: 'hybrid', label: 'Hybrid (anyone, lead-endorsed)'},
        ],
    },
    {
        key: 'curator_permission',
        label: 'Who may act as lead/curator',
        type: 'enum',
        section: 'Best Practices',
        teamOverridable: true,
        options: [
            {value: 'managers_admins', label: 'Managers & admins'},
            {value: 'any_member', label: 'Any member'},
        ],
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

function SelectRow({
    label,
    value,
    options,
    disabled,
    onChange,
}: {
    label: string;
    value: string;
    options: {value: string; label: string}[];
    disabled?: boolean;
    onChange: (next: string) => void;
}): JSX.Element {
    return (
        <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-foreground">{label}</span>
            <select
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
                className="w-40 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
            >
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

// Render one field bound to a draft. `disabled` + `note` cover the per-team case
// where a key's governing flag is off. Shared by the global and team panels so
// the two stay visually consistent.
function FieldRow({
    field,
    draft,
    disabled,
    note,
    onChange,
}: {
    field: Field;
    draft: GlobalSettings;
    disabled?: boolean;
    note?: string;
    onChange: (key: keyof GlobalSettings, value: boolean | number | string) => void;
}): JSX.Element {
    const row =
        field.type === 'boolean' ? (
            <BooleanRow
                label={field.label}
                checked={draft[field.key] as boolean}
                disabled={disabled}
                onChange={(next) => onChange(field.key, next)}
            />
        ) : field.type === 'number' ? (
            <NumberRow
                label={field.label}
                value={draft[field.key] as number}
                step={field.step}
                disabled={disabled}
                onChange={(next) => onChange(field.key, next)}
            />
        ) : (
            <SelectRow
                label={field.label}
                value={draft[field.key] as string}
                options={field.options}
                disabled={disabled}
                onChange={(next) => onChange(field.key, next)}
            />
        );
    return (
        <div>
            {row}
            {note ? <p className="text-xs text-muted">{note}</p> : null}
        </div>
    );
}

// Group fields into their sections, preserving SECTION_ORDER and dropping empty
// sections (used when the team panel filters to overridable keys only).
function groupBySection(fields: Field[]): {section: Section; fields: Field[]}[] {
    return SECTION_ORDER.map((section) => ({
        section,
        fields: fields.filter((f) => f.section === section),
    })).filter((g) => g.fields.length > 0);
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

    function onSave(): void {
        if (!draft) {
            return;
        }
        // Drop any number field left non-finite by an empty input, so clearing a
        // box and saving falls back to the stored value rather than triggering a
        // raw 400 from the server's finite-number check (mirrors TeamPanel).
        const patch: Partial<GlobalSettings> = {};
        for (const field of FIELDS) {
            const next = draft[field.key];
            if (field.type === 'number' && !Number.isFinite(next as number)) {
                continue;
            }
            (patch as Record<string, boolean | number | string>)[field.key] = next;
        }
        update.mutate(patch);
    }

    return (
        <Card title="Global settings">
            <div className="space-y-6">
                {groupBySection(FIELDS).map((group) => (
                    <section key={group.section} className="space-y-3">
                        <h3 className="text-sm font-semibold text-muted">{group.section}</h3>
                        {group.fields.map((field) => (
                            <FieldRow
                                key={field.key}
                                field={field}
                                draft={draft}
                                onChange={(key, value) => setDraft({...draft, [key]: value})}
                            />
                        ))}
                    </section>
                ))}
                <div className="flex items-center gap-3 pt-2">
                    <button
                        type="button"
                        onClick={onSave}
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

    // Stage edits locally and commit on Save, mirroring GlobalPanel. Binding
    // inputs straight to the server-resolved value and mutating per keystroke
    // makes the field fight the user (and fires a PATCH per character); a draft
    // avoids both. Re-seeded whenever the selected team's settings load/refresh.
    const [draft, setDraft] = useState<GlobalSettings | null>(null);
    useEffect(() => {
        setDraft(settings ? settings.effective : null);
    }, [settings]);

    function onSave(): void {
        if (!settings || !draft) {
            return;
        }
        // Send only overridable keys whose value actually changed, skipping any
        // non-finite number left by an empty input.
        const patch: Partial<GlobalSettings> = {};
        for (const field of overridableFields) {
            if (!settings.overridable[field.key]) {
                continue;
            }
            const next = draft[field.key];
            if (field.type === 'number' && !Number.isFinite(next as number)) {
                continue;
            }
            if (next !== settings.effective[field.key]) {
                (patch as Record<string, boolean | number | string>)[field.key] = next;
            }
        }
        if (Object.keys(patch).length > 0) {
            update.mutate(patch);
        }
    }

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

                {team && settings && draft ? (
                    <div className="space-y-6">
                        <p className="text-xs text-muted">
                            Overrides apply only to settings whose global “managers may…” flag is on.
                            Disabled rows are governed by a flag that is currently off.
                        </p>
                        {groupBySection(overridableFields).map((group) => (
                            <section key={group.section} className="space-y-3">
                                <h3 className="text-sm font-semibold text-muted">{group.section}</h3>
                                {group.fields.map((field) => {
                                    const allowed = settings.overridable[field.key];
                                    return (
                                        <FieldRow
                                            key={field.key}
                                            field={field}
                                            draft={draft}
                                            disabled={!allowed}
                                            note={!allowed ? 'Override disabled by global policy.' : undefined}
                                            onChange={(key, value) => setDraft({...draft, [key]: value})}
                                        />
                                    );
                                })}
                            </section>
                        ))}
                        <div className="flex items-center gap-3 pt-2">
                            <button
                                type="button"
                                onClick={onSave}
                                disabled={update.isPending}
                                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                            >
                                {update.isPending ? 'Saving…' : 'Save team overrides'}
                            </button>
                            {update.isError ? (
                                <span className="text-sm text-danger">{update.error.message}</span>
                            ) : null}
                            {update.isSuccess ? <span className="text-sm text-muted">Saved.</span> : null}
                        </div>
                    </div>
                ) : null}
            </div>
        </Card>
    );
}

const METHOD_OPTIONS: {value: AnomalyMethod; label: string}[] = [
    {value: 'statistical', label: 'Statistical (z-score)'},
    {value: 'percentage_change', label: 'Percentage change'},
];

/**
 * Anomaly Detection section (Task 4.12): the structured per-metric detection
 * config (method / threshold / baseline window) plus the global engine knobs
 * (minimum-baseline guard + statistical high-Z cutoff). Edits the GLOBAL config;
 * per-team anomaly overrides go through the API (gated by
 * anomaly_managers_can_override) and are not yet exposed here.
 */
function AnomalyDetectionPanel(): JSX.Element {
    const {data, isPending, isError, error} = useAnomalyConfig();
    const update = useUpdateAnomalyConfig();
    // Draft as a metric→config map for O(1) edits, re-seeded on load/refresh.
    const [metrics, setMetrics] = useState<Record<string, MetricConfig> | null>(null);
    const [engine, setEngine] = useState<{minBaselinePeriods: number; statisticalHighZ: number} | null>(null);

    useEffect(() => {
        if (data) {
            const map: Record<string, MetricConfig> = {};
            for (const m of data.metrics) {
                map[m.metric] = {...m.config};
            }
            setMetrics(map);
            setEngine({...data.engine});
        }
    }, [data]);

    const orderedMetrics = useMemo(() => data?.metrics.map((m) => m.metric) ?? [], [data]);

    if (isPending || !metrics || !engine || !data) {
        return <Card title="Anomaly detection"><p className="text-sm text-muted">Loading…</p></Card>;
    }
    if (isError) {
        return (
            <Card title="Anomaly detection">
                <p className="text-sm text-danger">Failed to load: {error.message}</p>
            </Card>
        );
    }

    function setMetricField(metric: string, patch: Partial<MetricConfig>): void {
        setMetrics((prev) => (prev ? {...prev, [metric]: {...prev[metric], ...patch}} : prev));
    }

    function onSave(): void {
        if (!metrics || !engine) {
            return;
        }
        const patch: AnomalyConfigPatch = {metrics: {}, engine: {}};
        for (const metric of orderedMetrics) {
            const c = metrics[metric];
            // Skip a metric whose numbers were cleared to non-finite — let it keep
            // its stored value rather than 400 on the finite-number check.
            if (!Number.isFinite(c.threshold) || !Number.isFinite(c.baselineWindow)) {
                continue;
            }
            patch.metrics![metric] = {
                method: c.method,
                threshold: c.threshold,
                baselineWindow: c.baselineWindow,
                ...(c.method === 'percentage_change' && c.percentageBaseline
                    ? {percentageBaseline: c.percentageBaseline}
                    : {}),
            };
        }
        if (Number.isFinite(engine.minBaselinePeriods) && Number.isFinite(engine.statisticalHighZ)) {
            patch.engine = {
                minBaselinePeriods: engine.minBaselinePeriods,
                statisticalHighZ: engine.statisticalHighZ,
            };
        }
        update.mutate(patch);
    }

    return (
        <Card title="Anomaly detection">
            <div className="space-y-6">
                <section className="space-y-3">
                    <h3 className="text-sm font-semibold text-muted">Engine</h3>
                    <NumberRow
                        label="Minimum baseline periods (early-weeks guard)"
                        value={engine.minBaselinePeriods}
                        step={1}
                        onChange={(next) => setEngine({...engine, minBaselinePeriods: next})}
                    />
                    <NumberRow
                        label="Statistical high-severity z-cutoff"
                        value={engine.statisticalHighZ}
                        step={0.1}
                        onChange={(next) => setEngine({...engine, statisticalHighZ: next})}
                    />
                </section>

                <section className="space-y-4">
                    <h3 className="text-sm font-semibold text-muted">Per-metric detection</h3>
                    {orderedMetrics.map((metric) => {
                        const c = metrics[metric];
                        return (
                            <div key={metric} className="space-y-2 rounded-md border border-border p-3">
                                <p className="text-sm font-medium text-foreground">{metric}</p>
                                <SelectRow
                                    label="Method"
                                    value={c.method}
                                    options={METHOD_OPTIONS}
                                    onChange={(next) => setMetricField(metric, {method: next as AnomalyMethod})}
                                />
                                <NumberRow
                                    label="Threshold"
                                    value={c.threshold}
                                    step={0.1}
                                    onChange={(next) => setMetricField(metric, {threshold: next})}
                                />
                                <NumberRow
                                    label="Baseline window (periods)"
                                    value={c.baselineWindow}
                                    step={1}
                                    onChange={(next) => setMetricField(metric, {baselineWindow: next})}
                                />
                            </div>
                        );
                    })}
                </section>

                <div className="flex items-center gap-3 pt-2">
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={update.isPending}
                        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                    >
                        {update.isPending ? 'Saving…' : 'Save anomaly config'}
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

/**
 * Admin settings area (Task 2.16, extended in 4.12): global configuration,
 * structured anomaly detection config, and per-team overrides. Reached only by
 * admins — the nav link and route are role-gated, and the API rejects non-admins
 * regardless.
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
            <AnomalyDetectionPanel />
            <TeamPanel />
        </div>
    );
}
