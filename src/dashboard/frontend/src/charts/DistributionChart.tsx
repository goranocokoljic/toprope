import {Cell, Pie, PieChart, ResponsiveContainer, Tooltip} from 'recharts';
import {useChartTheme} from './chartTheme';
import {ChartEmpty, ChartFrame, ChartTooltip, type ChartTooltipProps} from './chartParts';

export interface DistributionSlice {
    label: string;
    value: number;
    /** Overrides the themed categorical palette for this slice. */
    color?: string;
}

export interface DistributionChartProps {
    data: DistributionSlice[];
    height?: number;
    valueFormatter?: (value: number | string) => string;
    /** Optional big number + caption rendered in the donut hole. */
    centerLabel?: {value: string; caption?: string};
    /** Show the slice legend beside the donut. Defaults to true. */
    showLegend?: boolean;
    emptyMessage?: string;
    testId?: string;
}

/**
 * Donut chart for distributions (tool mix, quality split). Renders as a ring so
 * a summary total can sit in the hole. A slice with value 0 is dropped so it
 * neither draws nor clutters the legend.
 */
export function DistributionChart({
    data,
    height = 256,
    valueFormatter,
    centerLabel,
    showLegend = true,
    emptyMessage,
    testId = 'distribution-chart',
}: DistributionChartProps): JSX.Element {
    const theme = useChartTheme();
    const slices = data.filter((d) => d.value > 0);

    if (slices.length === 0) {
        return <ChartEmpty height={height} message={emptyMessage} />;
    }

    const colorFor = (slice: DistributionSlice, i: number): string =>
        slice.color ?? theme.series[i % theme.series.length];
    const format = valueFormatter ?? ((v: number | string) => String(v));
    const tooltip = (props: ChartTooltipProps): JSX.Element | null => (
        <ChartTooltip {...props} valueFormatter={valueFormatter} />
    );

    return (
        <ChartFrame height={height} testId={testId}>
            <div className="flex h-full items-center gap-4">
                <div className="relative h-full flex-1">
                    <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                            <Pie
                                data={slices}
                                dataKey="value"
                                nameKey="label"
                                innerRadius="60%"
                                outerRadius="90%"
                                paddingAngle={2}
                                stroke={theme.surface}
                                strokeWidth={2}
                            >
                                {slices.map((slice, i) => (
                                    <Cell key={slice.label} fill={colorFor(slice, i)} />
                                ))}
                            </Pie>
                            <Tooltip content={tooltip} />
                        </PieChart>
                    </ResponsiveContainer>
                    {centerLabel ? (
                        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                            <span className="font-display text-2xl font-semibold text-foreground">
                                {centerLabel.value}
                            </span>
                            {centerLabel.caption ? (
                                <span className="text-xs text-muted">{centerLabel.caption}</span>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                {showLegend ? (
                    <ul className="flex max-w-[45%] flex-col gap-2 text-sm" data-testid="distribution-legend">
                        {slices.map((slice, i) => (
                            <li key={slice.label} className="flex items-center gap-2">
                                <span
                                    aria-hidden
                                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{backgroundColor: colorFor(slice, i)}}
                                />
                                <span className="truncate text-muted">{slice.label}</span>
                                <span className="ml-auto font-medium text-foreground">{format(slice.value)}</span>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </ChartFrame>
    );
}
