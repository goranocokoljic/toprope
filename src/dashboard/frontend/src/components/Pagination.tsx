import {paginationRange} from './paginationRange';

export interface PaginationProps {
    /** 1-based current page. */
    page: number;
    /** Total number of pages. `<= 1` renders nothing. */
    pageCount: number;
    /** Called with the requested 1-based page; never fired for the current page or a disabled control. */
    onPageChange: (page: number) => void;
    /** Pages shown on each side of the current page. Default 1. */
    siblingCount?: number;
    /** Pages pinned at each end. Default 1. */
    boundaryCount?: number;
    /** Disables every control (e.g. while the underlying data is refetching). */
    disabled?: boolean;
    /** Show the First/Last jump buttons. Default true. */
    showFirstLast?: boolean;
    /** Accessible label for the surrounding `<nav>`. Default "Pagination". */
    ariaLabel?: string;
}

const CONTROL_CLASS =
    'min-w-9 rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50';

const ACTIVE_CLASS =
    'min-w-9 rounded-md border border-accent bg-accent-soft px-2.5 py-1.5 text-sm font-semibold text-accent';

/**
 * Presentational, accessible numbered pager. Purely a view over `page` /
 * `pageCount` — it owns no state; the caller (or the {@link usePagination}
 * hook / `DataTable`'s `pageSize`) owns the current page and clamps/resets it.
 * The window math lives in the pure {@link paginationRange} helper so the
 * algorithm is tested independently of this markup.
 *
 * First/Previous are disabled on the first page and Next/Last on the last;
 * disabled buttons are real `:disabled` (focusable-skip, not `aria-hidden`),
 * the active number carries `aria-current="page"`, and each ellipsis is an
 * inert `<span>` with no click handler. Renders nothing for a single page.
 */
export function Pagination({
    page,
    pageCount,
    onPageChange,
    siblingCount = 1,
    boundaryCount = 1,
    disabled = false,
    showFirstLast = true,
    ariaLabel = 'Pagination',
}: PaginationProps): JSX.Element | null {
    if (pageCount <= 1) return null;

    const current = Math.min(Math.max(Math.trunc(page), 1), pageCount);
    const tokens = paginationRange({page: current, pageCount, siblingCount, boundaryCount});
    const atStart = current <= 1;
    const atEnd = current >= pageCount;

    // Guarded so a disabled control or the current page never re-fires onPageChange.
    function go(target: number): void {
        if (disabled) return;
        const next = Math.min(Math.max(target, 1), pageCount);
        if (next !== current) onPageChange(next);
    }

    return (
        <nav aria-label={ariaLabel} className="flex flex-wrap items-center gap-1.5">
            {showFirstLast ? (
                <button
                    type="button"
                    className={CONTROL_CLASS}
                    onClick={() => go(1)}
                    disabled={disabled || atStart}
                    aria-label="First page"
                >
                    «
                </button>
            ) : null}
            <button
                type="button"
                className={CONTROL_CLASS}
                onClick={() => go(current - 1)}
                disabled={disabled || atStart}
                aria-label="Previous page"
            >
                ‹
            </button>
            {tokens.map((token, i) =>
                token === 'ellipsis' ? (
                    <span
                        key={`ellipsis-${i}`}
                        aria-hidden="true"
                        className="min-w-9 px-2.5 py-1.5 text-center text-sm text-muted"
                    >
                        …
                    </span>
                ) : (
                    <button
                        key={token}
                        type="button"
                        className={token === current ? ACTIVE_CLASS : CONTROL_CLASS}
                        onClick={() => go(token)}
                        disabled={disabled}
                        aria-current={token === current ? 'page' : undefined}
                        aria-label={`Page ${token}`}
                    >
                        {token}
                    </button>
                ),
            )}
            <button
                type="button"
                className={CONTROL_CLASS}
                onClick={() => go(current + 1)}
                disabled={disabled || atEnd}
                aria-label="Next page"
            >
                ›
            </button>
            {showFirstLast ? (
                <button
                    type="button"
                    className={CONTROL_CLASS}
                    onClick={() => go(pageCount)}
                    disabled={disabled || atEnd}
                    aria-label="Last page"
                >
                    »
                </button>
            ) : null}
        </nav>
    );
}
