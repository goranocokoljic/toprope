import {paginationRange} from './paginationRange';
import {isPaginationVisible, type PageSizeOption} from './usePagination';

export interface PaginationProps {
    /** 1-based current page. */
    page: number;
    /** Total number of pages. `<= 1` renders nothing (unless the size selector is shown). */
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
    /** Accessible label for the numbered pager's `<nav>`. Default "Pagination". */
    ariaLabel?: string;
    /**
     * Current rows-per-page choice. Provide together with `onPageSizeChange` to
     * render the "rows per page" selector alongside the numbered pager.
     */
    pageSize?: PageSizeOption;
    /** Selectable rows-per-page sizes for the selector. */
    pageSizeOptions?: readonly PageSizeOption[];
    /**
     * Called with the newly chosen size. Its presence (with `pageSize`) enables
     * the selector — which stays visible even on a single page so a user can
     * switch DOWN to a smaller size (or back off "All"), as long as there are
     * more items than the smallest offered size (see `totalItems`).
     */
    onPageSizeChange?: (size: PageSizeOption) => void;
    /**
     * Total item count across all pages. Drives whether the selector is worth
     * showing when everything already fits on one page: with `<=` the smallest
     * offered size there is nothing any size could page, so the whole bar hides.
     */
    totalItems?: number;
    /** Visible/aria label for the size selector. Default "Rows per page". */
    pageSizeLabel?: string;
    /** Extra classes merged onto the pager bar's root (e.g. top margin). */
    className?: string;
}

const CONTROL_CLASS =
    'min-w-6 rounded-md border border-border bg-surface px-1 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50';

const ACTIVE_CLASS =
    'min-w-6 rounded-md border border-accent bg-accent-soft px-1 py-1 text-xs font-semibold text-accent';

const SELECT_CLASS =
    'rounded-md border border-border bg-surface px-1 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Presentational, accessible numbered pager with an optional rows-per-page
 * selector. Purely a view over `page` / `pageCount` / `pageSize` — it owns no
 * state; the caller (or the {@link usePagination} hook / `DataTable`'s
 * `pageSize`) owns the current page and size and clamps/resets them. The window
 * math lives in the pure {@link paginationRange} helper so the algorithm is
 * tested independently of this markup.
 *
 * First/Previous are disabled on the first page and Next/Last on the last;
 * disabled buttons are real `:disabled` (focusable-skip, not `aria-hidden`),
 * the active number carries `aria-current="page"`, and each ellipsis is an
 * inert `<span>` with no click handler. With no selector configured it renders
 * nothing for a single page (unchanged legacy behavior); with a selector it
 * self-gates via {@link isPaginationVisible}.
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
    pageSize,
    pageSizeOptions,
    onPageSizeChange,
    totalItems,
    pageSizeLabel = 'Rows per page',
    className,
}: PaginationProps): JSX.Element | null {
    const selectorEnabled = onPageSizeChange !== undefined && pageSize !== undefined;
    const options = pageSizeOptions ?? [];

    if (!isPaginationVisible(totalItems ?? 0, pageCount, selectorEnabled, options)) {
        return null;
    }

    const showPager = pageCount > 1;
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

    const selector = selectorEnabled ? (
        <label className="flex items-center gap-2 text-xs text-muted">
            <span>{pageSizeLabel}</span>
            <select
                className={SELECT_CLASS}
                value={pageSize === 'all' ? 'all' : String(pageSize)}
                disabled={disabled}
                onChange={(e) => {
                    const v = e.target.value;
                    onPageSizeChange?.(v === 'all' ? 'all' : Number(v));
                }}
                aria-label={pageSizeLabel}
            >
                {options.map((o) => (
                    <option key={String(o)} value={o === 'all' ? 'all' : String(o)}>
                        {o === 'all' ? 'All' : o}
                    </option>
                ))}
            </select>
        </label>
    ) : null;

    const nav = showPager ? (
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
                        className="min-w-9 px-2.5 py-1.5 text-center text-xs text-muted"
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
    ) : null;

    // Selector on the left, pager on the right. `justify-between` keeps the pager
    // right-aligned whether or not the selector is present (a lone pager gets an
    // empty spacer); a lone selector sits at the left.
    return (
        <div
            className={`flex w-full flex-wrap items-center justify-between gap-3${className ? ` ${className}` : ''}`}
        >
            {selector ?? <span aria-hidden="true" />}
            {nav}
        </div>
    );
}
