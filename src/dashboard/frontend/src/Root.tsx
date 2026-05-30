import {Route, Routes} from 'react-router-dom';
import {AuthProvider} from './auth/AuthProvider';
import {RequireAuth} from './components/RequireAuth';
import {Login} from './pages/Login';
import {ChangePassword} from './pages/ChangePassword';
import {App} from './App';

/**
 * Top-level authenticated shell. Wraps the app in the auth provider and routes
 * the public login / forced password-change screens around the auth-guarded
 * application (App), which holds the manager and developer areas.
 */
export function Root(): JSX.Element {
    return (
        <AuthProvider>
            <Routes>
                <Route path="/login" element={<Login />} />
                <Route
                    path="/change-password"
                    element={
                        <RequireAuth allowPasswordChange>
                            <ChangePassword />
                        </RequireAuth>
                    }
                />
                <Route
                    path="/*"
                    element={
                        <RequireAuth>
                            <App />
                        </RequireAuth>
                    }
                />
            </Routes>
        </AuthProvider>
    );
}
