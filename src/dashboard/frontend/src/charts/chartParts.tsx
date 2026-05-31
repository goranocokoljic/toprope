import type {ReactNode} from 'react';

/**
 * Shared building blocks for the chart wrappers: a token-themed tooltip (the
 * Recharts default is hard-white and unreadable in dark mode) and a consistent
 * empty state so every chart degrades the same way when a scope has no data.
 */

export interface TooltipEntry {
    name?: string | number;
    value?: number | string;
    color?: string;
}

export interface ChartTooltipProps {
    active?: boolean;
    label?: string | number;
    payload?: TooltipEntry[];
    /** Formats each series value (e.g. currency, percent). Defaults to String. */
    valueFormatter?: (value: number | string) => string;
    /** Hide the per-series name (useful for single-series charts). */
    hideName?: boolean;
}

export function ChartTooltip({active, label, payload, valueFormatter, hideName}: ChartTooltipProps): JSX.Element | null {
    if (!active || !payload || payload.length === 0) {
        return null;
    }
    const format = valueFormatter ?? ((v: number | string) => String(v));
    return (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-card">
            {label !== undefined && label !== '' ? (
                <p className="mb-1 font-medium text-foreground">{label}</p>
            ) : null}
            <ul className="space-y-0.5">
                {payload.map((entry, i) => (
                    <li key={`${entry.name ?? i}`} className="flex items-center gap-2 text-muted">
                        <span
                            aria-hidden
                            className="inline-block h-2 w-2 rounded-full"
                            style={{backgroundColor: entry.color ?? 'currentColor'}}
                        />
                        {!hideName && entry.name !== undefined ? <span>{entry.name}</span> : null}
                        <span className="ml-auto font-medium text-foreground">
                            {entry.value === undefined ? '—' : format(entry.value)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function ChartEmpty({height, message}: {height: number; message?: string}): JSX.Element {
    return (
        <div
            className="flex w-full items-center justify-center rounded-card border border-dashed border-border text-sm text-muted"
            style={{height}}
            data-testid="chart-empty"
        >
            {message ?? 'No data for this range'}
        </div>
    );
}

/** Wrapper that fixes a chart's height and exposes a test id. */
export function ChartFrame({
    height,
    testId,
    children,
}: {
    height: number;
    testId?: string;
    children: ReactNode;
}): JSX.Element {
    return (
        <div className="w-full" style={{height}} data-testid={testId}>
            {children}
        </div>
    );
}
