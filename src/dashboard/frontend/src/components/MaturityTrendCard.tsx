import {useMaturityTrend} from '../hooks/usePhase3';
import {useTimeRange} from '../hooks/useTimeRange';
import {Card} from './Card';
import {Badge} from './Badge';
import {TimeRangeSelector} from './TimeRangeSelector';
import {ErrorState} from './ErrorState';
import {SkeletonChart} from './Skeleton';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {maturityBasisDescription, maturityBasisLabel, maturityConfidence} from './maturity';
import type {MaturityBasis, MaturityTrendPoint} from '../api/types';

export interface MaturityTrendCardProps {
    /** API scope token: 'org' for the org roll-up, or a team name. */
    scope: string;
    /** Card heading, e.g. "AI maturity trend". */
    title: string;
    /** One-line sub-heading describing the scope. */
    subtitle: string;
}

/**
 * The AI maturity score over time (one point per quarter), with the honesty
 * labeling the product requires: a "git-based estimate" chip and a MEDIUM
 * confidence marker, both carrying the longer basis sentence on hover, so the
 * line never reads as measured usage when it was inferred from git. Shares the
 * time-range selector + coverage badge with the adoption-trend charts so the
 * control behaves identically across the dashboard.
 *
 * The displayed basis comes from the most recent point that has one (the trend
 * may begin before tool connectors existed), defaulting to git_estimate so the
 * estimate framing is the floor, never measurement.
 *
 * No day-count coverage badge here (unlike the adoption-trend charts): the axis
 * is quarters, so a "N of M days" badge would misrepresent the granularity. The
 * git-based-estimate + confidence markers carry the honesty signal instead.
 */
export function MaturityTrendCard({scope, title, subtitle}: MaturityTrendCardProps): JSX.Element {
    const {range, setRange} = useTimeRange();
    const {data, isPending, isError, error, refetch} = useMaturityTrend(scope, range);

    const points = data?.points ?? [];
    const basis = latestBasis(points);
    const confidence = maturityConfidence(basis);
    const basisHint = maturityBasisDescription(basis);

    const chartData: ChartDatum[] = points.map((p) => ({period: p.period, score: p.score}));

    return (
        <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-foreground">{title}</h2>
                    <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge tone="accent" title={basisHint}>
                            {maturityBasisLabel(basis)}
                        </Badge>
                        <Badge tone={confidence.tone} title={basisHint}>
                            {confidence.label}
                        </Badge>
                    </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                    <TimeRangeSelector value={range} onChange={setRange} />
                </div>
            </div>
            {isPending ? <SkeletonChart /> : null}
            {isError ? (
                <ErrorState
                    title="Failed to load maturity trend"
                    detail={error?.message}
                    onRetry={() => void refetch()}
                />
            ) : null}
            {!isPending && !isError ? (
                <TrendChart
                    data={chartData}
                    xKey="period"
                    series={[{key: 'score', label: 'AI maturity (git-based estimate)'}]}
                    variant="line"
                    valueFormatter={(v) => `${Math.round(Number(v))} / 100`}
                    emptyMessage="No maturity score for this range yet."
                    testId="maturity-trend-chart"
                />
            ) : null}
        </Card>
    );
}

/**
 * Most recent recorded basis, falling back to git_estimate when no point carries
 * one — the estimate framing is the floor, never measurement, so this always
 * resolves to a concrete basis (never null).
 */
function latestBasis(points: MaturityTrendPoint[]): MaturityBasis {
    for (let i = points.length - 1; i >= 0; i -= 1) {
        const basis = points[i].basis;
        if (basis) {
            return basis;
        }
    }
    return 'git_estimate';
}
