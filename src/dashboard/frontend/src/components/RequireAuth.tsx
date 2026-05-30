import type {ReactNode} from 'react';
import {Navigate} from 'react-router-dom';
import {useAuth} from '../auth/useAuth';

/**
 * Route guard. Redirects to /login when there is no session, and to
 * /change-password when the session is flagged for a forced first-login change
 * (unless this is the change-password screen itself, via allowPasswordChange).
 */
export function RequireAuth({
    children,
    allowPasswordChange = false,
}: {
    children: ReactNode;
    allowPasswordChange?: boolean;
}): JSX.Element {
    const {user, loading} = useAuth();

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted">
                Loading…
            </div>
        );
    }

    if (!user) {
        return <Navigate to="/login" replace />;
    }

    if (user.must_change_password && !allowPasswordChange) {
        return <Navigate to="/change-password" replace />;
    }

    return <>{children}</>;
}
