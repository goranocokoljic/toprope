// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useState} from 'react';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react';

import {paginationRange} from '../components/paginationRange';
import {Pagination} from '../components/Pagination';
import {
    DEFAULT_PAGE_SIZE_OPTIONS,
    isPaginationVisible,
    usePagination,
    type PageSizeOption,
} from '../components/usePagination';
import {DataTable, type Column} from '../components/DataTable';

const SIZE_OPTIONS: readonly PageSizeOption[] = [10, 25, 50, 'all'];

beforeEach(() => {
    // Persisted rows-per-page choices must not leak between tests.
    localStorage.clear();
});

afterEach(() => {
    cleanup();
});

// --- paginationRange (pure) ------------------------------------------------

describe('paginationRange', () => {
    it('collapses to [1] for a single or empty page count', () => {
        expect(paginationRange({page: 1, pageCount: 1})).toEqual([1]);
        expect(paginationRange({page: 1, pageCount: 0})).toEqual([1]);
        expect(paginationRange({page: 3, pageCount: -2})).toEqual([1]);
    });

    it('matches the epic worked example (page 7, 20 pages, sibling 2)', () => {
        expect(paginationRange({page: 7, pageCount: 20, siblingCount: 2, boundaryCount: 1})).toEqual([
            1,
            'ellipsis',
            5,
            6,
            7,
            8,
            9,
            'ellipsis',
            20,
        ]);
    });

    it('near the start: no left ellipsis, a stable-width window, right ellipsis', () => {
        expect(paginationRange({page: 1, pageCount: 10, siblingCount: 1})).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
        expect(paginationRange({page: 2, pageCount: 10, siblingCount: 1})).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
    });

    it('near the end: no right ellipsis, a stable-width window, left ellipsis', () => {
        expect(paginationRange({page: 10, pageCount: 10, siblingCount: 1})).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
        expect(paginationRange({page: 9, pageCount: 10, siblingCount: 1})).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
    });

    it('in the middle: an ellipsis on both sides', () => {
        expect(paginationRange({page: 5, pageCount: 10, siblingCount: 1})).toEqual([
            1,
            'ellipsis',
            4,
            5,
            6,
            'ellipsis',
            10,
        ]);
    });

    it('renders the hidden page number when a gap hides exactly one page (no "… 4 …")', () => {
        // 7 pages, current 4, sibling 1: both gaps would hide only page 2 and
        // page 6 respectively → those numbers show instead of an ellipsis.
        expect(paginationRange({page: 4, pageCount: 7, siblingCount: 1})).toEqual([1, 2, 3, 4, 5, 6, 7]);
        // 8 pages, current 4: left gap hides only page 2 (→ number), right gap
        // hides pages 6–7 (→ ellipsis).
        expect(paginationRange({page: 4, pageCount: 8, siblingCount: 1})).toEqual([
            1,
            2,
            3,
            4,
            5,
            'ellipsis',
            8,
        ]);
        // Mirror on the RIGHT: 8 pages, current 5 → left gap hides pages 2–3
        // (→ ellipsis), right gap hides only page 7 (→ literal number, not `… 7 …`).
        expect(paginationRange({page: 5, pageCount: 8, siblingCount: 1})).toEqual([
            1,
            'ellipsis',
            4,
            5,
            6,
            7,
            8,
        ]);
    });

    it('suppresses all ellipses when siblingCount is large enough to span the list', () => {
        expect(paginationRange({page: 5, pageCount: 10, siblingCount: 10})).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
    });

    it('respects a wider boundaryCount', () => {
        expect(paginationRange({page: 10, pageCount: 20, siblingCount: 1, boundaryCount: 2})).toEqual([
            1,
            2,
            'ellipsis',
            9,
            10,
            11,
            'ellipsis',
            19,
            20,
        ]);
    });

    it('clamps an out-of-range page before computing the window', () => {
        // Clamped to page 1 → near-start window; clamped to the last page → near-end window.
        expect(paginationRange({page: 0, pageCount: 10, siblingCount: 1})).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
        expect(paginationRange({page: 99, pageCount: 10, siblingCount: 1})).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
    });
});

// --- Pagination (presentational) -------------------------------------------

describe('Pagination', () => {
    it('renders nothing for a single (or zero) page', () => {
        const {container} = render(<Pagination page={1} pageCount={1} onPageChange={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders First/Prev/Next/Last plus the numbered window and routes clicks', () => {
        const onPageChange = vi.fn();
        render(<Pagination page={3} pageCount={10} onPageChange={onPageChange} />);
        expect(screen.getByRole('navigation', {name: 'Pagination'})).toBeInTheDocument();
        // Numbered page buttons exist for the window.
        fireEvent.click(screen.getByRole('button', {name: 'Page 4'}));
        expect(onPageChange).toHaveBeenCalledWith(4);
        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(onPageChange).toHaveBeenCalledWith(4);
        fireEvent.click(screen.getByRole('button', {name: 'Previous page'}));
        expect(onPageChange).toHaveBeenCalledWith(2);
        fireEvent.click(screen.getByRole('button', {name: 'First page'}));
        expect(onPageChange).toHaveBeenCalledWith(1);
        fireEvent.click(screen.getByRole('button', {name: 'Last page'}));
        expect(onPageChange).toHaveBeenCalledWith(10);
    });

    it('disables First/Previous on page 1 and Next/Last on the last page', () => {
        const {rerender} = render(<Pagination page={1} pageCount={5} onPageChange={vi.fn()} />);
        expect(screen.getByRole('button', {name: 'First page'})).toBeDisabled();
        expect(screen.getByRole('button', {name: 'Previous page'})).toBeDisabled();
        expect(screen.getByRole('button', {name: 'Next page'})).toBeEnabled();
        expect(screen.getByRole('button', {name: 'Last page'})).toBeEnabled();

        rerender(<Pagination page={5} pageCount={5} onPageChange={vi.fn()} />);
        expect(screen.getByRole('button', {name: 'First page'})).toBeEnabled();
        expect(screen.getByRole('button', {name: 'Next page'})).toBeDisabled();
        expect(screen.getByRole('button', {name: 'Last page'})).toBeDisabled();
    });

    it('marks the active page with aria-current="page"', () => {
        render(<Pagination page={3} pageCount={10} onPageChange={vi.fn()} />);
        expect(screen.getByRole('button', {name: 'Page 3'})).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', {name: 'Page 4'})).not.toHaveAttribute('aria-current');
    });

    it('clicking the current page does not fire onPageChange', () => {
        const onPageChange = vi.fn();
        render(<Pagination page={3} pageCount={10} onPageChange={onPageChange} />);
        fireEvent.click(screen.getByRole('button', {name: 'Page 3'}));
        expect(onPageChange).not.toHaveBeenCalled();
    });

    it('renders ellipses as inert non-buttons with no handler', () => {
        render(<Pagination page={5} pageCount={20} onPageChange={vi.fn()} />);
        const ellipses = screen.getAllByText('…');
        expect(ellipses.length).toBeGreaterThan(0);
        for (const el of ellipses) {
            expect(el.tagName).toBe('SPAN');
            expect(el).toHaveAttribute('aria-hidden', 'true');
        }
    });

    it('disabled disables every control and blocks clicks', () => {
        const onPageChange = vi.fn();
        render(<Pagination page={3} pageCount={10} onPageChange={onPageChange} disabled />);
        for (const btn of screen.getAllByRole('button')) {
            expect(btn).toBeDisabled();
        }
        fireEvent.click(screen.getByRole('button', {name: 'Page 4'}));
        expect(onPageChange).not.toHaveBeenCalled();
    });

    it('omits First/Last when showFirstLast is false and honours a custom aria-label', () => {
        render(
            <Pagination
                page={2}
                pageCount={5}
                onPageChange={vi.fn()}
                showFirstLast={false}
                ariaLabel="Repositories pager"
            />,
        );
        expect(screen.queryByRole('button', {name: 'First page'})).not.toBeInTheDocument();
        expect(screen.queryByRole('button', {name: 'Last page'})).not.toBeInTheDocument();
        expect(screen.getByRole('navigation', {name: 'Repositories pager'})).toBeInTheDocument();
    });
});

// --- Pagination rows-per-page selector (#227) ------------------------------

describe('Pagination — rows-per-page selector', () => {
    it('renders the selector, routes numeric changes, and maps "All" to the sentinel', () => {
        const onPageSizeChange = vi.fn();
        render(
            <Pagination
                page={1}
                pageCount={3}
                onPageChange={vi.fn()}
                pageSize={10}
                pageSizeOptions={SIZE_OPTIONS}
                onPageSizeChange={onPageSizeChange}
                totalItems={30}
            />,
        );
        const select = screen.getByRole('combobox', {name: 'Rows per page'});
        expect(select).toHaveValue('10');
        // The pager and the selector coexist.
        expect(screen.getByRole('navigation')).toBeInTheDocument();

        fireEvent.change(select, {target: {value: '50'}});
        expect(onPageSizeChange).toHaveBeenCalledWith(50);
        fireEvent.change(select, {target: {value: 'all'}});
        expect(onPageSizeChange).toHaveBeenLastCalledWith('all');
    });

    it('stays visible on a single page so a user can still switch to a smaller size', () => {
        // 15 items at 25/page is one page: no numbered pager, but the selector
        // must remain so the user can drop to 10/page (or off "All").
        render(
            <Pagination
                page={1}
                pageCount={1}
                onPageChange={vi.fn()}
                pageSize={25}
                pageSizeOptions={SIZE_OPTIONS}
                onPageSizeChange={vi.fn()}
                totalItems={15}
            />,
        );
        expect(screen.getByRole('combobox', {name: 'Rows per page'})).toBeInTheDocument();
        expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('renders "All" as the selected label for the all sentinel', () => {
        render(
            <Pagination
                page={1}
                pageCount={1}
                onPageChange={vi.fn()}
                pageSize="all"
                pageSizeOptions={SIZE_OPTIONS}
                onPageSizeChange={vi.fn()}
                totalItems={30}
            />,
        );
        expect(screen.getByRole('combobox', {name: 'Rows per page'})).toHaveValue('all');
        expect(screen.getByRole('option', {name: 'All'})).toBeInTheDocument();
    });

    it('hides the whole bar when there are fewer items than the smallest size', () => {
        const {container} = render(
            <Pagination
                page={1}
                pageCount={1}
                onPageChange={vi.fn()}
                pageSize={25}
                pageSizeOptions={SIZE_OPTIONS}
                onPageSizeChange={vi.fn()}
                totalItems={8}
            />,
        );
        expect(container.firstChild).toBeNull();
    });
});

describe('isPaginationVisible', () => {
    it('is true whenever there is more than one page, selector or not', () => {
        expect(isPaginationVisible(0, 2, false, SIZE_OPTIONS)).toBe(true);
        expect(isPaginationVisible(0, 2, true, SIZE_OPTIONS)).toBe(true);
    });

    it('is false on a single page with no selector', () => {
        expect(isPaginationVisible(1000, 1, false, SIZE_OPTIONS)).toBe(false);
    });

    it('on a single page with a selector, shows only above the smallest size', () => {
        expect(isPaginationVisible(10, 1, true, SIZE_OPTIONS)).toBe(false); // 10 is not > 10
        expect(isPaginationVisible(11, 1, true, SIZE_OPTIONS)).toBe(true);
    });
});

// --- usePagination (state hygiene) -----------------------------------------

describe('usePagination', () => {
    it('returns the correct slice for the current page', () => {
        const items = Array.from({length: 25}, (_, i) => i + 1);
        const {result} = renderHook(() => usePagination(items, 10));
        expect(result.current.pageCount).toBe(3);
        expect(result.current.pageItems).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        act(() => result.current.setPage(3));
        expect(result.current.pageItems).toEqual([21, 22, 23, 24, 25]);
    });

    it('clamps the page when items shrink below the current page', () => {
        const big = Array.from({length: 30}, (_, i) => i);
        const {result, rerender} = renderHook(({items}) => usePagination(items, 10), {
            initialProps: {items: big},
        });
        act(() => result.current.setPage(3));
        expect(result.current.page).toBe(3);
        // A shrink to one page's worth: page clamps to the last (only) page.
        const small = big.slice(0, 4);
        rerender({items: small});
        expect(result.current.pageCount).toBe(1);
        expect(result.current.page).toBe(1);
        expect(result.current.pageItems).toEqual([0, 1, 2, 3]);
    });

    it('resets to page 1 when the items identity changes', () => {
        const a = Array.from({length: 30}, (_, i) => `a${i}`);
        const b = Array.from({length: 30}, (_, i) => `b${i}`);
        const {result, rerender} = renderHook(({items}) => usePagination(items, 10), {
            initialProps: {items: a},
        });
        act(() => result.current.setPage(3));
        expect(result.current.page).toBe(3);
        rerender({items: b}); // new reference, same length → identity reset
        expect(result.current.page).toBe(1);
        expect(result.current.pageItems).toEqual(b.slice(0, 10));
    });

    it('does not infinite-loop when items is a FRESH [] each render (the data ?? [] loading pattern)', () => {
        // The callback builds a brand-new empty array on EVERY render — including
        // the adjust-state-during-render re-render — exactly like `data ?? []`
        // recomputed in a component body while loading. Passing the array as a
        // renderHook prop would keep a stable reference across the internal
        // re-render and NOT exercise the guard; building it inline does. Without
        // the empty-array identity guard this resets forever and renderHook throws
        // "Too many re-renders".
        const {result, rerender} = renderHook(() => usePagination([] as number[], 10));
        expect(result.current.page).toBe(1);
        rerender();
        rerender();
        expect(result.current.page).toBe(1);
    });

    it('resets to page 1 when an empty list becomes populated', () => {
        const {result, rerender} = renderHook(({items}) => usePagination(items, 10), {
            initialProps: {items: [] as number[]},
        });
        rerender({items: [1, 2, 3]});
        expect(result.current.page).toBe(1);
        expect(result.current.pageItems).toEqual([1, 2, 3]);
    });

    it('lower-clamps a below-range page (setPage(0)/negative) to 1 — no negative slice', () => {
        const items = [10, 20, 30, 40, 50]; // stable reference across re-renders
        const {result} = renderHook(() => usePagination(items, 2));
        act(() => result.current.setPage(2));
        expect(result.current.pageItems).toEqual([30, 40]);
        act(() => result.current.setPage(0));
        expect(result.current.page).toBe(1);
        expect(result.current.pageItems).toEqual([10, 20]);
        act(() => result.current.setPage(-5));
        expect(result.current.page).toBe(1);
        expect(result.current.pageItems).toEqual([10, 20]);
    });

    it('does not reset the page on a re-render with the same items reference', () => {
        const items = Array.from({length: 30}, (_, i) => i);
        const {result, rerender} = renderHook(() => usePagination(items, 10));
        act(() => result.current.setPage(2));
        rerender();
        expect(result.current.page).toBe(2);
    });

    // --- rows-per-page (#227) ---

    it('exposes the default option list and the initial size', () => {
        const {result} = renderHook(() => usePagination([1, 2, 3], 25));
        expect(result.current.pageSize).toBe(25);
        expect(result.current.pageSizeOptions).toEqual(DEFAULT_PAGE_SIZE_OPTIONS);
    });

    it('changing the size recomputes pages and restarts from page 1', () => {
        const items = Array.from({length: 30}, (_, i) => i);
        const {result} = renderHook(() => usePagination(items, 10));
        expect(result.current.pageCount).toBe(3);
        act(() => result.current.setPage(3));
        expect(result.current.page).toBe(3);
        act(() => result.current.setPageSize(25));
        expect(result.current.pageSize).toBe(25);
        expect(result.current.pageCount).toBe(2);
        expect(result.current.page).toBe(1);
    });

    it("'all' collapses every item onto a single page", () => {
        const items = Array.from({length: 30}, (_, i) => i);
        const {result} = renderHook(() => usePagination(items, 10));
        act(() => result.current.setPageSize('all'));
        expect(result.current.pageCount).toBe(1);
        expect(result.current.pageItems).toHaveLength(30);
    });

    it('persists the chosen size and seeds a fresh mount from it', () => {
        const items = Array.from({length: 30}, (_, i) => i);
        const {result, unmount} = renderHook(() => usePagination(items, 10, {storageKey: 'k'}));
        act(() => result.current.setPageSize(50));
        expect(localStorage.getItem('k')).toBe('50');
        unmount();
        const {result: remounted} = renderHook(() => usePagination(items, 10, {storageKey: 'k'}));
        expect(remounted.current.pageSize).toBe(50);
    });

    it('fail-closed: a stored value outside the allowlist falls back to the initial size', () => {
        localStorage.setItem('k', '999'); // not one of [10,25,50,'all']
        const items = Array.from({length: 5}, (_, i) => i);
        const {result} = renderHook(() => usePagination(items, 10, {storageKey: 'k'}));
        expect(result.current.pageSize).toBe(10);
    });
});

// --- DataTable pageSize integration ----------------------------------------

interface Row {
    name: string;
    n: number;
}

const COLUMNS: Column<Row>[] = [
    {key: 'name', header: 'Name', accessor: (r) => r.name},
    {key: 'n', header: 'N', accessor: (r) => r.n, align: 'right'},
];

function makeRows(count: number): Row[] {
    return Array.from({length: count}, (_, i) => ({name: `row-${String(i).padStart(3, '0')}`, n: count - i}));
}

function bodyNames(): string[] {
    return Array.from(document.querySelectorAll('tbody tr td:first-child')).map((td) => td.textContent ?? '');
}

describe('DataTable pageSize', () => {
    it('renders only one page of rows plus a pager footer when pageSize is set', () => {
        render(<DataTable columns={COLUMNS} rows={makeRows(30)} getRowKey={(r) => r.name} pageSize={10} />);
        expect(bodyNames()).toHaveLength(10);
        expect(bodyNames()[0]).toBe('row-000');
        expect(screen.getByRole('navigation')).toBeInTheDocument();
        // Jump to page 2 → next slice.
        fireEvent.click(screen.getByRole('button', {name: 'Page 2'}));
        expect(bodyNames()[0]).toBe('row-010');
        expect(bodyNames()).toHaveLength(10);
    });

    it('renders all rows and no pager when pageSize is omitted (unchanged behaviour)', () => {
        render(<DataTable columns={COLUMNS} rows={makeRows(30)} getRowKey={(r) => r.name} />);
        expect(bodyNames()).toHaveLength(30);
        expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('keeps the current page across a parent re-render when rows/columns references are stable', () => {
        // Regression guard for the Leaderboard inline-columns bug: a parent
        // re-render that changes NOTHING about the rows/columns identity must not
        // snap the pager back to page 1 (usePagination keys its identity-reset off
        // the post-sort rows, whose identity depends on the columns reference).
        const rows = makeRows(30);
        function Harness(): JSX.Element {
            const [, force] = useState(0);
            return (
                <>
                    <button type="button" onClick={() => force((n) => n + 1)}>
                        rerender
                    </button>
                    <DataTable columns={COLUMNS} rows={rows} getRowKey={(r) => r.name} pageSize={10} />
                </>
            );
        }
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Page 2'}));
        expect(bodyNames()[0]).toBe('row-010');
        // Force a parent re-render with stable rows/columns → page must hold.
        fireEvent.click(screen.getByRole('button', {name: 'rerender'}));
        expect(bodyNames()[0]).toBe('row-010');
    });

    it('sorts the whole list before paging and resets to page 1 on a sort change', () => {
        render(<DataTable columns={COLUMNS} rows={makeRows(30)} getRowKey={(r) => r.name} pageSize={10} />);
        // Move to page 2 first.
        fireEvent.click(screen.getByRole('button', {name: 'Page 2'}));
        expect(bodyNames()[0]).toBe('row-010');
        // Sort ascending by N: the global min (n=1, the last row 'row-029') must
        // lead page 1 — proving the sort ordered the FULL list, not just page 2 —
        // and the sort change reset us back to page 1.
        fireEvent.click(screen.getByRole('button', {name: 'N'}));
        expect(bodyNames()[0]).toBe('row-029');
        expect(bodyNames()).toHaveLength(10);
    });

    it('exposes a rows-per-page selector that re-slices the whole table (#227)', () => {
        render(<DataTable columns={COLUMNS} rows={makeRows(30)} getRowKey={(r) => r.name} pageSize={10} />);
        expect(bodyNames()).toHaveLength(10);
        const select = screen.getByRole('combobox', {name: 'Rows per page'});
        expect(select).toHaveValue('10');
        // Bump to 50/page: all 30 rows fit on one page → no numbered pager, but
        // the selector remains.
        fireEvent.change(select, {target: {value: '50'}});
        expect(bodyNames()).toHaveLength(30);
        expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
        expect(screen.getByRole('combobox', {name: 'Rows per page'})).toBeInTheDocument();
    });

    it('renders no footer at all when a paginated table has fewer rows than the smallest size', () => {
        render(<DataTable columns={COLUMNS} rows={makeRows(8)} getRowKey={(r) => r.name} pageSize={10} />);
        expect(bodyNames()).toHaveLength(8);
        expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox', {name: 'Rows per page'})).not.toBeInTheDocument();
    });
});
