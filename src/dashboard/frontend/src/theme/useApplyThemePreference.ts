import {useEffect, useRef} from 'react';
import {usePreferences} from '../hooks/usePreferences';
import {useTheme} from './useTheme';

/**
 * Applies the logged-in user's persisted `dark_mode` preference to the live
 * theme once, on first successful load. A ref guards against re-applying on
 * every render/refetch so the user can still flip the theme afterward without it
 * snapping back.
 *
 * Mounted at the app shell so the stored preference drives the *whole* dashboard
 * the moment it loads — not only the Preferences screen — which is what makes
 * the choice authoritative across devices/sessions rather than deferring to
 * whatever `localStorage` holds on a fresh browser.
 */
export function useApplyThemePreference(): void {
    const {data} = usePreferences();
    const {setTheme} = useTheme();
    const applied = useRef(false);

    useEffect(() => {
        if (data && !applied.current) {
            applied.current = true;
            setTheme(data.dark_mode ? 'dark' : 'light');
        }
    }, [data, setTheme]);
}
