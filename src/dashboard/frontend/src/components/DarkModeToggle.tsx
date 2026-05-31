import {useTheme} from '../theme/useTheme';
import {useUpdatePreferences} from '../hooks/usePreferences';

/**
 * Dark-mode toggle wired to the persisted preference. Flips the live theme
 * optimistically (so the UI responds instantly) and writes `dark_mode` back to
 * /api/me/preferences, rolling the theme back if that write fails — so what the
 * user sees never silently diverges from what's stored. Mirrors the Preferences
 * page control; placing it in the header makes the toggle reachable everywhere.
 */
export function DarkModeToggle(): JSX.Element {
    const {theme, setTheme} = useTheme();
    const update = useUpdatePreferences();
    const isDark = theme === 'dark';

    function toggle(): void {
        const previous = theme;
        const next = !isDark;
        setTheme(next ? 'dark' : 'light');
        update.mutate({dark_mode: next}, {onError: () => setTheme(previous)});
    }

    return (
        <button
            type="button"
            onClick={toggle}
            aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
        >
            {isDark ? 'Light' : 'Dark'} mode
        </button>
    );
}
