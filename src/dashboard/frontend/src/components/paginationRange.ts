/**
 * The visible tokens of a numbered pager: real 1-based page numbers, or
 * `'ellipsis'` for a collapsed gap. `'ellipsis'` is a discriminable sentinel so
 * a caller can `typeof token === 'number'` without confusing it for a page.
 */
export type PaginationToken = number | 'ellipsis';

export interface PaginationRangeInput {
    /** 1-based current page; clamped into `[1, pageCount]`. */
    page: number;
    /** Total number of pages. `<= 1` collapses to `[1]`. */
    pageCount: number;
    /** Pages shown on EACH side of the current page. Default 1. */
    siblingCount?: number;
    /** Pages pinned at EACH end (first/last block). Default 1. */
    boundaryCount?: number;
}

/** Inclusive integer range `[start, end]`; empty when `start > end`. */
function range(start: number, end: number): number[] {
    const length = end - start + 1;
    return length > 0 ? Array.from({length}, (_, i) => start + i) : [];
}

/**
 * Pure computation of the page tokens for a numbered pager, mirroring the
 * well-worn boundary/sibling algorithm (same shape MUI's `usePagination`
 * produces). `boundaryCount` pages are pinned at each end and `siblingCount`
 * pages sit on each side of `page`; every gap wider than a single page collapses
 * to `'ellipsis'`, but a gap that hides EXACTLY one page renders that page's
 * number instead (so you never see `… 4 …`).
 *
 * `page` is clamped to `[1, pageCount]`, and `pageCount <= 1` short-circuits to
 * `[1]` — the component above renders nothing for a single page, but the helper
 * stays total so it is safe to call unguarded.
 *
 * @example paginationRange({page: 7, pageCount: 20, siblingCount: 2})
 *   → [1, 'ellipsis', 5, 6, 7, 8, 9, 'ellipsis', 20]
 */
export function paginationRange({
    page,
    pageCount,
    siblingCount = 1,
    boundaryCount = 1,
}: PaginationRangeInput): PaginationToken[] {
    if (pageCount <= 1) return [1];
    const current = Math.min(Math.max(Math.trunc(page), 1), pageCount);

    const startPages = range(1, Math.min(boundaryCount, pageCount));
    const endPages = range(Math.max(pageCount - boundaryCount + 1, boundaryCount + 1), pageCount);

    // The sibling window, pushed away from the boundary blocks so it never
    // overlaps them and never runs off either edge.
    const siblingsStart = Math.max(
        Math.min(current - siblingCount, pageCount - boundaryCount - siblingCount * 2 - 1),
        boundaryCount + 2,
    );
    const siblingsEnd = Math.min(
        Math.max(current + siblingCount, boundaryCount + siblingCount * 2 + 2),
        endPages.length > 0 ? endPages[0] - 2 : pageCount - 1,
    );

    return [
        ...startPages,
        // Left gap: a true ellipsis when >1 page is hidden, the single hidden
        // page's number when exactly one is, nothing when the blocks touch.
        ...(siblingsStart > boundaryCount + 2
            ? (['ellipsis'] as PaginationToken[])
            : boundaryCount + 1 < pageCount - boundaryCount
              ? [boundaryCount + 1]
              : []),
        ...range(siblingsStart, siblingsEnd),
        // Right gap: symmetric to the left.
        ...(siblingsEnd < pageCount - boundaryCount - 1
            ? (['ellipsis'] as PaginationToken[])
            : pageCount - boundaryCount > boundaryCount
              ? [pageCount - boundaryCount]
              : []),
        ...endPages,
    ];
}
