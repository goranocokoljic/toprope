export interface TrendIndicatorProps {
    /** The change versus the comparison period. Sign drives the arrow. */
    value: number;
    /**
     * Which direction is "good" — controls color, not the arrow. Defaults to
     * `up` (more is better). Use `down` for metrics like waste or cost where a
     * decrease is the win.
     */
    goodWhen?: 'up' | 'down';
    /** Formats the magnitude; receives the absolute value. Defaults to String. */
    format?: (value: number) => string;
    /** Appended after the formatted magnitude (e.g. '%'). */
    suffix?: string;
}

/**
 * A compact delta badge: an up/down arrow plus the magnitude, colored by whether
 * the movement is good or bad for this metric. A zero delta renders neutrally
 * with no arrow, so "no change" never reads as a win or a loss.
 */
export function TrendIndicator({value, goodWhen = 'up', format, suffix}: TrendIndicatorProps): JSX.Element {
    const fmt = format ?? ((v: number) => String(v));
    const magnitude = `${fmt(Math.abs(value))}${suffix ?? ''}`;

    if (value === 0) {
        return (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted" data-trend="flat">
                <span aria-hidden>→</span>
                {magnitude}
            </span>
        );
    }

    const isUp = value > 0;
    const isGood = (isUp && goodWhen === 'up') || (!isUp && goodWhen === 'down');
    const colorClass = isGood ? 'text-success' : 'text-danger';
    const arrow = isUp ? '▲' : '▼';
    const label = `${isUp ? 'Up' : 'Down'} ${magnitude}`;

    return (
        <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${colorClass}`}
            data-trend={isUp ? 'up' : 'down'}
            aria-label={label}
        >
            <span aria-hidden>{arrow}</span>
            {magnitude}
        </span>
    );
}
