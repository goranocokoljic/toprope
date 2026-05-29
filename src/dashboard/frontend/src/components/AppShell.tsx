import {Outlet} from 'react-router-dom';
import {Header} from './Header';
import {Sidebar} from './Sidebar';

/**
 * Basic app shell: header across the top, navigation on the left, routed
 * content in the main area. Screens render into <Outlet />.
 */
export function AppShell(): JSX.Element {
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
