import {useCallback, useState} from 'react';

export type ModalMode = 'closed' | 'create' | 'edit';

export type ModalState<T> = {
    mode: ModalMode;
    /** The row being edited in `'edit'` mode; null in `'closed'` and `'create'`. */
    editing: T | null;
    openCreate: () => void;
    openEdit: (row: T) => void;
    close: () => void;
};

/**
 * Open / which-row / reset state for a create-or-edit `FormModal` (#237), so no
 * admin screen hand-rolls it.
 *
 * `mode` and `editing` live in ONE state object: they are updated together and
 * so can never disagree (an `'edit'` mode with a stale null row, or a `'create'`
 * still carrying the last edited row). Render the modal only while
 * `mode !== 'closed'`, and remount its body on `editing?.id ?? 'new'` so fields
 * reset between different rows.
 */
export function useModalState<T>(): ModalState<T> {
    const [state, setState] = useState<{mode: ModalMode; editing: T | null}>({
        mode: 'closed',
        editing: null,
    });

    const openCreate = useCallback(() => setState({mode: 'create', editing: null}), []);
    const openEdit = useCallback((row: T) => setState({mode: 'edit', editing: row}), []);
    const close = useCallback(() => setState({mode: 'closed', editing: null}), []);

    return {mode: state.mode, editing: state.editing, openCreate, openEdit, close};
}
