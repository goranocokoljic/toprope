import type {ReactNode} from 'react';
import {StatePanel} from './StatePanel';

/**
 * Error state for connector failures and API errors. Deliberately
 * non-alarming: warning (amber) tone rather than danger (red), calm copy, and a
 * concrete suggested action — a failed sync is almost always transient, and
 * panicking the user during evaluation is the opposite of what we want. The raw
 * detail is still shown, muted, so a real fault is diagnosable.
 */

export interface ErrorStateProps {
    title?: string;
    /** Technical detail (e.g. the error message); shown muted under the title. */
    detail?: ReactNode;
    /** Suggested next step. Defaults to a generic "usually temporary" note. */
    suggestion?: ReactNode;
    onRetry?: () => void;
    testId?: string;
}

function AlertIcon(): JSX.Element {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 9v4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
            <path
                d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function ErrorState({
    title = "We couldn't load this",
    detail,
    suggestion = 'This is usually temporary. Try again in a moment.',
    onRetry,
    testId = 'error-state',
}: ErrorStateProps): JSX.Element {
    return (
        <StatePanel
            role="alert"
            tone="warning"
            icon={<AlertIcon />}
            title={title}
            description={
                <>
                    {suggestion}
                    {detail ? <span className="mt-2 block text-xs text-muted/80">{detail}</span> : null}
                </>
            }
            action={onRetry ? {label: 'Try again', onClick: onRetry} : undefined}
            testId={testId}
        />
    );
}
