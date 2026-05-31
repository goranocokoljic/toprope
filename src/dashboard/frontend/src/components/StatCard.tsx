import {Sparkline} from './Sparkline';
import {TrendIndicator, type TrendIndicatorProps} from './TrendIndicator';

export interface StatCardProps {
    label: string;
    /** The headline metric, pre-formatted by the caller (currency, counts, …). */
    value: string;
    /** Small caption under the value (e.g. "active in last 30 days"). */
    hint?: string;
    /** Optional change-vs-previous indicator shown beside the value. */
    trend?: TrendIndicatorProps;
    /** Optional mini trend line (oldest → newest). */
    sparkline?: number[];
    /** Sparkline color; defaults to the accent token. */
    sparklineColor?: string;
}

/**
 * The dashboard's primary metric tile: a label, a big value, and optional trend
 * indicator + sparkline. Shares the Card surface tokens so it sits flush with
 * the rest of the UI in both themes.
 */
export function StatCard({label, value, hint, trend, sparkline, sparklineColor}: StatCardProps): JSX.Element {
    return (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
            <div className="mt-2 flex items-end justify-between gap-3">
                <div>
                    <div className="flex items-baseline gap-2">
                        <p className="font-display text-3xl font-semibold text-foreground">{value}</p>
                        {trend ? <TrendIndicator {...trend} /> : null}
                    </div>
                    {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
                </div>
                {sparkline && sparkline.length >= 2 ? (
                    <Sparkline data={sparkline} color={sparklineColor} area className="shrink-0" />
                ) : null}
            </div>
        </div>
    );
}
