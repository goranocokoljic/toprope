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
import type {GlobalSettings, TeamSettings, UserPreferences} from '../api/types';

const DEFAULT_PREFS: UserPreferences = {default_time_range: '30d', dark_mode: false};

const DEFAULT_GLOBAL: GlobalSettings = {
    leaderboard_enabled: false,
    leaderboard_managers_can_enable: false,
    roi_threshold: 3.0,
    roi_settling_days: 30,
    roi_managers_can_override: false,
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

        if (u.includes('/api/me/preferences')) {
            if (method === 'PATCH') {
                prefs = {...prefs, ...(bodyObj as Partial<UserPreferences>)};
            }
            return json({data: prefs});
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
        fireEvent.change(select, {target: {value: '7d'}});
        await waitFor(() => expect(prefs.default_time_range).toBe('7d'));
    });
});

describe('Settings page', () => {
    it('renders global settings loaded from the API', async () => {
        renderSettings();
        // Wait for the loaded form (the loading card shares the panel title).
        expect(await screen.findByText('ROI threshold')).toBeInTheDocument();
        expect(screen.getByText('Global settings')).toBeInTheDocument();
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
        const select = await screen.findByRole('combobox');
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
        const select = await screen.findByRole('combobox');
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
