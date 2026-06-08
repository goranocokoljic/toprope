import type {BadgeTone} from './Badge';
import type {AnomalySeverity} from '../api/types';

/**
 * Severity-based visual treatment for anomalies (Task 4.8). Maps each severity to
 * a badge tone and a human label so the panel and the inline team flags read the
 * same: high is alarming (danger), notable is a warning, info is neutral.
 */
const SEVERITY_TONE: Record<AnomalySeverity, BadgeTone> = {
    high: 'danger',
    notable: 'warning',
    info: 'neutral',
};

const SEVERITY_LABEL: Record<AnomalySeverity, string> = {
    high: 'High',
    notable: 'Notable',
    info: 'Info',
};

export function severityTone(severity: AnomalySeverity): BadgeTone {
    return SEVERITY_TONE[severity];
}

export function severityLabel(severity: AnomalySeverity): string {
    return SEVERITY_LABEL[severity];
}

/** Format an anomaly's detected timestamp as a short date, or — when invalid. */
export function formatAnomalyDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short', day: 'numeric'}).format(date);
}
