// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react';
import {FormModal} from '../components/FormModal';
import {useModalState} from '../components/useModalState';

/**
 * Unit tests for the modal foundation (#237): the `FormModal` footer contract
 * (Save/Cancel/ErrorText, the pending + submitDisabled gates) and — the reason
 * the wrapper exists — the close-guard that makes EVERY dismiss affordance
 * (Cancel, Esc, ×) inert while a write is in flight. Plus the `useModalState`
 * create/edit/close transitions.
 *
 * A backdrop click is deliberately absent from that table since #265: `Modal`
 * no longer closes on one at all, so it is not an affordance the guard can be
 * proven on. It gets its own always-inert test instead.
 */

afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
});

/** Every close affordance, so the pending guard is proven on all three. */
function closeAffordances(): Array<{name: string; dismiss: () => void}> {
    return [
        {name: 'Cancel', dismiss: () => fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))},
        {
            name: 'the × button',
            dismiss: () => fireEvent.click(screen.getByRole('button', {name: 'Close dialog'})),
        },
        {
            name: 'Escape',
            dismiss: () => fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'}),
        },
    ];
}

function clickBackdrop(): void {
    const backdrop = screen.getByTestId('form-modal-backdrop');
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
}

function renderFormModal(props: Partial<React.ComponentProps<typeof FormModal>> = {}): {
    onClose: ReturnType<typeof vi.fn>;
    onSubmit: ReturnType<typeof vi.fn>;
} {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    render(
        <FormModal title="Add git provider" onClose={onClose} onSubmit={onSubmit} testId="form-modal" {...props}>
            <input aria-label="Container" />
        </FormModal>,
    );
    return {onClose, onSubmit};
}

describe('FormModal — rendering', () => {
    it('renders the Modal header, the form body, and a Save + Cancel footer', () => {
        renderFormModal();
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
        expect(screen.getByRole('heading', {name: 'Add git provider'})).toBeInTheDocument();
        expect(screen.getByLabelText('Container')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'Save'})).toBeEnabled();
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeEnabled();
    });

    it('submits through onSubmit when Save is clicked', () => {
        const {onSubmit} = renderFormModal();
        fireEvent.click(screen.getByRole('button', {name: 'Save'}));
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('uses the configured submit label, and swaps to the pending label while pending', () => {
        const {unmount} = render(
            <FormModal title="t" onClose={vi.fn()} onSubmit={vi.fn()} submitLabel="Create user" pendingLabel="Creating…">
                <span />
            </FormModal>,
        );
        expect(screen.getByRole('button', {name: 'Create user'})).toBeInTheDocument();
        expect(screen.queryByRole('button', {name: 'Creating…'})).not.toBeInTheDocument();
        unmount();

        render(
            <FormModal
                title="t"
                onClose={vi.fn()}
                onSubmit={vi.fn()}
                submitLabel="Create user"
                pendingLabel="Creating…"
                pending
            >
                <span />
            </FormModal>,
        );
        expect(screen.getByRole('button', {name: 'Creating…'})).toBeInTheDocument();
        expect(screen.queryByRole('button', {name: 'Create user'})).not.toBeInTheDocument();
    });

    it('renders an error through ErrorText, and nothing when there is no error', () => {
        renderFormModal({error: new Error('Container is required')});
        expect(screen.getByText('Container is required')).toBeInTheDocument();
        cleanup();

        renderFormModal();
        expect(screen.queryByText('Container is required')).not.toBeInTheDocument();
    });
});

describe('FormModal — Save gating', () => {
    it('disables Save and ignores clicks while submitDisabled', () => {
        const {onSubmit} = renderFormModal({submitDisabled: true});
        const save = screen.getByRole('button', {name: 'Save'});
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('disables Save and ignores clicks while pending', () => {
        const {onSubmit} = renderFormModal({pending: true});
        const save = screen.getByRole('button', {name: 'Saving…'});
        expect(save).toBeDisabled();
        fireEvent.click(save);
        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe('FormModal — close guard while pending', () => {
    for (const {name, dismiss} of closeAffordances()) {
        it(`closes via ${name} when idle`, () => {
            const {onClose} = renderFormModal();
            dismiss();
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it(`does NOT close via ${name} while pending`, () => {
            const {onClose} = renderFormModal({pending: true});
            dismiss();
            expect(onClose).not.toHaveBeenCalled();
        });
    }

    it('disables Cancel while pending', () => {
        renderFormModal({pending: true});
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
    });

    // #265: not a guarded affordance — a backdrop click is inert UNCONDITIONALLY.
    // Only the IDLE case is worth asserting: it is the one that used to discard a
    // filled-in form, and a re-introduced close path would route through
    // `requestClose`, which the pending branch already blocks — so a pending
    // variant could not fail while this passes. Guards against FormModal (or a
    // future Modal change) re-arming dismissal on the dim area.
    it('never closes on a backdrop click, even when idle', () => {
        const {onClose} = renderFormModal();
        clickBackdrop();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', {name: 'Add git provider'})).toBeInTheDocument();
    });
});

type Row = {id: string; name: string};

describe('useModalState', () => {
    const alice: Row = {id: 'a', name: 'Alice'};
    const bob: Row = {id: 'b', name: 'Bob'};

    it('starts closed with no row', () => {
        const {result} = renderHook(() => useModalState<Row>());
        expect(result.current.mode).toBe('closed');
        expect(result.current.editing).toBeNull();
    });

    it('openCreate opens create mode with editing === null', () => {
        const {result} = renderHook(() => useModalState<Row>());
        act(() => result.current.openCreate());
        expect(result.current.mode).toBe('create');
        expect(result.current.editing).toBeNull();
    });

    it('openEdit opens edit mode carrying the passed row', () => {
        const {result} = renderHook(() => useModalState<Row>());
        act(() => result.current.openEdit(alice));
        expect(result.current.mode).toBe('edit');
        expect(result.current.editing).toEqual(alice);
    });

    it('openEdit for a different row exposes the new row', () => {
        const {result} = renderHook(() => useModalState<Row>());
        act(() => result.current.openEdit(alice));
        act(() => result.current.openEdit(bob));
        expect(result.current.mode).toBe('edit');
        expect(result.current.editing).toEqual(bob);
    });

    it('close returns to closed and drops the edited row', () => {
        const {result} = renderHook(() => useModalState<Row>());
        act(() => result.current.openEdit(alice));
        act(() => result.current.close());
        expect(result.current.mode).toBe('closed');
        expect(result.current.editing).toBeNull();
    });

    it('openCreate after an edit clears the previously edited row', () => {
        const {result} = renderHook(() => useModalState<Row>());
        act(() => result.current.openEdit(alice));
        act(() => result.current.openCreate());
        expect(result.current.mode).toBe('create');
        expect(result.current.editing).toBeNull();
    });

    it('keeps its callbacks stable across renders so they are safe as effect deps', () => {
        const {result, rerender} = renderHook(() => useModalState<Row>());
        const first = {
            openCreate: result.current.openCreate,
            openEdit: result.current.openEdit,
            close: result.current.close,
        };
        act(() => result.current.openEdit(alice));
        rerender();
        expect(result.current.openCreate).toBe(first.openCreate);
        expect(result.current.openEdit).toBe(first.openEdit);
        expect(result.current.close).toBe(first.close);
    });
});
