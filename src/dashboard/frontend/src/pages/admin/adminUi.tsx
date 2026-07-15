import type {ReactNode} from 'react';

import {Pagination} from '../../components/Pagination';
import {usePagination, type PageSizeOption} from '../../components/usePagination';

/**
 * Small presentational primitives shared by the Admin Management screens
 * (Task 2.13). Centralized so every admin form/table reads consistently and
 * matches the dashboard aesthetic (token-driven colors, desktop layout).
 */

/**
 * A screen's title block, with an optional `actions` slot on the trailing edge
 * for the screen's primary affordance — epic #236's "＋ New …" button that opens
 * the create `FormModal`. Omitting `actions` renders exactly the title block
 * every existing admin screen already shows.
 */
export function PageHeader({
    title,
    description,
    actions,
}: {
    title: string;
    description: string;
    actions?: ReactNode;
}): JSX.Element {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
                <p className="mt-1 text-sm text-muted">{description}</p>
            </div>
            {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
    );
}

export function TextField({
    label,
    value,
    onChange,
    placeholder,
    type = 'text',
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    type?: string;
}): JSX.Element {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">{label}</span>
            <input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
            />
        </label>
    );
}

export function SelectField({
    label,
    value,
    onChange,
    children,
    disabled = false,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    children: ReactNode;
    /** Gate the control, e.g. while its options are still loading. */
    disabled?: boolean;
}): JSX.Element {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">{label}</span>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
            >
                {children}
            </select>
        </label>
    );
}

export function PrimaryButton({
    children,
    onClick,
    disabled,
    type = 'button',
    ariaHasPopup,
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit';
    /** Set to 'dialog' on a button that opens a modal (announced to AT). */
    ariaHasPopup?: 'dialog';
}): JSX.Element {
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            aria-haspopup={ariaHasPopup}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
            {children}
        </button>
    );
}

export function SecondaryButton({
    children,
    onClick,
    disabled,
    ariaHasPopup,
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    /** Set to 'dialog' on a button that opens a modal (announced to AT). */
    ariaHasPopup?: 'dialog';
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-haspopup={ariaHasPopup}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50"
        >
            {children}
        </button>
    );
}

export function ErrorText({error}: {error: Error | null}): JSX.Element | null {
    if (!error) return null;
    return <span className="text-sm text-danger">{error.message}</span>;
}

/**
 * Whether a select whose options come from a query must stay disabled, and the
 * placeholder to show while it is.
 *
 * A select fed by an unresolved query must never be enabled-and-empty: it reads
 * as "there are none" and invites a write against a roster that never loaded.
 * Gating on `isPending` alone only covers half of it — a FAILED query settles to
 * `isPending === false` with no data, so the control would flip from a disabled
 * "Loading…" to an enabled list holding nothing but the placeholder, with the
 * failure surfaced nowhere. Both non-ready states gate.
 */
export function optionsGate(
    query: {isPending: boolean; isError: boolean},
    labels: {loading: string; failed: string},
): {disabled: boolean; label: string | null} {
    if (query.isPending) return {disabled: true, label: labels.loading};
    if (query.isError) return {disabled: true, label: labels.failed};
    // `null`, not a caller-supplied "ready" label: a screen that renders its
    // placeholder only while gated has no ready label to give, and forcing one
    // means passing a dummy string that is never read.
    return {disabled: false, label: null};
}

/**
 * A one-time temporary-password banner shown after create / reset.
 *
 * `role="status"` is load-bearing since #239: the reveal now appears on the PAGE
 * after the create dialog unmounts and `Modal` restores focus to the header
 * button — so it lands nowhere near the user's focus. It is shown exactly once
 * and cannot be recovered, so an unannounced reveal is a lost password.
 */
export function TempPasswordBanner({password, onDismiss}: {password: string; onDismiss: () => void}): JSX.Element {
    return (
        <div
            role="status"
            className="flex items-center justify-between gap-4 rounded-md border border-accent/40 bg-accent-soft px-4 py-3"
        >
            <div className="text-sm text-foreground">
                Temporary password (shown once — copy it now):{' '}
                <code className="font-mono font-semibold">{password}</code>
            </div>
            <button type="button" onClick={onDismiss} className="text-xs font-medium text-accent">
                Dismiss
            </button>
        </div>
    );
}

export function Table({head, children}: {head: ReactNode; children: ReactNode}): JSX.Element {
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
                <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                        {head}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

export function Th({children}: {children: ReactNode}): JSX.Element {
    return <th className="px-3 py-2 font-medium">{children}</th>;
}

/**
 * The raw `<Table>` plus shared client-side pagination (#225): one canonical
 * wrapper so no admin view hand-rolls the `usePagination` + `<Pagination>`
 * wiring. Pass the fully-fetched `rows` (a STABLE reference — a filtered query's
 * data, not a fresh array each render, or the pager resets to page 1) and a
 * `renderRow` that returns the `<tr>` for one row (own its own `key`). Only the
 * current page's rows render; the pager appears below when there is more than
 * one page. Filter/search-driven changes arrive as a new `rows` reference, which
 * resets to page 1 via the hook.
 */
export function PaginatedTable<T>({
    head,
    rows,
    renderRow,
    pageSize = 25,
    ariaLabel = 'Table pages',
    pageSizeOptions,
    storageKey,
}: {
    head: ReactNode;
    rows: T[];
    renderRow: (row: T) => ReactNode;
    /** Initial rows-per-page; the footer selector lets the user change it. */
    pageSize?: number;
    ariaLabel?: string;
    pageSizeOptions?: readonly PageSizeOption[];
    /** `localStorage` key to persist the chosen page size for this table. */
    storageKey?: string;
}): JSX.Element {
    const paged = usePagination(rows, pageSize, {pageSizeOptions, storageKey});
    return (
        <div className="flex flex-col gap-3">
            <Table head={head}>{paged.pageItems.map(renderRow)}</Table>
            {/* Self-gating (renders nothing when there is neither a second page
                nor enough rows for the size selector to matter). */}
            <Pagination
                page={paged.page}
                pageCount={paged.pageCount}
                onPageChange={paged.setPage}
                pageSize={paged.pageSize}
                pageSizeOptions={paged.pageSizeOptions}
                onPageSizeChange={paged.setPageSize}
                totalItems={rows.length}
                ariaLabel={ariaLabel}
            />
        </div>
    );
}

export function Td({children}: {children: ReactNode}): JSX.Element {
    return <td className="px-3 py-2 text-foreground">{children}</td>;
}
