import {createContext} from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'toprope-theme';

export interface ThemeContextValue {
    theme: Theme;
    toggleTheme: () => void;
    // Set the theme explicitly (used to apply a persisted user preference).
    setTheme: (theme: Theme) => void;
}

// Kept in its own module (separate from ThemeProvider) so the provider file
// exports only a component — required for React Fast Refresh to work.
export const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);
