import type {ReactNode} from 'react';

/**
 * The shared shell behind every data-state treatment (cold-start, empty,
 * error). Centralizing the frame here is what makes the states read as one
 * consistent family while staying semantically distinct via tone + icon + copy.
 *
 * All colors come from semantic tokens (never raw hex) so each panel flips
 * correctly between light and dark with the rest of the UI.
 */

export type StatePanelTone = 'neutral' | 'accent' | 'warning';

interface ToneStyle {
    /** Icon chip background + foreground. */
    chip: string;
}

const TONE: Record<StatePanelTone, ToneStyle> = {
    neutral: {chip: 'bg-surface-raised text-muted'},
    accent: {chip: 'bg-accent-soft text-accent'},
    warning: {chip: 'bg-warning/10 text-warning'},
};

export interface StatePanelAction {
    label: string;
    onClick: () => void;
}

export interface StatePanelProps {
    tone?: StatePanelTone;
    /** Small glyph shown in the tinted chip above the title. */
    icon?: ReactNode;
    title: string;
    description?: ReactNode;
    /** Extra content (checklist, coverage list) rendered left-aligned below. */
    children?: ReactNode;
    /** Primary action rendered as a button. */
    action?: StatePanelAction;
    testId?: string;
    /** ARIA role; defaults to 'status'. Error panels pass 'alert'. */
    role?: string;
}

/** Neutral, theme-safe button used for the panel's call to action. */
function PanelButton({label, onClick}: StatePanelAction): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
        >
            {label}
        </button>
    );
}

export function StatePanel({
    tone = 'neutral',
    icon,
    title,
    description,
    children,
    action,
    testId,
    role = 'status',
}: StatePanelProps): JSX.Element {
    return (
        <section
            role={role}
            data-testid={testId}
            className="flex flex-col items-center rounded-card border border-dashed border-border bg-surface px-6 py-10 text-center shadow-card"
        >
            {icon ? (
                <span
                    aria-hidden
                    className={`mb-4 flex h-11 w-11 items-center justify-center rounded-full ${TONE[tone].chip}`}
                >
                    {icon}
                </span>
            ) : null}
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
            {children ? <div className="mt-5 w-full max-w-md text-left">{children}</div> : null}
            {action ? (
                <div className="mt-6">
                    <PanelButton {...action} />
                </div>
            ) : null}
        </section>
    );
}
