// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {useState} from 'react';
import {Modal} from '../components/Modal';

/**
 * Unit tests for the reusable Modal (#213): focus management (move-in on open,
 * restore-to-opener on close), the Tab focus trap behind aria-modal — including
 * the document-level backstop for focus that escaped the dialog subtree —
 * Escape closing, NO mouse interaction on the dim area closing (#265: a
 * misplaced click must never discard unsaved input), and the body scroll lock.
 */

function Harness(): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <div>
            <button type="button" onClick={() => setOpen(true)}>
                Open
            </button>
            {open ? (
                <Modal title="Test dialog" onClose={() => setOpen(false)} testId="test-modal">
                    <input aria-label="First field" />
                    <button type="button">Last button</button>
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

    it('keeps Escape and Tab working when focus has escaped the dialog subtree (document-level backstop)', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const dialog = screen.getByRole('dialog');

        // Focus escapes to <body> — e.g. a just-clicked, now-disabled button.
        (document.activeElement as HTMLElement).blur();
        expect(document.activeElement).toBe(document.body);

        // Tab from the body is intercepted and pulled back into the dialog…
        fireEvent.keyDown(document.body, {key: 'Tab'});
        expect(document.activeElement).toBe(dialog);

        // …and Escape from the body still closes the dialog.
        (document.activeElement as HTMLElement).blur();
        fireEvent.keyDown(document.body, {key: 'Escape'});
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});

/**
 * Every mouse interaction that ends with `click` dispatched on the backdrop —
 * the browser fires `click` on the common ancestor of mousedown and mouseup, so
 * a drag in either direction lands there too. Since #265 NONE of them closes.
 */
function backdropInteractions(): Array<{name: string; interact: () => void}> {
    const backdrop = (): HTMLElement => screen.getByTestId('test-modal-backdrop');
    const field = (): HTMLElement => screen.getByLabelText('First field');
    return [
        {
            name: 'a genuine backdrop click (press AND release on the dim area)',
            interact: () => {
                fireEvent.mouseDown(backdrop());
                fireEvent.mouseUp(backdrop());
                fireEvent.click(backdrop());
            },
        },
        {
            name: 'a drag that starts inside the dialog and releases over the dim area',
            interact: () => {
                fireEvent.mouseDown(field());
                fireEvent.mouseUp(backdrop());
                fireEvent.click(backdrop());
            },
        },
        {
            name: 'the reverse drag — press on the dim area, release inside the dialog',
            interact: () => {
                fireEvent.mouseDown(backdrop());
                fireEvent.mouseUp(field());
                fireEvent.click(backdrop());
            },
        },
    ];
}

describe('Modal — dismissal', () => {
    // #265: the dim area is inert. A misplaced click outside a form must never
    // discard what was typed into it — Escape, × and Cancel are the only exits.
    for (const {name, interact} of backdropInteractions()) {
        it(`${name} leaves the dialog open`, () => {
            render(<Harness />);
            fireEvent.click(screen.getByRole('button', {name: 'Open'}));
            interact();
            expect(screen.getByRole('dialog')).toBeInTheDocument();
        });
    }

    it('a backdrop click leaves entered values intact — the data-loss regression', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const field = screen.getByLabelText('First field') as HTMLInputElement;
        fireEvent.change(field, {target: {value: 'ghp_secret'}});

        const backdrop = screen.getByTestId('test-modal-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop);

        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect((screen.getByLabelText('First field') as HTMLInputElement).value).toBe('ghp_secret');
    });

    it('the × button still closes', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('clicks inside the dialog never close it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        const field = screen.getByLabelText('First field');
        fireEvent.mouseDown(field);
        fireEvent.mouseUp(field);
        fireEvent.click(field);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
});

function StackedHarness(): JSX.Element {
    const [a, setA] = useState(false);
    const [b, setB] = useState(false);
    return (
        <div>
            <button type="button" onClick={() => setA(true)}>
                Open A
            </button>
            <button type="button" onClick={() => setB(true)}>
                Open B
            </button>
            {a ? (
                <Modal title="Dialog A" onClose={() => setA(false)} testId="modal-a">
                    <button type="button">A content</button>
                </Modal>
            ) : null}
            {b ? (
                <Modal title="Dialog B" onClose={() => setB(false)} testId="modal-b">
                    <button type="button">B content</button>
                </Modal>
            ) : null}
        </div>
    );
}

describe('Modal — page interaction', () => {
    it('locks body scroll while open and restores it on close', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        expect(document.body.style.overflow).toBe('hidden');
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(document.body.style.overflow).toBe('');
    });

    it('restores the body overflow value that existed before the first modal opened', () => {
        document.body.style.overflow = 'scroll';
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open'}));
        expect(document.body.style.overflow).toBe('hidden');
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(document.body.style.overflow).toBe('scroll');
    });

    it('keeps the scroll lock while ANY modal remains open, including non-LIFO closes', () => {
        render(<StackedHarness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open A'}));
        fireEvent.click(screen.getByRole('button', {name: 'Open B'}));
        expect(document.body.style.overflow).toBe('hidden');

        // Close A FIRST (non-LIFO): B is still open, so the lock must hold.
        const dialogA = screen.getByTestId('modal-a');
        fireEvent.click(within(dialogA).getByRole('button', {name: 'Close dialog'}));
        expect(screen.queryByTestId('modal-a')).not.toBeInTheDocument();
        expect(document.body.style.overflow).toBe('hidden');

        // Closing the last modal releases the lock.
        fireEvent.click(screen.getByRole('button', {name: 'Close dialog'}));
        expect(document.body.style.overflow).toBe('');
    });

    it('document-level Escape closes only the TOPMOST of stacked modals', () => {
        render(<StackedHarness />);
        fireEvent.click(screen.getByRole('button', {name: 'Open A'}));
        fireEvent.click(screen.getByRole('button', {name: 'Open B'}));
        expect(screen.getAllByRole('dialog')).toHaveLength(2);

        // Focus escaped every dialog: Escape from the body must close B (the
        // topmost/last-opened), never both.
        (document.activeElement as HTMLElement).blur();
        fireEvent.keyDown(document.body, {key: 'Escape'});
        expect(screen.queryByTestId('modal-b')).not.toBeInTheDocument();
        expect(screen.getByTestId('modal-a')).toBeInTheDocument();

        // A second body-level Escape closes the remaining dialog.
        (document.activeElement as HTMLElement).blur();
        fireEvent.keyDown(document.body, {key: 'Escape'});
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
