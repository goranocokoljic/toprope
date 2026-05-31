import {useMemo} from 'react';
import {useTheme} from '../theme/useTheme';
import type {Theme} from '../theme/themeContext';

/**
 * Recharts needs concrete color strings — it renders SVG presentation
 * attributes (`fill`, `stroke`), where CSS `var()` does not resolve. So instead
 * of hard-coding hex per chart, we resolve the design tokens to concrete `rgb()`
 * strings for the active theme.
 *
 * Production reads the live CSS variables off <html> via getComputedStyle, so
 * charts track any palette change in index.css with no duplication. jsdom does
 * not apply stylesheets, so getComputedStyle returns empty there; the FALLBACK
 * map (kept in sync with index.css) keeps tests deterministic. The hook keys off
 * the active theme, so toggling dark mode recomputes every color.
 */

type TokenName =
    | 'foreground'
    | 'muted'
    | 'border'
    | 'surface'
    | 'accent'
    | 'success'
    | 'warning'
    | 'danger';

// RGB channel triplets, mirroring src/index.css. Used only when the live CSS
// variable is unavailable (test env); production resolves the real variables.
const FALLBACK: Record<Theme, Record<TokenName, string>> = {
    light: {
        foreground: '15 23 42',
        muted: '100 116 139',
        border: '226 232 240',
        surface: '255 255 255',
        accent: '79 70 229',
        success: '22 163 74',
        warning: '217 119 6',
        danger: '220 38 38',
    },
    dark: {
        foreground: '226 232 240',
        muted: '148 163 184',
        border: '30 41 59',
        surface: '17 24 39',
        accent: '129 140 248',
        success: '34 197 94',
        warning: '245 158 11',
        danger: '248 113 113',
    },
};

function readTriplet(token: TokenName, theme: Theme): string {
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const raw = window.getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim();
        if (raw) {
            return raw;
        }
    }
    return FALLBACK[theme][token];
}

export interface ChartTheme {
    foreground: string;
    muted: string;
    border: string;
    surface: string;
    accent: string;
    success: string;
    warning: string;
    danger: string;
    /** Faint grid lines — muted at low opacity. */
    grid: string;
    /** Categorical palette for multi-series and distribution slices. */
    series: string[];
}

/**
 * The resolved chart palette for the active theme. Memoised per theme so charts
 * don't recompute on every render, only when the theme actually flips.
 */
export function useChartTheme(): ChartTheme {
    const {theme} = useTheme();
    return useMemo<ChartTheme>(() => {
        const token = (name: TokenName): string => `rgb(${readTriplet(name, theme)})`;
        const muted = readTriplet('muted', theme);
        return {
            foreground: token('foreground'),
            muted: token('muted'),
            border: token('border'),
            surface: token('surface'),
            accent: token('accent'),
            success: token('success'),
            warning: token('warning'),
            danger: token('danger'),
            grid: `rgb(${muted} / 0.2)`,
            // A distinct, legible categorical ramp (indigo, sky, emerald, amber,
            // violet, rose) that reads clearly on both canvases.
            series:
                theme === 'dark'
                    ? ['rgb(129 140 248)', 'rgb(56 189 248)', 'rgb(52 211 153)', 'rgb(251 191 36)', 'rgb(196 181 253)', 'rgb(251 113 133)']
                    : ['rgb(79 70 229)', 'rgb(2 132 199)', 'rgb(5 150 105)', 'rgb(217 119 6)', 'rgb(124 58 237)', 'rgb(225 29 72)'],
        };
    }, [theme]);
}
