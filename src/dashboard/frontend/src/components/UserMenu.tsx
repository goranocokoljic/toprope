import {useContext, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {AuthContext} from '../auth/authContext';

/**
 * Shows the signed-in user's email and a logout control. Reads the auth context
 * directly (rather than via useAuth) so it renders harmlessly as null when
 * mounted outside an AuthProvider — e.g. in isolated component tests.
 */
export function UserMenu(): JSX.Element | null {
    const auth = useContext(AuthContext);
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);

    if (!auth || !auth.user) {
        return null;
    }

    async function onLogout(): Promise<void> {
        if (!auth) {
            return;
        }
        setBusy(true);
        try {
            await auth.logout();
            navigate('/login', {replace: true});
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-2 border-t border-border pt-4">
            <p className="truncate px-2 text-xs text-muted" title={auth.user.email}>
                {auth.user.email}
            </p>
            <button
                type="button"
                onClick={onLogout}
                disabled={busy}
                className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-60"
            >
                Log out
            </button>
        </div>
    );
}
