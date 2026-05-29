import {useTheme} from '../theme/useTheme';

/**
 * App shell header: product wordmark + a theme toggle. The toggle is wired to
 * the programmatic theme control now; its final placement/visual design is
 * refined in task 2.10.
 */
export function Header(): JSX.Element {
    const {theme, toggleTheme} = useTheme();

    return (
        <header className="flex h-16 items-center justify-between border-b border-border bg-surface px-6">
            <div className="flex items-center gap-2">
                <span className="font-display text-lg font-semibold tracking-tight text-foreground">GovProxy</span>
                <span className="rounded bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">beta</span>
            </div>
            <button
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
            >
                {theme === 'dark' ? 'Light' : 'Dark'} mode
            </button>
        </header>
    );
}
