import {
    Area,
    AreaChart,
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import {useChartTheme} from './chartTheme';
import {ChartEmpty, ChartFrame, ChartTooltip, type ChartTooltipProps} from './chartParts';

/** One plotted measure. `color` overrides the themed categorical palette. */
export interface ChartSeries {
    key: string;
    label?: string;
    color?: string;
    /**
     * Which Y axis this series plots against. Defaults to 'left'. Set 'right' to
     * overlay a series on its own scale (e.g. small git counts beside large AI
     * interaction counts) so neither measure is crushed by the other's range.
     */
    axis?: 'left' | 'right';
}

export type ChartDatum = Record<string, number | string | null>;

export interface TrendChartProps {
    data: ChartDatum[];
    /** Field on each datum used for the x-axis (e.g. a date). */
    xKey: string;
    series: ChartSeries[];
    /** Line for crisp trends, area to emphasise volume. Defaults to line. */
    variant?: 'line' | 'area';
    height?: number;
    valueFormatter?: (value: number | string) => string;
    xTickFormatter?: (value: string | number) => string;
    /** Show the series legend. Defaults to true when there is >1 series. */
    showLegend?: boolean;
    emptyMessage?: string;
    testId?: string;
}

/**
 * Line/area chart for time series (trends). Themed for light/dark, chartjunk
 * kept out: no vertical grid, no axis lines, faint horizontal guides only.
 */
export function TrendChart({
    data,
    xKey,
    series,
    variant = 'line',
    height = 256,
    valueFormatter,
    xTickFormatter,
    showLegend,
    emptyMessage,
    testId = 'trend-chart',
}: TrendChartProps): JSX.Element {
    const theme = useChartTheme();

    if (data.length === 0 || series.length === 0) {
        return <ChartEmpty height={height} message={emptyMessage} />;
    }

    const legendVisible = showLegend ?? series.length > 1;
    const colorFor = (s: ChartSeries, i: number): string => s.color ?? theme.series[i % theme.series.length];
    const tooltip = (props: ChartTooltipProps): JSX.Element | null => (
        <ChartTooltip {...props} valueFormatter={valueFormatter} hideName={series.length === 1} />
    );

    const axisTick = {fill: theme.muted, fontSize: 12};
    const ChartImpl = variant === 'area' ? AreaChart : LineChart;

    // Only switch to keyed (dual) axes when a series actually opts into the right
    // axis; otherwise keep the single default axis so existing single-scale
    // charts render byte-identically. Recharts requires each series' yAxisId to
    // match a rendered YAxis, so we resolve one consistently for both.
    const hasRightAxis = series.some((s) => s.axis === 'right');
    const axisIdFor = (s: ChartSeries): 'left' | 'right' | undefined =>
        hasRightAxis ? (s.axis === 'right' ? 'right' : 'left') : undefined;

    return (
        <ChartFrame height={height} testId={testId}>
            <ResponsiveContainer width="100%" height="100%">
                <ChartImpl data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
                    <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                        dataKey={xKey}
                        tick={axisTick}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={xTickFormatter}
                        minTickGap={24}
                    />
                    {hasRightAxis ? (
                        <>
                            <YAxis
                                yAxisId="left"
                                tick={axisTick}
                                tickLine={false}
                                axisLine={false}
                                width={40}
                                allowDecimals={false}
                            />
                            <YAxis
                                yAxisId="right"
                                orientation="right"
                                tick={axisTick}
                                tickLine={false}
                                axisLine={false}
                                width={40}
                                allowDecimals={false}
                            />
                        </>
                    ) : (
                        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                    )}
                    <Tooltip content={tooltip} cursor={{stroke: theme.grid}} />
                    {legendVisible ? <Legend wrapperStyle={{fontSize: 12, color: theme.muted}} /> : null}
                    {series.map((s, i) =>
                        variant === 'area' ? (
                            <Area
                                key={s.key}
                                yAxisId={axisIdFor(s)}
                                type="monotone"
                                dataKey={s.key}
                                name={s.label ?? s.key}
                                stroke={colorFor(s, i)}
                                fill={colorFor(s, i)}
                                fillOpacity={0.15}
                                strokeWidth={2}
                                dot={false}
                                activeDot={{r: 4}}
                            />
                        ) : (
                            <Line
                                key={s.key}
                                yAxisId={axisIdFor(s)}
                                type="monotone"
                                dataKey={s.key}
                                name={s.label ?? s.key}
                                stroke={colorFor(s, i)}
                                strokeWidth={2}
                                dot={false}
                                activeDot={{r: 4}}
                            />
                        ),
                    )}
                </ChartImpl>
            </ResponsiveContainer>
        </ChartFrame>
    );
}
