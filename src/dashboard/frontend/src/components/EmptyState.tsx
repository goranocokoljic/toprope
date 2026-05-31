import type {ReactNode} from 'react';
import {StatePanel, type StatePanelAction} from './StatePanel';

/**
 * Genuine-empty state: a real, settled signal that there is nothing here — not
 * because collection is still warming up (that's <ColdStartPanel>), but because
 * the data is in and the honest answer is "none". Example: a seat with zero
 * activity over a full significance window. The calm, neutral framing (no
 * "in progress" language) is what keeps it semantically distinct from
 * cold-start.
 *
 * Part of the shared data-state library. Its first consumers are the
 * list-bearing screens not yet built (Waste, Teams, My Tools — tasks 2.5–2.9);
 * it ships here with the rest of the family so those screens reuse it rather
 * than re-inventing an empty treatment, the same way 2.10 shipped shared
 * components ahead of their screens.
 */

export interface EmptyStateProps {
    title?: string;
    message?: ReactNode;
    icon?: ReactNode;
    action?: StatePanelAction;
    testId?: string;
}

function InboxIcon(): JSX.Element {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 12h-6l-2 3h-4l-2-3H2" strokeLinecap="round" strokeLinejoin="round" />
            <path
                d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function EmptyState({
    title = 'Nothing to show here',
    message,
    icon,
    action,
    testId = 'empty-state',
}: EmptyStateProps): JSX.Element {
    return (
        <StatePanel
            tone="neutral"
            icon={icon ?? <InboxIcon />}
            title={title}
            description={message}
            action={action}
            testId={testId}
        />
    );
}
