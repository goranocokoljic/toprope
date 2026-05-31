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
const MANAGER_SECTION: NavSection = {title: 'Manager', items: [{to: '/manager', label: 'Overview'}]};
const DEVELOPER_SECTION: NavSection = {title: 'Developer', items: [{to: '/developer', label: 'My Dashboard'}]};
const ACCOUNT_SECTION: NavSection = {title: 'Account', items: [{to: '/preferences', label: 'Preferences'}]};
const ADMIN_SECTION: NavSection = {title: 'Admin', items: [{to: '/settings', label: 'Settings'}]};

/**
 * Build the nav for a role. Managers are modelled as admins in this codebase, so
 * an admin gets the manager + admin areas; a developer gets the developer area.
 * When the role is unknown (component rendered outside an AuthProvider, e.g. in
 * isolated tests) we show both non-admin areas so the shell is still navigable.
 */
export function navSectionsForRole(role: UserRole | undefined): NavSection[] {
    if (role === 'admin') {
        return [MANAGER_SECTION, ADMIN_SECTION, ACCOUNT_SECTION];
    }
    if (role === 'developer') {
        return [DEVELOPER_SECTION, ACCOUNT_SECTION];
    }
    return [MANAGER_SECTION, DEVELOPER_SECTION, ACCOUNT_SECTION];
}
