import type {UserRole} from '../api/types';

export interface NavItem {
    to: string;
    label: string;
}

export interface NavSection {
    title: string;
    items: NavItem[];
}

// Section catalog. Routes are limited to screens that exist today so the nav
// never renders a dead link; later Phase 2 tasks extend these lists.
const MANAGER_SECTION: NavSection = {
    title: 'Manager',
    items: [
        {to: '/manager', label: 'Overview'},
        {to: '/manager/teams', label: 'Teams'},
        {to: '/manager/waste', label: 'Waste'},
    ],
};
const DEVELOPER_SECTION: NavSection = {title: 'Developer', items: [{to: '/developer', label: 'My Dashboard'}]};
const ACCOUNT_SECTION: NavSection = {title: 'Account', items: [{to: '/preferences', label: 'Preferences'}]};
const ADMIN_SECTION: NavSection = {
    title: 'Admin',
    items: [
        {to: '/admin/users', label: 'Users'},
        {to: '/admin/teams', label: 'Teams'},
        {to: '/admin/identities', label: 'Identities'},
        {to: '/admin/subscriptions', label: 'Subscriptions'},
        {to: '/admin/data-sources', label: 'Data Sources'},
        {to: '/settings', label: 'Settings'},
    ],
};

/**
 * Build the nav for a role. Managers are modelled as admins in this codebase, so
 * an admin gets the manager + admin areas; a developer gets the developer area.
 * An unknown role (missing/garbled session, or the component rendered outside an
 * AuthProvider) fails CLOSED to the least-privileged developer view rather than
 * exposing the manager area — the server still enforces the real boundary, but
 * the nav shouldn't advertise screens an unknown principal may not reach.
 */
export function navSectionsForRole(role: UserRole | undefined): NavSection[] {
    if (role === 'admin') {
        return [MANAGER_SECTION, ADMIN_SECTION, ACCOUNT_SECTION];
    }
    return [DEVELOPER_SECTION, ACCOUNT_SECTION];
}
