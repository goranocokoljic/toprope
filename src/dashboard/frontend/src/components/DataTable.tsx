import {useEffect, useMemo, useState, type ReactNode} from 'react';

import {Pagination} from './Pagination';
import {usePagination} from './usePagination';

export type SortDirection = 'asc' | 'desc';

/** An active sort: the column key plus its direction. */
export interface SortState {
    key: string;
    direction: SortDirection;
}

export interface Column<T> {
    /** Stable column id; also the sort key. */
    key: string;
    header: ReactNode;
    /**
     * Value used for the default cell text AND for self-mode sorting. Provide
     * for any column that should sort in the classic self-sorting mode —
     * without an accessor a column can only sort in CONTROLLED mode (via
     * `sortable: true`, where the parent's comparator owns the ordering).
     * Return `null` for a row with no value in this column — such rows always
     * sort to the END, in BOTH directions (see the sort comparator), so a
     * "no data" row never reads as the best or worst ranked value.
     */
    accessor?: (row: T) => string | number | null;
    /** Custom cell renderer; falls back to the accessor value. */
    render?: (row: T) => ReactNode;
    align?: 'left' | 'right' | 'center';
    /**
     * `false` force-disables sorting even when an accessor is present.
     * `true` force-enables a render-only column — honored ONLY in controlled
     * mode (the parent comparator sorts); in self-sorting mode it is ignored,
     * because without an accessor the header would announce a sort that never
     * reorders anything.
     */
    sortable?: boolean;
}

export interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    /** Stable key per row (for React reconciliation). */
    getRowKey: (row: T) => string;
    initialSort?: SortState;
    emptyMessage?: string;
    caption?: string;
    /**
     * CONTROLLED sort (#215): when `onSortChange` is provided, the parent owns
     * sorting — header clicks report the next {key, direction} through the
     * callback, `sort` drives the header indicators, and `rows` are rendered
     * AS GIVEN (pre-sorted by the parent). Use this when sorting must compose
     * with parent-side concerns like pagination or a comparator the accessors
     * can't express (e.g. grouped selection-status ordering). Pass BOTH props
     * together (a `sort` without `onSortChange` is ignored — warned in dev);
     * omit both for the classic self-sorting behavior.
     */
    sort?: SortState;
    onSortChange?: (sort: SortState) => void;
    /**
     * Opt-in client-side pagination (#221). When set, the table paginates its
     * POST-SORT rows via {@link usePagination} and renders a `<Pagination>`
     * footer; sorting still reorders the whole list first, and a sort change
     * resets to page 1 (the sorted array's identity changes). Omitting
     * `pageSize` leaves every existing consumer byte-for-byte unchanged: all
     * rows render, no footer. Page size per view is the caller's choice.
     */
    pageSize?: number;
    /** Accessible label for the pager's `<nav>` when `pageSize` is set. */
    paginationLabel?: string;
}

const ALIGN_CLASS: Record<'left' | 'right' | 'center', string> = {
    left: 'text-left',
    right: 'text-right',
    center: 'text-center',
};

function isSortable<T>(col: Column<T>, controlled: boolean): boolean {
    // Controlled mode: the parent comparator owns the ordering, so an explicit
    // flag wins and a render-only column may force-enable; otherwise the
    // accessor decides. Self-sorting mode stays FAIL-CLOSED: only accessor
    // columns can actually sort, so a force-enabled render-only column must
    // not show a header that would announce a sort it can't perform.
    if (controlled) return col.sortable ?? col.accessor !== undefined;
    return col.accessor !== undefined && col.sortable !== false;
}

function compareValues(a: string | number, b: string | number): number {
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }
    return String(a).localeCompare(String(b), undefined, {numeric: true});
}

/**
 * Generic, sortable table used by the teams list, waste list, and any other
 * tabular view. Sorting is client-side and stable: clicking a sortable header
 * toggles asc/desc; switching columns starts ascending. Columns declare an
 * `accessor` for their sort/text value and an optional `render` for rich cells.
 */
export function DataTable<T>({
    columns,
    rows,
    getRowKey,
    initialSort,
    emptyMessage = 'No rows to show',
    caption,
    sort: controlledSort,
    onSortChange,
    pageSize,
    paginationLabel,
}: DataTableProps<T>): JSX.Element {
    const controlled = onSortChange !== undefined;
    const [internalSort, setInternalSort] = useState<SortState | null>(initialSort ?? null);
    // In controlled mode the parent's sort drives the header indicators and the
    // rows arrive pre-sorted; otherwise this component owns both.
    const sort = controlled ? controlledSort ?? null : internalSort;

    // Dev-time guard against half-configuring the controlled seam: both halves
    // silently misbehave otherwise (an ignored `sort`, or dead `initialSort`).
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        if (controlledSort !== undefined && !controlled) {
            console.warn('DataTable: `sort` was provided without `onSortChange` — it is ignored. Pass both for controlled sorting.');
        }
        if (controlled && initialSort !== undefined) {
            console.warn('DataTable: `initialSort` is ignored when sorting is controlled; drive `sort` instead.');
        }
        // Mount-only sanity check: the mode is a structural choice, not runtime state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const sortedRows = useMemo(() => {
        if (controlled || !sort) {
            return rows;
        }
        const col = columns.find((c) => c.key === sort.key);
        if (!col?.accessor) {
            return rows;
        }
        const accessor = col.accessor;
        const factor = sort.direction === 'asc' ? 1 : -1;
        // Copy before sorting so we never mutate the caller's array. Null
        // accessor values ("no data") sort to the END in both directions —
        // handled OUTSIDE the direction factor so they never flip to the front
        // on a descending sort, and so two nulls compare equal (a total order;
        // never a NaN from e.g. -Infinity − -Infinity).
        return [...rows].sort((a, b) => {
            const av = accessor(a);
            const bv = accessor(b);
            const aNull = av === null;
            const bNull = bv === null;
            if (aNull || bNull) {
                return aNull === bNull ? 0 : aNull ? 1 : -1;
            }
            return factor * compareValues(av, bv);
        });
    }, [rows, columns, sort, controlled]);

    // Pagination applies AFTER sorting, over the fully-ordered list. The hook is
    // called unconditionally (rules of hooks); when `pageSize` is omitted we feed
    // it a page big enough to hold everything, so it yields a single page and the
    // pager renders nothing — `displayRows` then stays the untouched sorted list.
    const paged = usePagination(sortedRows, pageSize && pageSize > 0 ? pageSize : Number.MAX_SAFE_INTEGER);
    const paginated = pageSize !== undefined && pageSize > 0;
    const displayRows = paginated ? paged.pageItems : sortedRows;

    function toggleSort(key: string): void {
        const next = (current: SortState | null): SortState => {
            if (current?.key === key) {
                return {key, direction: current.direction === 'asc' ? 'desc' : 'asc'};
            }
            return {key, direction: 'asc'};
        };
        if (onSortChange) {
            onSortChange(next(sort));
        } else {
            setInternalSort(next);
        }
    }

    const table = (
        <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full border-collapse text-sm">
                {caption ? <caption className="sr-only">{caption}</caption> : null}
                <thead>
                    <tr className="border-b border-border bg-surface-raised">
                        {columns.map((col) => {
                            const sortable = isSortable(col, controlled);
                            // A non-sortable header must never announce a sort,
                            // even if a (misused) sort prop names its key.
                            const active = sortable && sort?.key === col.key;
                            const align = col.align ?? 'left';
                            return (
                                <th
                                    key={col.key}
                                    scope="col"
                                    aria-sort={active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                                    className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted ${ALIGN_CLASS[align]}`}
                                >
                                    {sortable ? (
                                        <button
                                            type="button"
                                            onClick={() => toggleSort(col.key)}
                                            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                                        >
                                            {col.header}
                                            <span aria-hidden className={active ? 'text-foreground' : 'text-muted/50'}>
                                                {active ? (sort?.direction === 'asc' ? '▲' : '▼') : '↕'}
                                            </span>
                                        </button>
                                    ) : (
                                        col.header
                                    )}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {displayRows.length === 0 ? (
                        <tr>
                            <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-muted">
                                {emptyMessage}
                            </td>
                        </tr>
                    ) : (
                        displayRows.map((row) => (
                            <tr
                                key={getRowKey(row)}
                                className="border-b border-border last:border-0 hover:bg-surface-raised"
                            >
                                {columns.map((col) => {
                                    const align = col.align ?? 'left';
                                    const content = col.render ? col.render(row) : col.accessor ? col.accessor(row) : null;
                                    return (
                                        <td key={col.key} className={`px-4 py-3 text-foreground ${ALIGN_CLASS[align]}`}>
                                            {content}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );

    // Byte-for-byte unchanged for existing consumers: no `pageSize` → just the
    // scroll container, no wrapper, no footer.
    if (!paginated) return table;

    return (
        <div className="flex flex-col gap-3">
            {table}
            <div className="flex justify-end">
                <Pagination
                    page={paged.page}
                    pageCount={paged.pageCount}
                    onPageChange={paged.setPage}
                    ariaLabel={paginationLabel ?? (typeof caption === 'string' ? caption : 'Pagination')}
                />
            </div>
        </div>
    );
}
