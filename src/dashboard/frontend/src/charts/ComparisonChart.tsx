import {Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {useChartTheme} from './chartTheme';
import {ChartEmpty, ChartFrame, ChartTooltip, type ChartTooltipProps} from './chartParts';
import type {ChartDatum, ChartSeries} from './TrendChart';

export interface ComparisonChartProps {
    data: ChartDatum[];
    /** Field used for the category axis (e.g. team name, tool). */
    categoryKey: string;
    series: ChartSeries[];
    /** Vertical bars (default) or horizontal for long category labels. */
    layout?: 'vertical' | 'horizontal';
    height?: number;
    valueFormatter?: (value: number | string) => string;
    showLegend?: boolean;
    /**
     * Per-category colors for a single-series chart (e.g. data-quality tiers).
     * Ignored for multi-series. Length should match `data`.
     */
    categoryColors?: string[];
    emptyMessage?: string;
    testId?: string;
}

/**
 * Bar chart for comparisons across categories. `layout="horizontal"` swaps the
 * axes so long labels (team names) stay readable. Single-series charts may pass
 * `categoryColors` to color each bar independently (e.g. quality tiers).
 */
export function ComparisonChart({
    data,
    categoryKey,
    series,
    layout = 'vertical',
    height = 256,
    valueFormatter,
    showLegend,
    categoryColors,
    emptyMessage,
    testId = 'comparison-chart',
}: ComparisonChartProps): JSX.Element {
    const theme = useChartTheme();

    if (data.length === 0 || series.length === 0) {
        return <ChartEmpty height={height} message={emptyMessage} />;
    }

    const horizontal = layout === 'horizontal';
    const legendVisible = showLegend ?? series.length > 1;
    const colorFor = (s: ChartSeries, i: number): string => s.color ?? theme.series[i % theme.series.length];
    const axisTick = {fill: theme.muted, fontSize: 12};
    const tooltip = (props: ChartTooltipProps): JSX.Element | null => (
        <ChartTooltip {...props} valueFormatter={valueFormatter} hideName={series.length === 1} />
    );

    const categoryAxis = (
        <XAxis
            type={horizontal ? 'number' : 'category'}
            dataKey={horizontal ? undefined : categoryKey}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            allowDecimals={!horizontal ? undefined : false}
        />
    );
    const valueAxis = (
        <YAxis
            type={horizontal ? 'category' : 'number'}
            dataKey={horizontal ? categoryKey : undefined}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={horizontal ? 96 : 40}
            allowDecimals={false}
        />
    );

    return (
        <ChartFrame height={height} testId={testId}>
            <ResponsiveContainer width="100%" height="100%">
                <BarChart
                    data={data}
                    layout={horizontal ? 'vertical' : 'horizontal'}
                    margin={{top: 8, right: 8, bottom: 0, left: 0}}
                >
                    <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" horizontal={!horizontal} vertical={horizontal} />
                    {categoryAxis}
                    {valueAxis}
                    <Tooltip content={tooltip} cursor={{fill: theme.grid}} />
                    {legendVisible ? <Legend wrapperStyle={{fontSize: 12, color: theme.muted}} /> : null}
                    {series.map((s, i) => (
                        <Bar
                            key={s.key}
                            dataKey={s.key}
                            name={s.label ?? s.key}
                            fill={colorFor(s, i)}
                            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                        >
                            {categoryColors && series.length === 1
                                ? data.map((_datum, di) => (
                                      <Cell key={`cell-${di}`} fill={categoryColors[di] ?? colorFor(s, i)} />
                                  ))
                                : null}
                        </Bar>
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </ChartFrame>
    );
}
