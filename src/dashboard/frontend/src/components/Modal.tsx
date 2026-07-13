import {useEffect, useRef, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

/**
 * Accessible modal dialog (#213). Rendered through a portal so it can be
 * mounted from anywhere (including inside a table) without breaking DOM
 * nesting. Focus moves onto the dialog on open; Escape and a backdrop click
 * both close it. The caller owns open/close state — render the modal only
 * while open.
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

    useEffect(() => {
        // Move focus into the dialog so keyboard/AT users land on it, and
        // restore focus to the opener when it closes.
        const opener = document.activeElement as HTMLElement | null;
        dialogRef.current?.focus();
        return () => opener?.focus();
    }, []);

    function onKeyDown(event: React.KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
        }
    }

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={onClose}
            data-testid={testId ? `${testId}-backdrop` : undefined}
        >
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
                keydown handles Escape for the whole dialog subtree */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
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
