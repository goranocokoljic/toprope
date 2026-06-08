import {useMemo, useState, type ReactNode} from 'react';

export type SortDirection = 'asc' | 'desc';

export interface Column<T> {
    /** Stable column id; also the sort key. */
    key: string;
    header: ReactNode;
    /**
     * Value used for the default cell text AND for sorting. Provide for any
     * sortable column. Columns with only `render` and no `accessor` are not
     * sortable. Return `null` for a row with no value in this column — such rows
     * always sort to the END, in BOTH directions (see the sort comparator), so a
     * "no data" row never reads as the best or worst ranked value.
     */
    accessor?: (row: T) => string | number | null;
    /** Custom cell renderer; falls back to the accessor value. */
    render?: (row: T) => ReactNode;
    align?: 'left' | 'right' | 'center';
    /** Force-disable sorting even when an accessor is present. */
    sortable?: boolean;
}

export interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    /** Stable key per row (for React reconciliation). */
    getRowKey: (row: T) => string;
    initialSort?: {key: string; direction: SortDirection};
    emptyMessage?: string;
    caption?: string;
}

const ALIGN_CLASS: Record<'left' | 'right' | 'center', string> = {
    left: 'text-left',
    right: 'text-right',
    center: 'text-center',
};

function isSortable<T>(col: Column<T>): boolean {
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
}: DataTableProps<T>): JSX.Element {
    const [sort, setSort] = useState<{key: string; direction: SortDirection} | null>(initialSort ?? null);

    const sortedRows = useMemo(() => {
        if (!sort) {
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
    }, [rows, columns, sort]);

    function toggleSort(key: string): void {
        setSort((current) => {
            if (current?.key === key) {
                return {key, direction: current.direction === 'asc' ? 'desc' : 'asc'};
            }
            return {key, direction: 'asc'};
        });
    }

    return (
        <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full border-collapse text-sm">
                {caption ? <caption className="sr-only">{caption}</caption> : null}
                <thead>
                    <tr className="border-b border-border bg-surface-raised">
                        {columns.map((col) => {
                            const sortable = isSortable(col);
                            const active = sort?.key === col.key;
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
                    {sortedRows.length === 0 ? (
                        <tr>
                            <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-muted">
                                {emptyMessage}
                            </td>
                        </tr>
                    ) : (
                        sortedRows.map((row) => (
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
}
