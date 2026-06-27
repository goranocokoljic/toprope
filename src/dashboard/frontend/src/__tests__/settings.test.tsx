// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {Preferences} from '../pages/Preferences';
import {Settings} from '../pages/Settings';
import {ThemeProvider} from '../theme/ThemeProvider';
import type {
    AnomalyConfig,
    CoachingPreferences,
    GlobalSettings,
    TeamSettings,
    UserPreferences,
} from '../api/types';

const DEFAULT_PREFS: UserPreferences = {default_time_range: '30d', dark_mode: false};

// Coaching prefs with capture/cloud blocked by org policy (the default org
// posture), so the card renders its controls disabled with the org's reason.
function defaultCoachingPrefs(): CoachingPreferences {
    return {
        capture_opt_in: {
            key: 'capture_opt_in',
            value: false,
            stored: false,
            blocked: true,
            reason: 'Prompt capture is not permitted by your organization.',
        },
        capture_mechanism: {
            key: 'capture_mechanism',
            value: 'local_agent',
            stored: 'local_agent',
            blocked: true,
            reason: 'Prompt capture is not permitted by your organization.',
        },
        capture_recovery_choice: {
            key: 'capture_recovery_choice',
            value: 'no_recovery',
            stored: 'no_recovery',
            blocked: true,
            reason: 'Prompt capture is not permitted by your organization.',
        },
        cloud_analysis_opt_in: {
            key: 'cloud_analysis_opt_in',
            value: false,
            stored: false,
            blocked: true,
            reason: 'Cloud-model analysis is not permitted by your organization.',
        },
        nudges_enabled: {key: 'nudges_enabled', value: true, stored: true, blocked: false},
        nudge_frequency: {key: 'nudge_frequency', value: 'normal', stored: 'normal', blocked: false},
    };
}

const DEFAULT_GLOBAL: GlobalSettings = {
    leaderboard_enabled: false,
    leaderboard_managers_can_enable: false,
    roi_threshold: 3.0,
    roi_settling_days: 30,
    roi_managers_can_override: false,
    survey_usage_drop_auto: false,
    survey_unused_new_seat_auto: false,
    survey_plan_change_auto: false,
    survey_anomaly_auto: false,
    survey_managers_can_override: false,
    anomaly_alerts_enabled: false,
    anomaly_alert_min_severity: 'notable',
    anomaly_managers_can_override: false,
    coaching_pillar1_enabled: true,
    coaching_pillar2_enabled: true,
    coaching_capture_permitted: false,
    coaching_cloud_analysis_permitted: false,
    showcase_enabled: false,
    showcase_scope_permitted: 'team_only',
    showcase_ai_annotation_enabled: false,
    nudge_default_frequency: 'normal',
    nudge_dismissible_default: true,
    coaching_managers_can_override: false,
    best_practice_contribution_model: 'top_down',
    bestpractices_enabled: true,
    curator_permission: 'managers_admins',
};

// Minimal effective anomaly config for the AnomalyDetectionPanel fetch.
const DEFAULT_ANOMALY: AnomalyConfig = {
    metrics: [
        {
            metric: 'commits',
            scopes: ['developer', 'team'],
            basis: 'git_estimate',
            config: {method: 'statistical', threshold: 2, baselineWindow: 8},
        },
    ],
    engine: {minBaselinePeriods: 4, statisticalHighZ: 2.5},
};

let prefs: UserPreferences;
let global: GlobalSettings;
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

function teamSettings(): TeamSettings {
    return {
        team: 'frontend',
        effective: global,
        overrides: {},
        overridable: {
            leaderboard_enabled: global.leaderboard_managers_can_enable,
            leaderboard_managers_can_enable: false,
            roi_threshold: global.roi_managers_can_override,
            roi_settling_days: global.roi_managers_can_override,
            roi_managers_can_override: false,
            survey_usage_drop_auto: global.survey_managers_can_override,
            survey_unused_new_seat_auto: global.survey_managers_can_override,
            survey_plan_change_auto: global.survey_managers_can_override,
            survey_anomaly_auto: global.survey_managers_can_override,
            anomaly_alerts_enabled: global.anomaly_managers_can_override,
            anomaly_alert_min_severity: global.anomaly_managers_can_override,
            // Phase 6 (Task 6.4): the master switch and curator permission are gated
            // by coaching_managers_can_override; the contribution model is always
            // team-switchable (no governing flag), mirroring the backend registry.
            bestpractices_enabled: global.coaching_managers_can_override,
            best_practice_contribution_model: true,
            curator_permission: global.coaching_managers_can_override,
        },
    };
}

beforeEach(() => {
    prefs = {...DEFAULT_PREFS};
    global = {...DEFAULT_GLOBAL};
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const bodyObj = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (u.includes('/api/me/coaching-preferences')) {
            return json({data: defaultCoachingPrefs()});
        }
        if (u.includes('/api/me/preferences')) {
            if (method === 'PATCH') {
                prefs = {...prefs, ...(bodyObj as Partial<UserPreferences>)};
            }
            return json({data: prefs});
        }
        if (u.includes('/api/settings/anomaly')) {
            return json({data: DEFAULT_ANOMALY});
        }
        if (u.includes('/api/settings/global')) {
            if (method === 'PATCH') {
                global = {...global, ...(bodyObj as Partial<GlobalSettings>)};
            }
            return json({data: global});
        }
        if (u.includes('/api/settings/team/')) {
            return json({data: teamSettings()});
        }
        if (u.includes('/api/teams')) {
            const data = [{name: 'frontend'}, {name: 'backend'}];
            return json({data, pagination: {page: 1, limit: 100, total: data.length}});
        }
        return json({error: 'not found'}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

function renderPrefs(): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter>
                    <Preferences />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function renderSettings(): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter>
                    <Settings />
                </MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

describe('Preferences page', () => {
    it('toggling dark mode persists the preference and drives the theme', async () => {
        renderPrefs();
        const toggle = await screen.findByRole('switch', {name: /dark mode/i});
        expect(document.documentElement.classList.contains('dark')).toBe(false);

        fireEvent.click(toggle);

        expect(document.documentElement.classList.contains('dark')).toBe(true);
        await waitFor(() => {
            const patched = fetchMock.mock.calls.some(
                (c) =>
                    String(c[0]).includes('/api/me/preferences') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
            );
            expect(patched).toBe(true);
        });
        expect(prefs.dark_mode).toBe(true);
    });

    it('applies a persisted dark_mode preference on load', async () => {
        prefs = {...DEFAULT_PREFS, dark_mode: true};
        renderPrefs();
        await waitFor(() =>
            expect(document.documentElement.classList.contains('dark')).toBe(true),
        );
    });

    it('changing the default time range persists it', async () => {
        renderPrefs();
        const select = (await screen.findByLabelText(/default time range/i)) as HTMLSelectElement;
        fireEvent.change(select, {target: {value: 'year'}});
        await waitFor(() => expect(prefs.default_time_range).toBe('year'));
    });

    it('shows coaching preferences and disables ones the org policy blocks', async () => {
        renderPrefs();
        // The capture opt-in switch is rendered but disabled, with the org reason.
        const capture = (await screen.findByRole('switch', {name: /capture my prompts/i})) as HTMLInputElement;
        expect(capture).toBeDisabled();
        expect(
            screen.getAllByText(/Prompt capture is not permitted by your organization/i).length,
        ).toBeGreaterThan(0);
        // A non-blocked preference (real-time nudges) stays enabled.
        const nudges = (await screen.findByRole('switch', {name: /real-time nudges/i})) as HTMLInputElement;
        expect(nudges).not.toBeDisabled();
    });
});

describe('Settings page', () => {
    it('renders global settings loaded from the API', async () => {
        renderSettings();
        // Wait for the loaded form (the loading card shares the panel title).
        expect(await screen.findByText('ROI threshold')).toBeInTheDocument();
        expect(screen.getByText('Global settings')).toBeInTheDocument();
    });

    it('renders the Phase 6 Best Practices section and its settings (Task 6.4)', async () => {
        renderSettings();
        // The new section heading and its three controls are present in the global panel.
        expect(await screen.findByText('Best Practices')).toBeInTheDocument();
        expect(screen.getByText('Best practices enabled')).toBeInTheDocument();
        expect(screen.getByText('Contribution model')).toBeInTheDocument();
        expect(screen.getByText('Who may act as lead/curator')).toBeInTheDocument();
        // The showcase AI-annotation toggle is now surfaced too.
        expect(screen.getByText('Showcase AI annotation enabled')).toBeInTheDocument();
    });

    it('saves a Best Practices global change via the standard panel PATCH (Task 6.4)', async () => {
        renderSettings();
        // The contribution-model select is the Best Practices enum; switch it and save.
        const select = (await screen.findByLabelText('Contribution model')) as HTMLSelectElement;
        fireEvent.change(select, {target: {value: 'hybrid'}});
        fireEvent.click(screen.getByRole('button', {name: /save global settings/i}));
        await waitFor(() => {
            const patch = fetchMock.mock.calls.find(
                (c) =>
                    String(c[0]).includes('/api/settings/global') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
            );
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            expect(sent.best_practice_contribution_model).toBe('hybrid');
        });
    });

    it('clearing a global number field saves cleanly (no error, finite value sent)', async () => {
        renderSettings();
        // The global ROI threshold spinbutton is the first instance (no team yet).
        const input = (await screen.findByRole('spinbutton', {name: /roi threshold/i})) as HTMLInputElement;
        // Emptying a number input coerces to 0 (finite) via Number(''), so the
        // panel must send a valid value rather than a NaN the server would 400.
        fireEvent.change(input, {target: {value: ''}});
        fireEvent.click(screen.getByRole('button', {name: /save global settings/i}));

        await waitFor(() => {
            const patch = fetchMock.mock.calls.find(
                (c) =>
                    String(c[0]).includes('/api/settings/global') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
            );
            expect(patch).toBeTruthy();
            const sent = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
            // Whatever is sent for roi_threshold is a finite number, never NaN/null.
            if ('roi_threshold' in sent) {
                expect(Number.isFinite(sent.roi_threshold as number)).toBe(true);
            }
        });
        // The save succeeds — no server-error text surfaces.
        expect(screen.queryByText(/must be a finite number/i)).not.toBeInTheDocument();
    });

    it('disables a team override row when the governing flag is off', async () => {
        renderSettings();
        const select = await screen.findByRole('combobox', {name: 'Team'});
        // The team options arrive asynchronously; wait before selecting so the
        // value actually takes (a select rejects values with no matching option).
        await screen.findByRole('option', {name: 'frontend'});
        fireEvent.change(select, {target: {value: 'frontend'}});

        // roi_threshold override row should be present but disabled, with the
        // policy note, because roi_managers_can_override is false.
        await waitFor(() => expect(screen.getAllByText(/Override disabled by global policy/i).length).toBeGreaterThan(0));
    });

    it('edits a team override via draft + Save (one PATCH on Save, not per keystroke)', async () => {
        // Enable the governing flag so the roi_threshold row is editable.
        global = {...DEFAULT_GLOBAL, roi_managers_can_override: true};
        renderSettings();
        const select = await screen.findByRole('combobox', {name: 'Team'});
        await screen.findByRole('option', {name: 'frontend'});
        fireEvent.change(select, {target: {value: 'frontend'}});

        // The ROI threshold spinbutton is enabled; editing it must not PATCH yet.
        // The label appears in both panels (global first, team second) — wait for
        // the team row to mount, then take the team panel's (last) instance.
        await waitFor(() =>
            expect(screen.getAllByRole('spinbutton', {name: /roi threshold/i}).length).toBe(2),
        );
        const inputs = screen.getAllByRole('spinbutton', {name: /roi threshold/i});
        const input = inputs[inputs.length - 1] as HTMLInputElement;
        fireEvent.change(input, {target: {value: '6'}});
        const patchesBeforeSave = fetchMock.mock.calls.filter(
            (c) =>
                String(c[0]).includes('/api/settings/team/') &&
                (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
        ).length;
        expect(patchesBeforeSave).toBe(0);

        fireEvent.click(screen.getByRole('button', {name: /save team overrides/i}));
        await waitFor(() => {
            const patch = fetchMock.mock.calls.find(
                (c) =>
                    String(c[0]).includes('/api/settings/team/frontend') &&
                    (c[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
            );
            expect(patch).toBeTruthy();
            expect(JSON.parse(String(patch?.[1]?.body))).toEqual({roi_threshold: 6});
        });
    });
});
