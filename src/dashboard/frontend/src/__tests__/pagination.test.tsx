// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react';

import {paginationRange} from '../components/paginationRange';
import {Pagination} from '../components/Pagination';
import {usePagination} from '../components/usePagination';
import {DataTable, type Column} from '../components/DataTable';

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

    it('treats successive fresh empty arrays as one identity (no reset loop while loading)', () => {
        const {result, rerender} = renderHook(({items}) => usePagination(items, 10), {
            initialProps: {items: [] as number[]},
        });
        expect(result.current.page).toBe(1);
        // A different empty-array reference each render (the `data ?? []` pattern)
        // must NOT loop — renderHook would throw "Too many re-renders" if it did.
        rerender({items: []});
        rerender({items: []});
        expect(result.current.page).toBe(1);
        // Empty → populated still surfaces the first page of the new list.
        rerender({items: [1, 2, 3]});
        expect(result.current.pageItems).toEqual([1, 2, 3]);
    });

    it('does not reset the page on a re-render with the same items reference', () => {
        const items = Array.from({length: 30}, (_, i) => i);
        const {result, rerender} = renderHook(() => usePagination(items, 10));
        act(() => result.current.setPage(2));
        rerender();
        expect(result.current.page).toBe(2);
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
});
