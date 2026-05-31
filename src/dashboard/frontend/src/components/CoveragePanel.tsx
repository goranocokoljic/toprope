import type {CoverageData, DataQuality} from '../api/types';
import {Badge, type BadgeTone} from './Badge';
import {providerLabel, toolLabel} from './toolLabels';

/**
 * The honest data-coverage indicator for the org overview (Task 2.5). It answers
 * "how much should I trust these numbers?" across three axes:
 *
 *  - Per-developer data quality — each registered developer bucketed by their
 *    best available signal (HIGH = API, MEDIUM = git, LOW = expense-only, NONE).
 *  - Tool connector status — which connectors have ever synced, and when.
 *  - Git provider coverage — developers with git activity per provider. The
 *    Phase-1 schema tracks no repositories, so this is a developer count, not a
 *    repo count; the label says so rather than implying data we don't have.
 *
 * Reusable: the manager team-detail screen (Task 2.6) can render the same panel
 * for a team scope.
 */

interface QualityTier {
    key: DataQuality;
    label: string;
    /** Solid fill for the segmented bar. */
    barClass: string;
    tone: BadgeTone;
}

const QUALITY_TIERS: QualityTier[] = [
    {key: 'high', label: 'High', barClass: 'bg-success', tone: 'success'},
    {key: 'medium', label: 'Medium', barClass: 'bg-warning', tone: 'warning'},
    {key: 'low', label: 'Low', barClass: 'bg-danger', tone: 'danger'},
    {key: 'none', label: 'None', barClass: 'bg-muted', tone: 'neutral'},
];

/** Compact, locale-aware timestamp for a last-sync display; null → "Never". */
function formatSync(value: string | null): string {
    if (!value) {
        return 'Never';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Never';
    }
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function percent(count: number, total: number): number {
    return total > 0 ? Math.round((count / total) * 100) : 0;
}

function QualityBreakdown({quality}: {quality: CoverageData['data_quality']}): JSX.Element {
    // `?? 0` so a partial payload renders honest zeros, not a broken bar.
    const counts = QUALITY_TIERS.map((tier) => ({tier, count: quality?.[tier.key] ?? 0}));
    const total = counts.reduce((sum, c) => sum + c.count, 0);

    return (
        <div data-testid="coverage-quality">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
                Developer data quality
            </p>
            {total > 0 ? (
                <div
                    className="flex h-2 w-full overflow-hidden rounded-full bg-surface-raised"
                    role="img"
                    aria-label="Per-developer data quality distribution"
                >
                    {counts.map(({tier, count}) =>
                        count > 0 ? (
                            <span
                                key={tier.key}
                                className={tier.barClass}
                                style={{width: `${percent(count, total)}%`}}
                                title={`${tier.label}: ${count}`}
                            />
                        ) : null,
                    )}
                </div>
            ) : (
                <p className="text-sm text-muted">No developers registered yet.</p>
            )}
            <ul className="mt-3 space-y-1.5 text-sm">
                {counts.map(({tier, count}) => (
                    <li key={tier.key} className="flex items-center gap-2">
                        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${tier.barClass}`} />
                        <span className="text-muted">{tier.label}</span>
                        <span className="ml-auto font-medium text-foreground">{count}</span>
                        <span className="w-10 text-right text-xs text-muted">{percent(count, total)}%</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Sync-status → badge tone. Unknown/absent status reads neutral. */
function statusTone(connected: boolean, status: string | null): BadgeTone {
    if (!connected) {
        return 'neutral';
    }
    if (status === 'error' || status === 'failed') {
        return 'danger';
    }
    if (status === 'running') {
        return 'accent';
    }
    return 'success';
}

function ConnectorStatus({connectors}: {connectors: CoverageData['connectors']}): JSX.Element {
    return (
        <div data-testid="coverage-connectors">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Tool connectors</p>
            <ul className="space-y-2 text-sm">
                {connectors.map((c) => (
                    <li key={c.connector} className="flex items-center gap-2">
                        <span className="text-foreground">{toolLabel(c.connector)}</span>
                        <Badge tone={statusTone(c.connected, c.status)} className="ml-auto">
                            {c.connected ? c.status ?? 'connected' : 'not connected'}
                        </Badge>
                        <span className="w-28 text-right text-xs text-muted">{formatSync(c.last_sync)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function GitProviders({providers}: {providers: CoverageData['git_providers']}): JSX.Element {
    return (
        <div data-testid="coverage-git">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Git providers</p>
            <ul className="space-y-2 text-sm">
                {providers.map((p) => (
                    <li key={p.provider} className="flex items-center gap-2">
                        <span className="text-foreground">{providerLabel(p.provider)}</span>
                        <span className="ml-auto text-muted">
                            {p.connected
                                ? `${p.developer_count} ${p.developer_count === 1 ? 'developer' : 'developers'}`
                                : 'No activity'}
                        </span>
                        <span className="w-28 text-right text-xs text-muted">{formatSync(p.last_sync)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function CoveragePanel({coverage}: {coverage: CoverageData}): JSX.Element {
    return (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3" data-testid="coverage-panel">
            <QualityBreakdown quality={coverage.data_quality} />
            <ConnectorStatus connectors={coverage.connectors ?? []} />
            <GitProviders providers={coverage.git_providers ?? []} />
        </div>
    );
}
