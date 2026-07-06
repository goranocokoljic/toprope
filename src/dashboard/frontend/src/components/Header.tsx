import {DarkModeToggle} from './DarkModeToggle';
import {Logo} from './Logo';

/**
 * App shell header: product logo + the dark-mode toggle. The toggle is
 * wired to the persisted user preference (see DarkModeToggle).
 */
export function Header(): JSX.Element {
    return (
        <header className="flex h-16 items-center justify-between border-b border-border bg-surface px-6">
            <div className="flex items-center gap-2">
                <Logo className="h-7" />
                <span className="rounded bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">beta</span>
            </div>
            <DarkModeToggle />
        </header>
    );
}
