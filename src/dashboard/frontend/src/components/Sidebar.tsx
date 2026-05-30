import {useContext} from 'react';
import {NavLink} from 'react-router-dom';
import {AuthContext} from '../auth/authContext';
import {UserMenu} from './UserMenu';

interface NavItem {
    to: string;
    label: string;
    section: string;
    adminOnly?: boolean;
}

// Placeholder navigation. The real manager/developer screens land in later
// Phase 2 tasks; these routes prove client-side routing works without a reload.
const NAV_ITEMS: NavItem[] = [
    {section: 'Manager', to: '/manager', label: 'Overview'},
    {section: 'Developer', to: '/developer', label: 'My Dashboard'},
    {section: 'Account', to: '/preferences', label: 'Preferences'},
    {section: 'Admin', to: '/settings', label: 'Settings', adminOnly: true},
];

export function Sidebar(): JSX.Element {
    // Read context directly (not useAuth) so the sidebar renders without an
    // AuthProvider in isolated tests; admin-only links are hidden when absent.
    const auth = useContext(AuthContext);
    const isAdmin = auth?.user?.role === 'admin';
    const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

    return (
        <nav className="flex w-56 flex-col gap-6 border-r border-border bg-surface px-4 py-6">
            {items.map((item) => (
                <div key={item.to}>
                    <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted">
                        {item.section}
                    </p>
                    <NavLink
                        to={item.to}
                        className={({isActive}) =>
                            [
                                'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                isActive
                                    ? 'bg-accent-soft text-accent'
                                    : 'text-muted hover:bg-surface-raised hover:text-foreground',
                            ].join(' ')
                        }
                    >
                        {item.label}
                    </NavLink>
                </div>
            ))}
            <div className="mt-auto">
                <UserMenu />
            </div>
        </nav>
    );
}
