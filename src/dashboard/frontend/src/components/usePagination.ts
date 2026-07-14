import {useState} from 'react';

/**
 * A selectable rows-per-page choice. A number caps each page at that many rows;
 * `'all'` collapses the whole list onto a single page.
 */
export type PageSizeOption = number | 'all';

/** The default rows-per-page choices offered by the pager's size selector. */
export const DEFAULT_PAGE_SIZE_OPTIONS: readonly PageSizeOption[] = [10, 25, 50, 'all'];

export interface UsePaginationOptions {
    /**
     * Selectable sizes for the rows-per-page control. Default
     * {@link DEFAULT_PAGE_SIZE_OPTIONS}. Also the runtime allowlist a persisted
     * value must belong to.
     */
    pageSizeOptions?: readonly PageSizeOption[];
    /**
     * `localStorage` key under which the chosen size is persisted across mounts
     * (per-surface, so each table/list remembers its own choice). Omit for no
     * persistence — the size then resets to `initialPageSize` on every mount.
     */
    storageKey?: string;
}

export interface UsePaginationResult<T> {
    /** 1-based current page, already clamped into `[1, pageCount]`. */
    page: number;
    /** Jump to a page; the returned `page` re-clamps, so an out-of-range value is safe. */
    setPage: (page: number) => void;
    /** Total pages for `items` at the current `pageSize` (always `>= 1`). */
    pageCount: number;
    /** The slice of `items` visible on the current page. */
    pageItems: T[];
    /** The current rows-per-page choice (a number, or `'all'`). */
    pageSize: PageSizeOption;
    /** Change the rows-per-page; snaps back to page 1 and persists when a `storageKey` is set. */
    setPageSize: (size: PageSizeOption) => void;
    /** The selectable sizes, for rendering the control. */
    pageSizeOptions: readonly PageSizeOption[];
}

/**
 * Read a persisted rows-per-page choice, FAIL-CLOSED: a stored value is honored
 * only when it is one of the currently-offered `options` (a shrunk/renamed
 * option list, a hand-edited or corrupt entry, or a blocked `localStorage` all
 * fall back to `fallback`). Shared with the one hand-rolled pager (the repo-scope
 * modal) so persistence behaves identically everywhere.
 */
export function loadPageSize(
    storageKey: string | undefined,
    options: readonly PageSizeOption[],
    fallback: PageSizeOption,
): PageSizeOption {
    if (!storageKey || typeof window === 'undefined') return fallback;
    let raw: string | null;
    try {
        raw = window.localStorage.getItem(storageKey);
    } catch {
        return fallback;
    }
    if (raw === null) return fallback;
    const parsed: PageSizeOption = raw === 'all' ? 'all' : Number(raw);
    return options.some((o) => o === parsed) ? parsed : fallback;
}

/** Persist a rows-per-page choice; best-effort (quota/security errors are swallowed). */
export function savePageSize(storageKey: string | undefined, size: PageSizeOption): void {
    if (!storageKey || typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(storageKey, size === 'all' ? 'all' : String(size));
    } catch {
        // Persistence is a convenience, never a correctness requirement.
    }
}

/** The effective numeric page length for a choice: `'all'` spans the whole list. */
function effectiveSize(pageSize: PageSizeOption, itemCount: number): number {
    if (pageSize === 'all') return Math.max(1, itemCount);
    return Math.max(1, Math.trunc(pageSize));
}

/** The smallest numeric size in a list of options (Infinity when there is none). */
function smallestNumericOption(options: readonly PageSizeOption[]): number {
    return options.reduce<number>(
        (min, o) => (typeof o === 'number' ? Math.min(min, o) : min),
        Number.POSITIVE_INFINITY,
    );
}

/**
 * Whether the pager bar should render at all. The single source of truth for the
 * "is there anything to show" decision — used both inside {@link Pagination} and
 * by consumers that own a wrapper element (so an empty pager row never renders):
 *  - a numbered pager is needed as soon as there is more than one page; otherwise
 *  - the size selector is worth showing only when the list has more items than
 *    the smallest offered size (below that, every size shows the same one page).
 */
export function isPaginationVisible(
    totalItems: number,
    pageCount: number,
    selectorEnabled: boolean,
    pageSizeOptions: readonly PageSizeOption[] = [],
): boolean {
    if (pageCount > 1) return true;
    if (!selectorEnabled) return false;
    return totalItems > smallestNumericOption(pageSizeOptions);
}

/**
 * Client-side pagination state for an already-fetched list — the single place
 * the epic's page-state hygiene lives, so no consumer re-derives it:
 *
 *  1. **Clamp on shrink** — the returned `page` is `min(page, pageCount)`, so a
 *     list that shrinks below the current page can never leave the slice out of
 *     range (the repo-modal `safePage` lesson).
 *  2. **Reset on identity change** — when the `items` REFERENCE changes (a new
 *     array from a filter/sort/search), the page snaps back to 1. This relies on
 *     the caller passing a STABLE reference across renders (memoize derived
 *     lists with `useMemo`) so an unrelated re-render doesn't reset the page. A
 *     fresh NON-empty array every render will reset every render — memoize it.
 *     (An empty `data ?? []` fallback is the one exception the guard below
 *     tolerates.) When feeding this via `DataTable`'s `pageSize`, the same
 *     stability requirement extends to the `columns` prop, since the table's
 *     post-sort rows identity depends on it.
 *  3. **Own the rows-per-page** — `initialPageSize` seeds the size; the returned
 *     `setPageSize` swaps it (resetting to page 1) and, given `options.storageKey`,
 *     persists the choice per-surface. `'all'` renders everything on one page.
 *
 * `DataTable`'s `pageSize` and every card/gallery list use this; it owns no
 * rendering, only the page math.
 */
export function usePagination<T>(
    items: T[],
    initialPageSize: number,
    options: UsePaginationOptions = {},
): UsePaginationResult<T> {
    const pageSizeOptions = options.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS;
    const {storageKey} = options;

    // Seed from storage once (lazy initializer), fail-closed to the initial size.
    const [pageSize, setPageSizeState] = useState<PageSizeOption>(() =>
        loadPageSize(storageKey, pageSizeOptions, initialPageSize),
    );
    const [page, setPage] = useState(1);
    // React's "adjust state during render" pattern: when the list identity
    // changes we reset to page 1 immediately (before commit — no flash), rather
    // than in an effect that would render one stale frame first. Two EMPTY arrays
    // count as the same identity — resetting empty→empty is a no-op anyway, and
    // this stops the common `data ?? []` fresh-`[]`-each-render-while-loading case
    // from looping (a fresh reference every render would otherwise reset forever).
    const [trackedItems, setTrackedItems] = useState(items);
    if (items !== trackedItems && !(items.length === 0 && trackedItems.length === 0)) {
        setTrackedItems(items);
        setPage(1);
    }

    function setPageSize(next: PageSizeOption): void {
        setPageSizeState(next);
        // A size change reshuffles every page boundary, so restart from page 1 —
        // the same restart a filter/sort applies, and predictable to the user.
        setPage(1);
        savePageSize(storageKey, next);
    }

    const size = effectiveSize(pageSize, items.length);
    const pageCount = Math.max(1, Math.ceil(items.length / size));
    // Clamp every render so `page` state briefly exceeding range (a shrink that
    // didn't change identity, or the frame before the reset commits) can never
    // slice out of bounds. Clamp BOTH bounds so the public `setPage` — exposed
    // unclamped — can't produce a negative slice from a `setPage(0)`/negative.
    const safePage = Math.min(Math.max(page, 1), pageCount);
    const pageItems = items.slice((safePage - 1) * size, safePage * size);

    return {page: safePage, setPage, pageCount, pageItems, pageSize, setPageSize, pageSizeOptions};
}
