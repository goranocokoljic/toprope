/**
 * Loading placeholders. `Skeleton` is the primitive shimmer block; the rest
 * compose it into the shapes screens wait on (stat cards, charts, tables) so
 * loading states stay visually consistent with the real content they replace.
 *
 * Uses `bg-border` (not `bg-surface-raised`, which equals the surface color in
 * light mode) so the shimmer is visible on the card surface in both themes.
 */
export function Skeleton({className}: {className?: string}): JSX.Element {
    return <div className={`animate-pulse rounded bg-border ${className ?? ''}`} aria-hidden data-testid="skeleton" />;
}

/** A block of placeholder text lines; the last line is shortened. */
export function SkeletonText({lines = 3, className}: {lines?: number; className?: string}): JSX.Element {
    return (
        <div className={`space-y-2 ${className ?? ''}`} role="status" aria-label="Loading">
            {Array.from({length: lines}, (_, i) => (
                <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
            ))}
        </div>
    );
}

/** Placeholder matching the StatCard footprint. */
export function SkeletonStatCard(): JSX.Element {
    return (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card" role="status" aria-label="Loading">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-8 w-32" />
            <Skeleton className="mt-2 h-3 w-20" />
        </div>
    );
}

/** Placeholder occupying a chart's area. */
export function SkeletonChart({height = 256}: {height?: number}): JSX.Element {
    return (
        <div role="status" aria-label="Loading chart" style={{height}}>
            <Skeleton className="h-full w-full" />
        </div>
    );
}

/** Placeholder rows for a DataTable that's still loading. */
export function SkeletonTable({rows = 5, columns = 4}: {rows?: number; columns?: number}): JSX.Element {
    return (
        <div className="space-y-2" role="status" aria-label="Loading table">
            <div className="flex gap-4">
                {Array.from({length: columns}, (_, c) => (
                    <Skeleton key={c} className="h-3 flex-1" />
                ))}
            </div>
            {Array.from({length: rows}, (_, r) => (
                <div key={r} className="flex gap-4">
                    {Array.from({length: columns}, (_, c) => (
                        <Skeleton key={c} className="h-4 flex-1" />
                    ))}
                </div>
            ))}
        </div>
    );
}
