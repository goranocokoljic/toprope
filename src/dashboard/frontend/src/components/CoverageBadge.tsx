import {Badge} from './Badge';
import {confidenceTier} from './coverage';

export interface CoverageBadgeProps {
    /** Number of real data-days backing the current view/scope. */
    dataDays: number;
    /** Total days in the selected window; when given, shows "N of M days". */
    spanDays?: number;
    className?: string;
}

/**
 * Shows how many real days of data back a view, with a confidence tier. This is
 * the honesty signal on every time-series surface: a polished chart over 2 days
 * of data should not read as authoritative, and this badge says so.
 */
export function CoverageBadge({dataDays, spanDays, className}: CoverageBadgeProps): JSX.Element {
    const days = Math.max(0, Math.floor(dataDays));
    const tier = confidenceTier(days);
    const count =
        spanDays !== undefined && spanDays > 0
            ? `${days} of ${Math.floor(spanDays)} days`
            : `${days} ${days === 1 ? 'day' : 'days'} of data`;

    return (
        <Badge tone={tier.tone} title={tier.label} className={className}>
            {count}
        </Badge>
    );
}
