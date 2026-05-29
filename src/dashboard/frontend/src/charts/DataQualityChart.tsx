import {Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import type {OverviewData} from '../api/types';

interface ChartDatum {
    quality: string;
    // Count of data points (tool_snapshots rows) at this quality level — the
    // backend groups by data_quality over snapshots, not distinct developers.
    points: number;
    fill: string;
}

// Status colors map to the design tokens' intent (high = healthy, none = gap).
const QUALITY_META: {key: keyof OverviewData['data_quality_distribution']; label: string; fill: string}[] = [
    {key: 'high', label: 'High', fill: 'rgb(22 163 74)'},
    {key: 'medium', label: 'Medium', fill: 'rgb(217 119 6)'},
    {key: 'low', label: 'Low', fill: 'rgb(220 38 38)'},
    {key: 'none', label: 'None', fill: 'rgb(100 116 139)'},
];

/**
 * Sample chart that proves the full stack: it renders data fetched live from
 * /api/overview. Shows the per-data-point quality distribution as a bar chart.
 */
export function DataQualityChart({overview}: {overview: OverviewData}): JSX.Element {
    const data: ChartDatum[] = QUALITY_META.map((meta) => ({
        quality: meta.label,
        points: overview.data_quality_distribution[meta.key],
        fill: meta.fill,
    }));

    return (
        <div className="h-64 w-full" data-testid="data-quality-chart">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{top: 8, right: 8, bottom: 8, left: 8}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(148 163 184 / 0.25)" vertical={false} />
                    <XAxis dataKey="quality" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} width={32} />
                    <Tooltip cursor={{fill: 'rgb(148 163 184 / 0.12)'}} />
                    <Bar dataKey="points" name="data points" radius={[4, 4, 0, 0]}>
                        {data.map((datum) => (
                            <Cell key={datum.quality} fill={datum.fill} />
                        ))}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
