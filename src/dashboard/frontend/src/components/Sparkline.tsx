export interface SparklineProps {
    /** Sequence of values, oldest → newest. Needs ≥2 points to draw. */
    data: number[];
    width?: number;
    height?: number;
    /** Stroke color; defaults to the accent token. */
    color?: string;
    /** Fill the area under the line at low opacity. */
    area?: boolean;
    className?: string;
}

/**
 * Tiny inline-SVG trend line for stat cards. Deliberately not Recharts: a
 * sparkline has no axes/tooltip/legend, and a hand-rolled SVG avoids the
 * ResponsiveContainer/ResizeObserver overhead at this size. Color defaults to
 * the accent token so it follows the theme.
 */
export function Sparkline({
    data,
    width = 96,
    height = 28,
    color = 'rgb(var(--color-accent))',
    area = false,
    className,
}: SparklineProps): JSX.Element | null {
    if (data.length < 2) {
        return null;
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    // Inset by 1px so the stroke isn't clipped at the edges.
    const pad = 1;
    const stepX = (width - pad * 2) / (data.length - 1);
    const points = data.map((value, i) => {
        const x = pad + i * stepX;
        const y = pad + (1 - (value - min) / span) * (height - pad * 2);
        return {x: x.toFixed(2), y: y.toFixed(2)};
    });
    const line = points.map((p) => `${p.x},${p.y}`).join(' ');
    // Close the line down to the baseline at both ends so the area fills under it.
    const baseline = (height - pad).toFixed(2);
    const first = points[0];
    const last = points[points.length - 1];
    const areaPath = `M ${first.x},${baseline} L ${points.map((p) => `${p.x},${p.y}`).join(' L ')} L ${last.x},${baseline} Z`;

    return (
        <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            fill="none"
            className={className}
            role="img"
            aria-hidden
            data-testid="sparkline"
        >
            {area ? <path d={areaPath} fill={color} fillOpacity={0.12} /> : null}
            <polyline
                points={line}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
