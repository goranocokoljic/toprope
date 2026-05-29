import {NavLink} from 'react-router-dom';

interface NavItem {
    to: string;
    label: string;
    section: string;
}

// Placeholder navigation. The real manager/developer screens land in later
// Phase 2 tasks; these routes prove client-side routing works without a reload.
const NAV_ITEMS: NavItem[] = [
    {section: 'Manager', to: '/manager', label: 'Overview'},
    {section: 'Developer', to: '/developer', label: 'My Dashboard'},
];

export function Sidebar(): JSX.Element {
    return (
        <nav className="flex w-56 flex-col gap-6 border-r border-border bg-surface px-4 py-6">
            {NAV_ITEMS.map((item) => (
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
        </nav>
    );
}
