import {Badge} from './Badge';
import {utilizationTier} from './utilization';
import {formatPercent} from './format';

/**
 * Shared utilization cell for the manager team tables (Teams list + Rank teams).
 * A coloured dot + percent + health tier badge, classified against the SAME
 * documented thresholds via `utilizationTier`. Extracted so the two tables can't
 * drift on how the same rate reads. `rate` is nullable: a period with no members
 * (or a team with no aggregate row) renders an em dash rather than a fake 0%.
 */

// Full literal class strings (Tailwind can't see dynamically-built names).
const UTILIZATION_DOT: Record<'success' | 'warning' | 'danger', string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
};

export function UtilizationCell({rate}: {rate: number | null}): JSX.Element {
    if (rate === null) {
        return <span className="text-muted">—</span>;
    }
    const tier = utilizationTier(rate);
    const dot = UTILIZATION_DOT[tier.tone as 'success' | 'warning' | 'danger'];
    return (
        <span className="inline-flex items-center gap-2">
            <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
            <span className="tabular-nums text-foreground">{formatPercent(rate)}</span>
            <Badge tone={tier.tone}>{tier.label}</Badge>
        </span>
    );
}
