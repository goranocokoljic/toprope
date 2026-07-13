// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {useState} from 'react';
import {Modal} from '../components/Modal';

/**
 * Unit tests for the reusable Modal (#213): focus management (move-in on open,
 * restore-to-opener on close), the Tab focus trap behind aria-modal, Escape
 * closing without leaking to a sibling dialog, drag-release NOT closing (only a
 * genuine backdrop click does), and the body scroll lock.
 */

function Harness({children}: {children?: React.ReactNode}): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <div>
            <button type="button" onClick={() => setOpen(true)}>
                Open
            </button>
            {open ? (
                <Modal title="Test dialog" onClose={() => setOpen(false)} testId="test-modal">
                    {children ?? (
                        <>
                            <input aria-label="First field" />
                            <button type="button">Last button</button>
                        </>
                    )}
                </Modal>
            ) : null}
        </div>
    );
}

afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
});

describe('Modal — focus management', () => {
    it('moves focus onto the dialog on open and restores it to the opener on close', () => {
        render(<Harness />);
        const opener = screen.getByRole('button', {name: 'Open'});
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', {name: 'Test dialog'});
        expect(document.activeElement).toBe(dialog);

        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(document.activeElement).toBe(opener);
    });

    it('closes on Escape fired from the actually-focused element inside the dialog', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const field = screen.getByLabelText('First field');
        field.focus();
        fireEvent.keyDown(field, {key: 'Escape'});
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('traps Tab: wraps from the last focusable to the first, and Shift+Tab from the first to the last', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const dialog = screen.getByRole('dialog');
        const closeButton = screen.getByRole('button', {name: 'Close dialog'});
        const lastButton = screen.getByRole('button', {name: 'Last button'});

        // Tab from the last focusable wraps to the first (the × close button).
        lastButton.focus();
        fireEvent.keyDown(dialog, {key: 'Tab'});
        expect(document.activeElement).toBe(closeButton);

        // Shift+Tab from the first focusable wraps back to the last.
        closeButton.focus();
        fireEvent.keyDown(dialog, {key: 'Tab', shiftKey: true});
        expect(document.activeElement).toBe(lastButton);

        // Shift+Tab from the dialog container itself (initial focus) also wraps.
        dialog.focus();
        fireEvent.keyDown(dialog, {key: 'Tab', shiftKey: true});
        expect(document.activeElement).toBe(lastButton);
    });
});

describe('Modal — dismissal', () => {
    it('a genuine backdrop click (press AND release on the backdrop) closes', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const backdrop = screen.getByTestId('test-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('a drag that starts inside the dialog and releases over the backdrop does NOT close', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const backdrop = screen.getByTestId('test-modal-backdrop');
        // Press inside the dialog (e.g. selecting filter text)…
        fireEvent.mouseDown(screen.getByLabelText('First field'));
        // …release over the dim area: the browser dispatches click on the
        // common ancestor — the backdrop. The dialog must survive.
        fireEvent.click(backdrop);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('clicks inside the dialog never close it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const field = screen.getByLabelText('First field');
        fireEvent.mouseDown(field);
        fireEvent.click(field);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
});

describe('Modal — page interaction', () => {
    it('locks body scroll while open and restores it on close', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        expect(document.body.style.overflow).toBe('hidden');
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(document.body.style.overflow).toBe('');
    });
});
