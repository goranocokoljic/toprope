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
        return [x, y] as const;
    });
    const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    const areaPath = `M ${points[0][0].toFixed(2)},${(height - pad).toFixed(2)} L ${points
        .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
        .join(' L ')} L ${points[points.length - 1][0].toFixed(2)},${(height - pad).toFixed(2)} Z`;

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
