import {Badge, type BadgeTone} from './Badge';

export interface CoverageBadgeProps {
    /** Number of real data-days backing the current view/scope. */
    dataDays: number;
    /** Total days in the selected window; when given, shows "N of M days". */
    spanDays?: number;
    className?: string;
}

interface Tier {
    tone: BadgeTone;
    label: string;
}

/**
 * Map a data-day count to a confidence tier. 14 days is the platform's
 * significance threshold (see the waste model: 14 days of inactivity = unused),
 * so a fortnight of real data is treated as high confidence.
 */
function tierFor(dataDays: number): Tier {
    if (dataDays <= 0) return {tone: 'neutral', label: 'No data'};
    if (dataDays < 7) return {tone: 'danger', label: 'Low confidence'};
    if (dataDays < 14) return {tone: 'warning', label: 'Medium confidence'};
    return {tone: 'success', label: 'High confidence'};
}

/**
 * Shows how many real days of data back a view, with a confidence tier. This is
 * the honesty signal on every time-series surface: a polished chart over 2 days
 * of data should not read as authoritative, and this badge says so.
 */
export function CoverageBadge({dataDays, spanDays, className}: CoverageBadgeProps): JSX.Element {
    const days = Math.max(0, Math.floor(dataDays));
    const tier = tierFor(days);
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
