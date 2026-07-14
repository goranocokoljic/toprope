import {useState} from 'react';

export interface UsePaginationResult<T> {
    /** 1-based current page, already clamped into `[1, pageCount]`. */
    page: number;
    /** Jump to a page; the returned `page` re-clamps, so an out-of-range value is safe. */
    setPage: (page: number) => void;
    /** Total pages for `items` at this `pageSize` (always `>= 1`). */
    pageCount: number;
    /** The slice of `items` visible on the current page. */
    pageItems: T[];
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
 *     lists with `useMemo`) so an unrelated re-render doesn't reset the page.
 *
 * `DataTable`'s `pageSize` and every card/gallery list use this; it owns no
 * rendering, only the page math.
 */
export function usePagination<T>(items: T[], pageSize: number): UsePaginationResult<T> {
    const size = Math.max(1, Math.trunc(pageSize));
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

    const pageCount = Math.max(1, Math.ceil(items.length / size));
    // Clamp every render so `page` state briefly exceeding range (a shrink that
    // didn't change identity, or the frame before the reset commits) can never
    // slice out of bounds.
    const safePage = Math.min(page, pageCount);
    const pageItems = items.slice((safePage - 1) * size, safePage * size);

    return {page: safePage, setPage, pageCount, pageItems};
}
