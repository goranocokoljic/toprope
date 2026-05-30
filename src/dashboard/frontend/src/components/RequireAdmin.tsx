import {useContext, type ReactNode} from 'react';
import {Navigate} from 'react-router-dom';
import {AuthContext} from '../auth/authContext';

/**
 * Route guard for admin-only screens. Reads the auth context directly (rather
 * than via useAuth) so it renders harmlessly outside an AuthProvider in
 * isolated tests. Non-admins are redirected to the dashboard root; the API
 * enforces the same restriction server-side regardless.
 */
export function RequireAdmin({children}: {children: ReactNode}): JSX.Element {
    const auth = useContext(AuthContext);
    if (!auth || auth.user?.role !== 'admin') {
        return <Navigate to="/" replace />;
    }
    return <>{children}</>;
}
