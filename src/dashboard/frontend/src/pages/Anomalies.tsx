import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useAnomalies, useAcknowledgeAnomaly, useResolveAnomaly} from '../hooks/useAnomalies';
import {Card} from '../components/Card';
import {Badge} from '../components/Badge';
import {SkeletonText} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {severityTone, severityLabel, formatAnomalyDate} from '../components/anomalies';
import type {AnomalyAlert, AnomalyStatus} from '../api/types';

// --- Actions ---------------------------------------------------------------

function AnomalyActions({anomaly}: {anomaly: AnomalyAlert}): JSX.Element {
    const acknowledge = useAcknowledgeAnomaly();
    const resolve = useResolveAnomaly();
    const pending = acknowledge.isPending || resolve.isPending;
    const failed = acknowledge.isError || resolve.isError;

    return (
        <div className="flex flex-wrap items-center gap-2">
            {anomaly.status === 'open' ? (
                <button
                    type="button"
                    onClick={() => acknowledge.mutate(anomaly.id)}
                    disabled={pending}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised disabled:opacity-60"
                >
                    {acknowledge.isPending ? 'Saving…' : 'Acknowledge'}
                </button>
            ) : null}
            <button
                type="button"
                onClick={() => resolve.mutate(anomaly.id)}
                disabled={pending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
                {resolve.isPending ? 'Saving…' : 'Resolve'}
            </button>
            {failed ? <span className="text-xs text-danger">Couldn&apos;t save — try again.</span> : null}
        </div>
    );
}

// --- Anomaly row -----------------------------------------------------------

function AnomalyCard({anomaly}: {anomaly: AnomalyAlert}): JSX.Element {
    return (
        <li className="rounded-card border border-border bg-surface p-4" data-testid="anomaly-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(anomaly.severity)}>{severityLabel(anomaly.severity)}</Badge>
                    <Link
                        to={`/manager/teams/${encodeURIComponent(anomaly.team)}`}
                        className="text-sm font-medium text-accent hover:underline"
                    >
                        {anomaly.team}
                    </Link>
                    <span className="text-xs text-muted">· {anomaly.metric_label}</span>
                </span>
                <span className="text-xs text-muted">{formatAnomalyDate(anomaly.detected_at)}</span>
            </div>
            <p className="mt-2 text-sm text-foreground">{anomaly.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                {/* Basis is labelled honestly — "git-based estimate" at launch. */}
                <Badge tone="neutral" title="What this anomaly is derived from">
                    {anomaly.basis_label}
                </Badge>
                <span className="text-xs text-muted">week of {anomaly.period}</span>
            </div>
            <div className="mt-3">
                <AnomalyActions anomaly={anomaly} />
            </div>
        </li>
    );
}

// --- Tabs ------------------------------------------------------------------

const TABS: {value: AnomalyStatus; label: string}[] = [
    {value: 'open', label: 'Open'},
    {value: 'acknowledged', label: 'Acknowledged'},
    {value: 'resolved', label: 'Resolved'},
];

function TabButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: string;
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={[
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                active ? 'bg-accent text-white' : 'text-muted hover:bg-surface-raised hover:text-foreground',
            ].join(' ')}
        >
            {children}
        </button>
    );
}

// --- Page ------------------------------------------------------------------

function emptyMessageFor(status: AnomalyStatus): {title: string; message: string} {
    switch (status) {
        case 'open':
            return {
                title: 'No open anomalies',
                message:
                    "No team metric has deviated anomalously from its baseline. We'll flag a notable drop or spike here when one is detected.",
            };
        case 'acknowledged':
            return {
                title: 'Nothing acknowledged',
                message: 'Anomalies you acknowledge but haven’t resolved yet will appear here.',
            };
        default:
            return {
                title: 'Nothing resolved yet',
                message: 'Once you resolve an anomaly, it moves here as an audit trail of what was reviewed.',
            };
    }
}

/**
 * Manager Anomalies panel (Task 4.8). Lists team anomalies by status (open /
 * acknowledged / resolved), each with severity-based treatment, an honest basis
 * label, and acknowledge/resolve actions. Team scope only — developer-scope
 * anomalies are individual data and never reach this manager surface.
 */
export function Anomalies(): JSX.Element {
    const [status, setStatus] = useState<AnomalyStatus>('open');
    const {data, isPending, isError, error, refetch} = useAnomalies(status);
    const anomalies = data ?? [];
    const empty = emptyMessageFor(status);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Anomalies</h1>
                <p className="mt-1 text-sm text-muted">
                    Notable and high deviations in a team&apos;s metrics versus its own baseline. Every flag is a prompt
                    to review, never a performance judgement — and at launch the basis is a git-based estimate.
                </p>
            </div>

            <div className="flex gap-2">
                {TABS.map((t) => (
                    <TabButton key={t.value} active={status === t.value} onClick={() => setStatus(t.value)}>
                        {t.label}
                    </TabButton>
                ))}
            </div>

            {isPending ? (
                <Card>
                    <SkeletonText lines={4} />
                </Card>
            ) : null}

            {isError ? (
                <ErrorState
                    title="Failed to load anomalies"
                    detail={error?.message}
                    onRetry={() => void refetch()}
                />
            ) : null}

            {!isPending && !isError && anomalies.length === 0 ? (
                <EmptyState title={empty.title} message={empty.message} testId="anomalies-empty" />
            ) : null}

            {!isPending && !isError && anomalies.length > 0 ? (
                <Card title={`${TABS.find((t) => t.value === status)?.label} anomalies`}>
                    <ul className="space-y-3">
                        {anomalies.map((a) => (
                            <AnomalyCard key={a.id} anomaly={a} />
                        ))}
                    </ul>
                </Card>
            ) : null}
        </div>
    );
}
