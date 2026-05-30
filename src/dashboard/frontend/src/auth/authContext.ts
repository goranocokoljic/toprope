import {createContext} from 'react';
import type {AuthUser} from '../api/types';

export interface AuthContextValue {
    user: AuthUser | null;
    // True while the initial /api/auth/me check is in flight.
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
    changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

// Kept in its own module (separate from AuthProvider) so the provider file
// exports only a component — required for React Fast Refresh.
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
