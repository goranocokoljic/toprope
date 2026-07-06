import type {ReactNode} from 'react';

/**
 * Small presentational primitives shared by the Admin Management screens
 * (Task 2.13). Centralized so every admin form/table reads consistently and
 * matches the dashboard aesthetic (token-driven colors, desktop layout).
 */

export function PageHeader({title, description}: {title: string; description: string}): JSX.Element {
    return (
        <div>
            <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
            <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
    );
}

export function TextField({
    label,
    value,
    onChange,
    placeholder,
    type = 'text',
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    type?: string;
}): JSX.Element {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">{label}</span>
            <input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
            />
        </label>
    );
}

export function SelectField({
    label,
    value,
    onChange,
    children,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    children: ReactNode;
}): JSX.Element {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">{label}</span>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
            >
                {children}
            </select>
        </label>
    );
}

export function PrimaryButton({
    children,
    onClick,
    disabled,
    type = 'button',
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit';
}): JSX.Element {
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
            {children}
        </button>
    );
}

export function SecondaryButton({
    children,
    onClick,
    disabled,
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50"
        >
            {children}
        </button>
    );
}

export function ErrorText({error}: {error: Error | null}): JSX.Element | null {
    if (!error) return null;
    return <span className="text-sm text-danger">{error.message}</span>;
}

/** A one-time temporary-password banner shown after create / reset. */
export function TempPasswordBanner({password, onDismiss}: {password: string; onDismiss: () => void}): JSX.Element {
    return (
        <div className="flex items-center justify-between gap-4 rounded-md border border-accent/40 bg-accent-soft px-4 py-3">
            <div className="text-sm text-foreground">
                Temporary password (shown once — copy it now):{' '}
                <code className="font-mono font-semibold">{password}</code>
            </div>
            <button type="button" onClick={onDismiss} className="text-xs font-medium text-accent">
                Dismiss
            </button>
        </div>
    );
}

export function Table({head, children}: {head: ReactNode; children: ReactNode}): JSX.Element {
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
                <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                        {head}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

export function Th({children}: {children: ReactNode}): JSX.Element {
    return <th className="px-3 py-2 font-medium">{children}</th>;
}

export function Td({children}: {children: ReactNode}): JSX.Element {
    return <td className="px-3 py-2 text-foreground">{children}</td>;
}
