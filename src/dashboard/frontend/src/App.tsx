import {Navigate, Route, Routes} from 'react-router-dom';
import {AppShell} from './components/AppShell';
import {ManagerOverview} from './pages/ManagerOverview';
import {DeveloperDashboard} from './pages/DeveloperDashboard';
import {NotFound} from './pages/NotFound';

/**
 * Route table. Manager and developer areas are placeholders for now; the real
 * screens arrive in later Phase 2 tasks. App expects to be rendered inside a
 * router (BrowserRouter in main.tsx, MemoryRouter in tests).
 */
export function App(): JSX.Element {
    return (
        <Routes>
            <Route element={<AppShell />}>
                <Route index element={<Navigate to="/manager" replace />} />
                <Route path="manager" element={<ManagerOverview />} />
                <Route path="developer" element={<DeveloperDashboard />} />
                <Route path="*" element={<NotFound />} />
            </Route>
        </Routes>
    );
}
