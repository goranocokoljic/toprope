import {useState} from 'react';
import {Card} from './Card';
import {SkeletonText} from './Skeleton';
import {ErrorState} from './ErrorState';
import {EmptyState} from './EmptyState';
import {SummaryCard} from './SummaryCard';
import {useGenerateSummary, useSummaries} from '../hooks/usePhase3';
import {SUMMARY_LEVEL_LABEL} from './summaries';
import type {SummaryLevel, SummaryListItem} from '../api/types';

export interface SummariesPanelProps {
    /** Summaries API scope token: 'org' or 'team:<name>'. */
    scope: string;
    /**
     * Compact mode (team detail): surface only the single latest summary. Full
     * mode (org overview): prominent latest weekly + monthly, the full history,
     * and on-demand quarterly/yearly generation.
     */
    compact?: boolean;
}

/** The newest summary of a given level, or undefined when none exists. */
function latestOfLevel(items: SummaryListItem[], level: SummaryLevel): SummaryListItem | undefined {
    // The list arrives most-recent first, so the first match is the latest.
    return items.find((s) => s.period_type === level);
}

/** On-demand generation for the manager-driven cadences (quarterly/yearly). */
function GenerateForm({scope}: {scope: string}): JSX.Element {
    const [level, setLevel] = useState<SummaryLevel>('quarterly');
    const [period, setPeriod] = useState('');
    const generate = useGenerateSummary();

    const placeholder = level === 'quarterly' ? 'e.g. 2026-Q2' : 'e.g. 2026';

    function onGenerate(): void {
        const trimmed = period.trim();
        if (!trimmed) return;
        generate.mutate({level, period: trimmed, scope});
    }

    return (
        <div className="rounded-md border border-dashed border-border p-4">
            <h3 className="text-sm font-semibold text-foreground">Generate a report on demand</h3>
            <p className="mt-0.5 text-xs text-muted">
                Quarterly and yearly summaries are generated when you need them.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted">
                    <span>Cadence</span>
                    <select
                        aria-label="Cadence"
                        value={level}
                        onChange={(e) => setLevel(e.target.value as SummaryLevel)}
                        className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                    >
                        <option value="quarterly">{SUMMARY_LEVEL_LABEL.quarterly}</option>
                        <option value="yearly">{SUMMARY_LEVEL_LABEL.yearly}</option>
                    </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted">
                    <span>Period</span>
                    <input
                        type="text"
                        aria-label="Period"
                        value={period}
                        onChange={(e) => setPeriod(e.target.value)}
                        placeholder={placeholder}
                        className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                    />
                </label>
                <button
                    type="button"
                    onClick={onGenerate}
                    disabled={generate.isPending || period.trim() === ''}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                >
                    {generate.isPending ? 'Generating…' : 'Generate'}
                </button>
            </div>
            {generate.isError ? (
                <p className="mt-2 text-xs text-danger" role="alert">
                    Generation failed: {generate.error?.message}
                </p>
            ) : null}
            {generate.isSuccess ? (
                <p className="mt-2 text-xs text-success">
                    Generated {SUMMARY_LEVEL_LABEL[generate.data.period_type]} · {generate.data.period_value}.
                </p>
            ) : null}
        </div>
    );
}

/**
 * The AI summaries view (Task 3.12). In full mode it surfaces the auto-generated
 * latest weekly + monthly summaries prominently, lists the full history with
 * staleness badges, and offers on-demand quarterly/yearly generation. In compact
 * mode (team detail) it shows only that team's latest summary.
 *
 * Summaries that already exist for the scope appear without any manual action —
 * the weekly/monthly auto-generation runs on the scheduler, so this view simply
 * reads what is already there.
 */
export function SummariesPanel({scope, compact = false}: SummariesPanelProps): JSX.Element {
    const {data, isPending, isError, error, refetch} = useSummaries(scope);
    const summaries = data ?? [];

    if (compact) {
        const latest = summaries[0];
        return (
            <Card title="Latest AI summary">
                {isPending ? <SkeletonText lines={3} /> : null}
                {isError ? (
                    <ErrorState title="Failed to load summary" detail={error?.message} onRetry={() => void refetch()} />
                ) : null}
                {!isPending && !isError && !latest ? (
                    <p className="text-sm text-muted">No summary generated for this team yet.</p>
                ) : null}
                {!isPending && !isError && latest ? <SummaryCard item={latest} /> : null}
            </Card>
        );
    }

    const latestWeekly = latestOfLevel(summaries, 'weekly');
    const latestMonthly = latestOfLevel(summaries, 'monthly');

    return (
        <Card title="AI-generated summaries">
            {isPending ? <SkeletonText lines={4} /> : null}
            {isError ? (
                <ErrorState title="Failed to load summaries" detail={error?.message} onRetry={() => void refetch()} />
            ) : null}

            {!isPending && !isError ? (
                <div className="space-y-6">
                    <div>
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                            Latest (auto-generated)
                        </h3>
                        {latestWeekly || latestMonthly ? (
                            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                                {latestWeekly ? <SummaryCard item={latestWeekly} defaultExpanded /> : null}
                                {latestMonthly ? <SummaryCard item={latestMonthly} defaultExpanded /> : null}
                            </div>
                        ) : (
                            <p className="text-sm text-muted">
                                No weekly or monthly summary yet — they generate automatically on schedule.
                            </p>
                        )}
                    </div>

                    {summaries.length > 0 ? (
                        <div>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                                History
                            </h3>
                            <div className="space-y-2">
                                {summaries.map((item) => (
                                    <SummaryCard key={item.id} item={item} />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <EmptyState
                            title="No summaries yet"
                            message="Weekly and monthly summaries appear here automatically; generate a quarterly or yearly report below."
                        />
                    )}

                    <GenerateForm scope={scope} />
                </div>
            ) : null}
        </Card>
    );
}
