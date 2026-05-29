import {createContext} from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'govproxy-theme';

export interface ThemeContextValue {
    theme: Theme;
    /**
     * Set an explicit theme. Used by `toggleTheme` today, and the API a future
     * settings screen (Task 2.16) calls to apply a persisted per-user dark-mode
     * preference on load.
     */
    setTheme: (theme: Theme) => void;
    toggleTheme: () => void;
}

// Kept in its own module (separate from ThemeProvider) so the provider file
// exports only a component — required for React Fast Refresh to work.
export const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);
