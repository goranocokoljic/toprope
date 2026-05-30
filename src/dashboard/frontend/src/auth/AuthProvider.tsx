import {useCallback, useEffect, useMemo, useState, type ReactNode} from 'react';
import {api} from '../api/client';
import type {AuthUser} from '../api/types';
import {AuthContext, type AuthContextValue} from './authContext';

/**
 * Loads the current session on mount (GET /api/auth/me) and exposes login,
 * logout, and change-password actions. The resolved `user` (or null) drives the
 * auth-guarded routing in Root.
 */
export function AuthProvider({children}: {children: ReactNode}): JSX.Element {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async (): Promise<void> => {
        const me = await api.getMe();
        setUser(me);
    }, []);

    useEffect(() => {
        let active = true;
        void (async () => {
            try {
                if (active) {
                    await refresh();
                }
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        })();
        return () => {
            active = false;
        };
    }, [refresh]);

    const login = useCallback(
        async (email: string, password: string): Promise<void> => {
            await api.login(email, password);
            await refresh();
        },
        [refresh],
    );

    const logout = useCallback(async (): Promise<void> => {
        await api.logout();
        setUser(null);
    }, []);

    const changePassword = useCallback(
        async (currentPassword: string, newPassword: string): Promise<void> => {
            await api.changePassword(currentPassword, newPassword);
            await refresh();
        },
        [refresh],
    );

    const value = useMemo<AuthContextValue>(
        () => ({user, loading, login, logout, changePassword}),
        [user, loading, login, logout, changePassword],
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
