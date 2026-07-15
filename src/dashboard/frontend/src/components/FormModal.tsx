import type {ReactNode} from 'react';

import {ErrorText, PrimaryButton, SecondaryButton} from '../pages/admin/adminUi';
import {Modal} from './Modal';

/**
 * The shared create/edit form dialog (#237) — `Modal` plus the footer every
 * admin form repeats: a primary Save, a Cancel, and inline `ErrorText`.
 *
 * It owns the close-guard-while-pending contract lifted from
 * `RepoScopeModal.requestClose`: EVERY close affordance (Cancel, Esc, ×,
 * backdrop) funnels through one guard, so a dismiss mid-write can't let the
 * mutation land — or fail — invisibly. Migrated screens must not re-implement
 * it.
 *
 * The caller owns open/close state (render the modal only while open) and the
 * form body; `children` are the fields, which this component does not touch.
 */
export function FormModal({
    title,
    onClose,
    onSubmit,
    submitLabel = 'Save',
    pendingLabel = 'Saving…',
    pending = false,
    submitDisabled = false,
    error = null,
    children,
    testId,
}: {
    title: string;
    /** Called only when no write is in flight — see the pending guard. */
    onClose: () => void;
    onSubmit: () => void;
    submitLabel?: string;
    /** Save's label while `pending`. */
    pendingLabel?: string;
    /** True while the write is in flight: disables Save and inhibits closing. */
    pending?: boolean;
    /** Caller-owned validation gate on Save (independent of `pending`). */
    submitDisabled?: boolean;
    error?: Error | null;
    children: ReactNode;
    testId?: string;
}): JSX.Element {
    function requestClose(): void {
        if (!pending) onClose();
    }

    // Self-enforcing mirror of Save's disabled state, so no future affordance
    // (keyboard wiring, a form submit) can bypass the caller's gate.
    function requestSubmit(): void {
        if (pending || submitDisabled) return;
        onSubmit();
    }

    return (
        <Modal title={title} onClose={requestClose} testId={testId}>
            {children}
            <div className="mt-4 flex items-center gap-3">
                <PrimaryButton onClick={requestSubmit} disabled={pending || submitDisabled}>
                    {pending ? pendingLabel : submitLabel}
                </PrimaryButton>
                <SecondaryButton onClick={requestClose} disabled={pending}>
                    Cancel
                </SecondaryButton>
                <ErrorText error={error} />
            </div>
        </Modal>
    );
}
