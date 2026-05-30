import {Outlet} from 'react-router-dom';
import {Header} from './Header';
import {Sidebar} from './Sidebar';
import {useApplyThemePreference} from '../theme/useApplyThemePreference';

/**
 * Basic app shell: header across the top, navigation on the left, routed
 * content in the main area. Screens render into <Outlet />.
 */
export function AppShell(): JSX.Element {
    // Drive the live theme from the user's persisted preference on load, so dark
    // mode follows the account across devices regardless of which screen opens.
    useApplyThemePreference();

    return (
        <div className="flex h-full flex-col">
            <Header />
            <div className="flex flex-1 overflow-hidden">
                <Sidebar />
                <main className="flex-1 overflow-y-auto px-8 py-6">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
