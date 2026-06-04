import {useId, useState} from 'react';
import {Badge} from './Badge';
import {SkeletonText} from './Skeleton';
import {ErrorState} from './ErrorState';
import {useRegenerateSummary, useSummary} from '../hooks/usePhase3';
import {formatGeneratedAt, summaryHeading} from './summaries';
import {maturityBasisDescription, maturityBasisLabel} from './maturity';
import type {SummaryListItem} from '../api/types';

export interface SummaryCardProps {
    item: SummaryListItem;
    /** Render expanded on mount (used for the prominent latest summaries). */
    defaultExpanded?: boolean;
}

/**
 * One AI-generated summary: heading + cadence, the data-basis + staleness
 * markers, and an expandable full-text view with a regenerate affordance
 * (optional focus instruction). The narrative text is fetched only when the
 * card is expanded, so a long history list stays a single cheap list request
 * until the manager opens a specific summary.
 *
 * A stale summary (its underlying aggregate changed after generation) is flagged
 * with a clear, actionable badge — the regenerate control beneath it is the
 * affordance that clears the flag.
 */
export function SummaryCard({item, defaultExpanded = false}: SummaryCardProps): JSX.Element {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [focus, setFocus] = useState('');
    const regenerate = useRegenerateSummary();
    // The latest weekly/monthly are surfaced prominently AND repeated in the
    // history list, so the same summary can mount twice. useId gives each card a
    // collision-free id for the focus input/label rather than deriving it from
    // item.id (which would duplicate across the two renders).
    const inputId = useId();

    // Fetch the full narrative only once expanded. Reuse the regenerate result
    // when present so the freshly generated text shows without a second fetch.
    const detail = useSummary(expanded ? item.id : null);
    const text = regenerate.data?.summary_text ?? detail.data?.summary_text;

    const basisHint = maturityBasisDescription(item.basis);

    function onRegenerate(): void {
        const trimmed = focus.trim();
        regenerate.mutate({id: item.id, ...(trimmed ? {focus: trimmed} : {})});
    }

    return (
        <div className="rounded-md border border-border bg-surface p-4" data-testid="summary-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h3 className="text-sm font-semibold text-foreground">
                        {summaryHeading(item.period_type, item.period_value)}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted">
                        Generated {formatGeneratedAt(item.generated_at)} · {item.model_used}
                        {item.regenerated_count > 0
                            ? ` · regenerated ${item.regenerated_count}×`
                            : ''}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {item.is_stale ? (
                        <Badge
                            tone="warning"
                            title="The underlying data changed after this summary was written."
                        >
                            Underlying data changed — regenerate
                        </Badge>
                    ) : null}
                    {item.basis ? (
                        <Badge tone="accent" title={basisHint}>
                            {maturityBasisLabel(item.basis)}
                        </Badge>
                    ) : null}
                </div>
            </div>

            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-3 text-sm font-medium text-accent hover:underline"
            >
                {expanded ? 'Hide summary' : 'View full summary'}
            </button>

            {expanded ? (
                <div className="mt-3">
                    {detail.isPending && !text ? <SkeletonText lines={4} /> : null}
                    {detail.isError && !text ? (
                        <ErrorState
                            title="Failed to load summary"
                            detail={detail.error?.message}
                            onRetry={() => void detail.refetch()}
                        />
                    ) : null}
                    {text ? (
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground" data-testid="summary-text">
                            {text}
                        </p>
                    ) : null}

                    <div className="mt-4 border-t border-border pt-3">
                        <label className="block text-xs font-medium text-muted" htmlFor={inputId}>
                            Regenerate with an optional focus
                        </label>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                            <input
                                id={inputId}
                                type="text"
                                value={focus}
                                onChange={(e) => setFocus(e.target.value)}
                                placeholder="e.g. focus on cost efficiency"
                                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                            />
                            <button
                                type="button"
                                onClick={onRegenerate}
                                disabled={regenerate.isPending}
                                className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                            >
                                {regenerate.isPending ? 'Regenerating…' : 'Regenerate'}
                            </button>
                        </div>
                        {regenerate.isError ? (
                            <p className="mt-2 text-xs text-danger" role="alert">
                                Regeneration failed: {regenerate.error?.message}
                            </p>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
