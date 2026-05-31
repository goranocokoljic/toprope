import {useContext} from 'react';
import {NavLink} from 'react-router-dom';
import {AuthContext} from '../auth/authContext';
import {navSectionsForRole} from './navConfig';
import {UserMenu} from './UserMenu';

export function Sidebar(): JSX.Element {
    // Read context directly (not useAuth) so the sidebar renders without an
    // AuthProvider in isolated tests.
    const auth = useContext(AuthContext);
    const sections = navSectionsForRole(auth?.user?.role);

    return (
        <nav className="flex w-56 flex-col gap-6 border-r border-border bg-surface px-4 py-6">
            {sections.map((section) => (
                <div key={section.title}>
                    <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted">
                        {section.title}
                    </p>
                    <div className="space-y-1">
                        {section.items.map((item) => (
                            <NavLink
                                key={item.to}
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
                        ))}
                    </div>
                </div>
            ))}
            <div className="mt-auto">
                <UserMenu />
            </div>
        </nav>
    );
}
