import {useState} from 'react';
import {useMyPRReviewCoaching} from '../hooks/useMe';
import {Card} from '../components/Card';
import {Badge} from '../components/Badge';
import {PeriodUnitToggle} from '../components/PeriodUnitToggle';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {SkeletonChart} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {StatePanel} from '../components/StatePanel';
import {formatPercent} from '../components/format';
import {
    combinedSignalCopy,
    formatPeriodTick,
    reworkTrendSentence,
    variantTitle,
} from '../components/coaching';
import type {
    DeveloperPRReviewCoaching,
    PRReviewPeriodUnit,
    PRReviewVariantTrajectory,
} from '../api/types';

/**
 * Developer "My PR Coaching" (Task 5.3). The developer's OWN pull-request review
 * outcomes as a trajectory over time — fully private (session-scoped server-side)
 * and framed for self-reflection, never as a report card or a comparison to
 * peers. Two clearly-separated sections: factual "All your PRs" and the inferred,
 * lower-confidence "Your AI-assisted PRs". Every signal is presented as a trend,
 * not a bare snapshot verdict.
 */

/** Rework-rate trajectory, plotted per period (a ratio, rendered as a percent). */
function trajectoryData(variant: PRReviewVariantTrajectory): ChartDatum[] {
    return variant.points.map((p) => ({
        period: p.period,
        rework: p.rework_rate,
    }));
}

function VariantSection({variant}: {variant: PRReviewVariantTrajectory}): JSX.Element {
    const inferred = variant.basis === 'inferred';
    const title = variantTitle(variant.scope_variant);
    const signal = combinedSignalCopy(variant.latest_signal, 'you');
    const subjectPhrase = inferred ? 'your AI-assisted PRs' : 'your PRs';
    const sentence = reworkTrendSentence(variant.rework_trend, subjectPhrase);
    const hasData = variant.sufficient_periods > 0;

    return (
        <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">{title}</h2>
                    {inferred ? (
                        <Badge
                            tone="warning"
                            title="Inferred from each PR's estimated AI signature — an estimate on top of an estimate, so treat it as lower confidence."
                        >
                            Inferred · lower confidence
                        </Badge>
                    ) : (
                        <Badge tone="neutral" title="Measured directly from your pull requests.">
                            Factual
                        </Badge>
                    )}
                </div>
                {hasData ? <Badge tone={signal.tone}>{signal.label}</Badge> : null}
            </div>

            {inferred ? (
                <p className="mb-3 text-xs text-muted" data-testid="inferred-note">
                    These are the subset of your PRs we estimate were AI-assisted, based on each
                    PR's AI signature. That's an inference, so read this section as a softer hint
                    than the factual one above.
                </p>
            ) : null}

            {/* Trajectory framing — a trend over time, never a bare verdict. */}
            <p className="text-sm text-foreground" data-testid="trajectory-sentence">
                {sentence ??
                    "There isn't enough history yet to show a trend here — keep going and your trajectory will appear as more PRs land."}
            </p>
            <p className="mt-1 text-sm text-muted">{signal.guidance}</p>

            <div className="mt-4">
                <TrendChart
                    data={trajectoryData(variant)}
                    xKey="period"
                    series={[{key: 'rework', label: 'Rework rate'}]}
                    variant="line"
                    height={220}
                    xTickFormatter={formatPeriodTick}
                    valueFormatter={(v) => (typeof v === 'number' ? formatPercent(v) : String(v))}
                    emptyMessage="No PR review data in this range yet."
                    testId={`coaching-trend-${variant.scope_variant}`}
                />
            </div>
        </Card>
    );
}

function CoachingContent({data}: {data: DeveloperPRReviewCoaching}): JSX.Element {
    const empty = data.all_pr.sufficient_periods === 0 && data.ai_assisted.sufficient_periods === 0;
    return (
        <div className="space-y-6">
            <p className="rounded-card bg-surface-raised px-3 py-2 text-xs text-muted">
                This is yours alone — your manager only ever sees team-level aggregates, never your
                individual numbers. It's a mirror for your own reflection, not a score.
            </p>
            {empty ? (
                <StatePanel
                    tone="accent"
                    testId="my-coaching-empty"
                    title="No PR review coaching yet"
                    description="Once a few of your pull requests have been reviewed and merged, your rework and review trajectory will appear here — split into all your PRs and the subset estimated to be AI-assisted."
                />
            ) : (
                <>
                    <VariantSection variant={data.all_pr} />
                    <VariantSection variant={data.ai_assisted} />
                </>
            )}
        </div>
    );
}

function PageHeader({children}: {children?: JSX.Element}): JSX.Element {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">My PR Coaching</h1>
                <p className="mt-1 text-sm text-muted">
                    Your pull-request review outcomes over time — visible only to you.
                </p>
            </div>
            {children}
        </div>
    );
}

export function MyCoaching(): JSX.Element {
    const [unit, setUnit] = useState<PRReviewPeriodUnit>('monthly');
    const coaching = useMyPRReviewCoaching(unit);

    return (
        <div className="space-y-6">
            <PageHeader>
                <PeriodUnitToggle value={unit} onChange={setUnit} />
            </PageHeader>

            {coaching.isPending ? (
                <Card>
                    <SkeletonChart />
                </Card>
            ) : null}

            {coaching.isError ? (
                <ErrorState
                    title="Failed to load your coaching"
                    detail={coaching.error?.message}
                    onRetry={() => void coaching.refetch()}
                />
            ) : null}

            {!coaching.isPending && !coaching.isError && coaching.data ? (
                coaching.data.enabled ? (
                    <CoachingContent data={coaching.data} />
                ) : (
                    // Pillar 2 disabled org-wide or for this team (Task 5.10): show an
                    // explicit off-state rather than coaching, and never touch the
                    // (absent) trajectory fields.
                    <StatePanel
                        tone="neutral"
                        testId="my-coaching-disabled"
                        title="PR/review coaching is turned off"
                        description="Your organization has disabled PR/review coaching. If you think it should be available, reach out to your admin."
                    />
                )
            ) : null}
        </div>
    );
}
