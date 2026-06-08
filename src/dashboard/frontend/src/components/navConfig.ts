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
const MANAGER_ITEMS: NavItem[] = [
    {to: '/manager', label: 'Overview'},
    {to: '/manager/teams', label: 'Teams'},
    {to: '/manager/waste', label: 'Waste'},
    {to: '/manager/anomalies', label: 'Anomalies'},
];
// Appended to the manager section ONLY when the leaderboard is available
// (Task 2.17). The leaderboard ships off by default; when off it must leave no
// trace, so the nav entry is omitted entirely rather than rendered-and-blocked.
const LEADERBOARD_ITEM: NavItem = {to: '/manager/leaderboard', label: 'Leaderboard'};
const DEVELOPER_SECTION: NavSection = {
    title: 'Developer',
    items: [
        {to: '/developer', label: 'My Dashboard'},
        {to: '/developer/tools', label: 'My Tools'},
        {to: '/developer/activity', label: 'My Activity'},
    ],
};
const ACCOUNT_SECTION: NavSection = {title: 'Account', items: [{to: '/preferences', label: 'Preferences'}]};
const ADMIN_SECTION: NavSection = {
    title: 'Admin',
    items: [
        {to: '/admin/users', label: 'Users'},
        {to: '/admin/teams', label: 'Teams'},
        {to: '/admin/identities', label: 'Identities'},
        {to: '/admin/subscriptions', label: 'Subscriptions'},
        {to: '/admin/reconciliation', label: 'Reconciliation'},
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
 *
 * `leaderboardAvailable` (Task 2.17) gates the optional leaderboard entry: it is
 * appended to the manager section only when true. Defaults to false so the
 * feature stays invisible until availability has been confirmed.
 */
export function navSectionsForRole(
    role: UserRole | undefined,
    leaderboardAvailable = false,
): NavSection[] {
    if (role === 'admin') {
        const managerItems = leaderboardAvailable
            ? [...MANAGER_ITEMS, LEADERBOARD_ITEM]
            : MANAGER_ITEMS;
        return [{title: 'Manager', items: managerItems}, ADMIN_SECTION, ACCOUNT_SECTION];
    }
    return [DEVELOPER_SECTION, ACCOUNT_SECTION];
}
