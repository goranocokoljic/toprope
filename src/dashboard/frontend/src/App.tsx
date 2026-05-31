import {Navigate, Route, Routes} from 'react-router-dom';
import {AppShell} from './components/AppShell';
import {ManagerOverview} from './pages/ManagerOverview';
import {TeamsList} from './pages/TeamsList';
import {TeamDetail} from './pages/TeamDetail';
import {ComingSoon} from './pages/ComingSoon';
import {DeveloperDashboard} from './pages/DeveloperDashboard';
import {Preferences} from './pages/Preferences';
import {Settings} from './pages/Settings';
import {RequireAdmin} from './components/RequireAdmin';
import {NotFound} from './pages/NotFound';

/**
 * Route table. Several manager/developer areas are placeholders for now; the real
 * screens arrive in later Phase 2 tasks. The manager Waste route and the manager
 * developer-detail route are placeholders so the Teams screens' links resolve.
 * App expects to be rendered inside a router (BrowserRouter in main.tsx,
 * MemoryRouter in tests).
 */
export function App(): JSX.Element {
    return (
        <Routes>
            <Route element={<AppShell />}>
                <Route index element={<Navigate to="/manager" replace />} />
                <Route path="manager" element={<ManagerOverview />} />
                <Route path="manager/teams" element={<TeamsList />} />
                <Route path="manager/teams/:team" element={<TeamDetail />} />
                <Route
                    path="manager/developers/:id"
                    element={
                        <ComingSoon
                            title="Developer Detail"
                            description="Per-developer aggregate adoption — arrives in a later Phase 2 task."
                        />
                    }
                />
                <Route
                    path="manager/waste"
                    element={
                        <ComingSoon
                            title="Waste Detection"
                            description="Unused seats, duplicates, and underutilized subscriptions."
                        />
                    }
                />
                <Route path="developer" element={<DeveloperDashboard />} />
                <Route path="preferences" element={<Preferences />} />
                <Route
                    path="settings"
                    element={
                        <RequireAdmin>
                            <Settings />
                        </RequireAdmin>
                    }
                />
                <Route path="*" element={<NotFound />} />
            </Route>
        </Routes>
    );
}
