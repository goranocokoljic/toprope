import {useEffect, useRef, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

// Everything a keyboard can land on inside the dialog — used by the focus trap.
const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog (#213). Rendered through a portal so it can be
 * mounted from anywhere (including inside a table) without breaking DOM
 * nesting. The caller owns open/close state — render the modal only while
 * open. Behaviors:
 *  - Focus moves onto the dialog on open and back to the opener on close
 *    (skipped if the opener has unmounted meanwhile).
 *  - Tab is TRAPPED inside the dialog (aria-modal promises an inert
 *    background — without the trap, focus walks into the covered page and
 *    Escape goes dead once it leaves the dialog subtree).
 *  - Body scroll is locked while any modal is open.
 *  - Escape closes; the event does not propagate further (a stacked dialog
 *    must not close its sibling).
 *  - A backdrop CLICK closes only when the interaction also STARTED on the
 *    backdrop: `click` fires on the common ancestor of mousedown/mouseup, so
 *    a drag that starts inside the dialog (text selection in a filter input,
 *    a sloppy checkbox press) and releases over the dimmed area must NOT
 *    discard the dialog's unsaved state.
 */
export function Modal({
    title,
    onClose,
    children,
    testId,
}: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    testId?: string;
}): JSX.Element {
    const dialogRef = useRef<HTMLDivElement>(null);
    const mouseDownOnBackdrop = useRef(false);

    useEffect(() => {
        // Move focus into the dialog; restore it to the opener on close unless
        // the opener has been unmounted in the meantime (e.g. the add form's
        // Save button after the #211 auto-open).
        const opener = document.activeElement as HTMLElement | null;
        dialogRef.current?.focus();
        return () => {
            if (opener && document.contains(opener)) opener.focus();
        };
    }, []);

    useEffect(() => {
        // Lock body scroll while open. Restores the previous value so stacked
        // modals closing in LIFO order unwind correctly.
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, []);

    function onKeyDown(event: React.KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key === 'Tab') {
            // Focus trap: wrap Tab/Shift+Tab at the dialog's edges.
            const dialog = dialogRef.current;
            if (!dialog) return;
            const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || active === dialog)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onMouseDown={(e) => {
                mouseDownOnBackdrop.current = e.target === e.currentTarget;
            }}
            onClick={(e) => {
                // Close only for a genuine backdrop click: both the press and
                // the release happened on the backdrop itself.
                if (e.target === e.currentTarget && mouseDownOnBackdrop.current) onClose();
            }}
            data-testid={testId ? `${testId}-backdrop` : undefined}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
                onKeyDown={onKeyDown}
                className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl outline-none"
                data-testid={testId}
            >
                <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <h2 className="text-sm font-semibold text-foreground">{title}</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close dialog"
                        className="rounded-md px-2 py-0.5 text-lg leading-none text-muted transition-colors hover:text-foreground"
                    >
                        ×
                    </button>
                </div>
                <div className="overflow-y-auto px-5 py-4">{children}</div>
            </div>
        </div>,
        document.body,
    );
}
