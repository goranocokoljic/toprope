import type {ReactNode} from 'react';

export function Card({title, children}: {title?: string; children: ReactNode}): JSX.Element {
    return (
        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
            {title ? <h2 className="mb-4 text-sm font-semibold text-foreground">{title}</h2> : null}
            {children}
        </section>
    );
}

export function StatCard({label, value, hint}: {label: string; value: string; hint?: string}): JSX.Element {
    return (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
            <p className="mt-2 font-display text-3xl font-semibold text-foreground">{value}</p>
            {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
        </div>
    );
}
