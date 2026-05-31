import type {ReactNode} from 'react';

// StatCard lives in its own module (it grew a trend indicator + sparkline in
// task 2.10); re-exported here so existing `import {Card, StatCard}` sites keep
// working.
export {StatCard, type StatCardProps} from './StatCard';

export function Card({title, children}: {title?: string; children: ReactNode}): JSX.Element {
    return (
        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
            {title ? <h2 className="mb-4 text-sm font-semibold text-foreground">{title}</h2> : null}
            {children}
        </section>
    );
}
