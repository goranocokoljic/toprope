import {useEffect, useRef, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

// Everything a keyboard can land on inside the dialog — used by the focus trap.
const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Module-level registry of open modals, in mount order. Drives two behaviors:
// document-level keyboard handling responds only on the TOPMOST modal (so Esc
// with focus outside every dialog closes one dialog, not all), and the body
// scroll lock is released only when the LAST modal closes (no LIFO assumption).
const openModals: symbol[] = [];
// The body's inline overflow before the FIRST modal locked it — restored, not
// clobbered to '', when the last modal closes.
let previousBodyOverflow = '';

/**
 * Accessible modal dialog (#213). Rendered through a portal so it can be
 * mounted from anywhere (including inside a table) without breaking DOM
 * nesting. The caller owns open/close state — render the modal only while
 * open. Behaviors:
 *  - Focus moves onto the dialog on open and back to the opener on close
 *    (skipped if the opener has unmounted meanwhile).
 *  - Tab is TRAPPED inside the dialog (aria-modal promises an inert
 *    background). The trap survives focus escaping the subtree (e.g. a
 *    just-clicked pagination button disabling itself blurs focus to <body>):
 *    a document-level listener on the topmost modal pulls focus back on Tab
 *    and keeps Escape working.
 *  - Body scroll is locked while any modal is open (ref-counted).
 *  - Escape closes the topmost dialog only; the event does not propagate.
 *  - A backdrop CLICK closes only when the interaction both STARTED and ENDED
 *    on the backdrop: `click` fires on the common ancestor of mousedown and
 *    mouseup, so a drag in either direction (text selection escaping the
 *    dialog, or a mis-press on the dim area corrected onto the dialog) must
 *    NOT discard the dialog's unsaved state.
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
    const mouseUpOnBackdrop = useRef(false);
    const modalId = useRef(Symbol('modal'));
    // Latest onClose without re-subscribing the document listener every render.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

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
        const id = modalId.current;
        if (openModals.length === 0) previousBodyOverflow = document.body.style.overflow;
        openModals.push(id);
        document.body.style.overflow = 'hidden';

        // Keyboard backstop for focus that escaped the dialog subtree — the
        // element-level handler below never sees those events. Topmost modal only.
        function onDocumentKeyDown(event: KeyboardEvent): void {
            if (openModals[openModals.length - 1] !== id) return;
            const dialog = dialogRef.current;
            if (!dialog || dialog.contains(event.target as Node)) return;
            if (event.key === 'Escape') {
                onCloseRef.current();
            } else if (event.key === 'Tab') {
                event.preventDefault();
                dialog.focus();
            }
        }
        document.addEventListener('keydown', onDocumentKeyDown);

        return () => {
            document.removeEventListener('keydown', onDocumentKeyDown);
            // Guarded: splice(-1, 1) would silently evict the TOPMOST entry.
            const index = openModals.indexOf(id);
            if (index !== -1) openModals.splice(index, 1);
            if (openModals.length === 0) document.body.style.overflow = previousBodyOverflow;
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
            onMouseUp={(e) => {
                mouseUpOnBackdrop.current = e.target === e.currentTarget;
            }}
            onClick={(e) => {
                // Close only for a genuine backdrop click: press AND release
                // both landed on the backdrop itself — never a drag that
                // crossed the dialog boundary in either direction.
                if (
                    e.target === e.currentTarget &&
                    mouseDownOnBackdrop.current &&
                    mouseUpOnBackdrop.current
                ) {
                    onClose();
                }
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
