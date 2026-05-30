import {useCallback, useEffect, useMemo, useState, type ReactNode} from 'react';
import {ThemeContext, THEME_STORAGE_KEY as STORAGE_KEY, type Theme, type ThemeContextValue} from './themeContext';

function resolveInitialTheme(): Theme {
    if (typeof window === 'undefined') {
        return 'light';
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
        return stored;
    }
    if (typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
}

function applyThemeClass(theme: Theme): void {
    if (typeof document === 'undefined') {
        return;
    }
    document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Wires dark-mode infrastructure: tracks the active theme, persists the user's
 * choice, and toggles the `dark` class on <html> (which flips every design
 * token in index.css). The visible toggle UI lands in task 2.10 — this just
 * exposes a programmatic `toggleTheme` that the wiring (and tests) can drive.
 */
export function ThemeProvider({children}: {children: ReactNode}): JSX.Element {
    const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

    useEffect(() => {
        applyThemeClass(theme);
    }, [theme]);

    const setTheme = useCallback((next: Theme) => {
        if (typeof window !== 'undefined') {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
        setThemeState(next);
    }, []);

    const toggleTheme = useCallback(() => {
        setThemeState((current) => {
            const next = current === 'dark' ? 'light' : 'dark';
            if (typeof window !== 'undefined') {
                window.localStorage.setItem(STORAGE_KEY, next);
            }
            return next;
        });
    }, []);

    const value = useMemo<ThemeContextValue>(
        () => ({theme, toggleTheme, setTheme}),
        [theme, toggleTheme, setTheme],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
