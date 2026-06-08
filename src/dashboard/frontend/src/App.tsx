import {Navigate, Route, Routes} from 'react-router-dom';
import {AppShell} from './components/AppShell';
import {ManagerOverview} from './pages/ManagerOverview';
import {TeamsList} from './pages/TeamsList';
import {TeamDetail} from './pages/TeamDetail';
import {TeamCompare} from './pages/TeamCompare';
import {TeamCompareTable} from './pages/TeamCompareTable';
import {WasteDetection} from './pages/WasteDetection';
import {Anomalies} from './pages/Anomalies';
import {ComingSoon} from './pages/ComingSoon';
import {DeveloperDashboard} from './pages/DeveloperDashboard';
import {MyTools} from './pages/MyTools';
import {MyActivity} from './pages/MyActivity';
import {Preferences} from './pages/Preferences';
import {Settings} from './pages/Settings';
import {Leaderboard} from './pages/Leaderboard';
import {RequireLeaderboard} from './components/RequireLeaderboard';
import {AdminUsers} from './pages/admin/AdminUsers';
import {AdminTeams} from './pages/admin/AdminTeams';
import {AdminIdentities} from './pages/admin/AdminIdentities';
import {AdminSubscriptions} from './pages/admin/AdminSubscriptions';
import {AdminReconciliation} from './pages/admin/AdminReconciliation';
import {AdminDataSources} from './pages/admin/AdminDataSources';
import {RequireAdmin} from './components/RequireAdmin';
import {NotFound} from './pages/NotFound';

/**
 * Route table. Several manager/developer areas are placeholders for now; the real
 * screens arrive in later Phase 2 tasks. The manager developer-detail route is a
 * placeholder so the Teams screens' links resolve. App expects to be rendered
 * inside a router (BrowserRouter in main.tsx, MemoryRouter in tests).
 */
export function App(): JSX.Element {
    return (
        <Routes>
            <Route element={<AppShell />}>
                <Route index element={<Navigate to="/manager" replace />} />
                <Route path="manager" element={<ManagerOverview />} />
                <Route path="manager/teams" element={<TeamsList />} />
                <Route path="manager/compare" element={<TeamCompare />} />
                <Route path="manager/rank-teams" element={<TeamCompareTable />} />
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
                <Route path="manager/waste" element={<WasteDetection />} />
                <Route path="manager/anomalies" element={<Anomalies />} />
                <Route
                    path="manager/leaderboard"
                    element={
                        <RequireLeaderboard>
                            <Leaderboard />
                        </RequireLeaderboard>
                    }
                />
                <Route path="developer" element={<DeveloperDashboard />} />
                <Route path="developer/tools" element={<MyTools />} />
                <Route path="developer/activity" element={<MyActivity />} />
                <Route path="preferences" element={<Preferences />} />
                <Route
                    path="settings"
                    element={
                        <RequireAdmin>
                            <Settings />
                        </RequireAdmin>
                    }
                />
                <Route
                    path="admin/users"
                    element={
                        <RequireAdmin>
                            <AdminUsers />
                        </RequireAdmin>
                    }
                />
                <Route
                    path="admin/teams"
                    element={
                        <RequireAdmin>
                            <AdminTeams />
                        </RequireAdmin>
                    }
                />
                <Route
                    path="admin/identities"
                    element={
                        <RequireAdmin>
                            <AdminIdentities />
                        </RequireAdmin>
                    }
                />
                <Route
                    path="admin/subscriptions"
                    element={
                        <RequireAdmin>
                            <AdminSubscriptions />
                        </RequireAdmin>
                    }
                />
                <Route
                    path="admin/reconciliation"
                    element={
                        <RequireAdmin>
                            <AdminReconciliation />
                        </RequireAdmin>
                    }
                />
                <Route
                    path="admin/data-sources"
                    element={
                        <RequireAdmin>
                            <AdminDataSources />
                        </RequireAdmin>
                    }
                />
                <Route path="*" element={<NotFound />} />
            </Route>
        </Routes>
    );
}
