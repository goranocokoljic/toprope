import {useState} from 'react';
import {useTeams, useTeamPRReviewCoaching} from '../hooks/useTeamData';
import {Card} from '../components/Card';
import {Badge} from '../components/Badge';
import {PeriodUnitToggle} from '../components/PeriodUnitToggle';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {SkeletonChart} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {StatePanel} from '../components/StatePanel';
import {formatPercent} from '../components/format';
import {combinedSignalCopy, formatPeriodTick, reworkTrendSentence, teamVariantTitle} from '../components/coaching';
import type {
    PRReviewPeriodUnit,
    TeamCoachingVariantTrajectory,
    TeamPRReviewCoaching,
} from '../api/types';

/**
 * Manager "Team Coaching" (Task 5.3). TEAM-LEVEL aggregates ONLY — there is no
 * way to reach an individual developer's coaching from here. Every period is
 * pooled across the team and any period with too few contributing developers is
 * suppressed server-side, so no individual's rework/rejection numbers are ever
 * shown. Two clearly-separated variants stay labeled factual / inferred.
 */

const ORG_SCOPE = 'org';

function trajectoryData(variant: TeamCoachingVariantTrajectory): ChartDatum[] {
    return variant.points.map((p) => ({
        period: p.period,
        // Suppressed periods carry null numbers; the chart simply gaps them.
        rework: p.rework_rate,
    }));
}

/** True when at least one period was suppressed for cohort size (k-anonymity). */
function hasSuppressedPeriods(variant: TeamCoachingVariantTrajectory): boolean {
    return variant.points.some((p) => p.suppressed);
}

function TeamVariantSection({variant}: {variant: TeamCoachingVariantTrajectory}): JSX.Element {
    const inferred = variant.basis === 'inferred';
    const title = teamVariantTitle(variant.scope_variant);
    const signal = combinedSignalCopy(variant.latest_signal, 'team');
    const subjectPhrase = inferred ? "the team's AI-assisted PRs" : "the team's PRs";
    const sentence = reworkTrendSentence(variant.rework_trend, subjectPhrase);
    const hasData = variant.sufficient_periods > 0;

    return (
        <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">{title}</h2>
                    {inferred ? (
                        <Badge tone="warning" title="Inferred from PRs' estimated AI signature — lower confidence.">
                            Inferred · lower confidence
                        </Badge>
                    ) : (
                        <Badge tone="neutral" title="Measured directly from the team's pull requests.">
                            Factual
                        </Badge>
                    )}
                </div>
                {hasData ? <Badge tone={signal.tone}>{signal.label}</Badge> : null}
            </div>

            <p className="text-sm text-foreground" data-testid="team-trajectory-sentence">
                {sentence ??
                    'Not enough team-level history yet to show a trend. As more PRs across the team are reviewed, the trajectory will appear here.'}
            </p>
            <p className="mt-1 text-sm text-muted">{signal.guidance}</p>

            <div className="mt-4">
                <TrendChart
                    data={trajectoryData(variant)}
                    xKey="period"
                    series={[{key: 'rework', label: 'Team rework rate'}]}
                    variant="line"
                    height={220}
                    xTickFormatter={formatPeriodTick}
                    valueFormatter={(v) => (typeof v === 'number' ? formatPercent(v) : String(v))}
                    emptyMessage="No team-level PR review data in this range yet."
                    testId={`team-coaching-trend-${variant.scope_variant}`}
                />
            </div>

            {hasSuppressedPeriods(variant) ? (
                <p className="mt-3 text-xs text-muted" data-testid="suppression-note">
                    Some periods are hidden because too few developers contributed PRs to aggregate
                    safely — team coaching never exposes an individual's numbers.
                </p>
            ) : null}
        </Card>
    );
}

function ScopeSelector({
    value,
    teams,
    onChange,
}: {
    value: string;
    teams: string[];
    onChange: (scope: string) => void;
}): JSX.Element {
    return (
        <label className="flex items-center gap-2 text-sm text-muted">
            <span>Scope</span>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                aria-label="Team scope"
            >
                <option value={ORG_SCOPE}>Whole org</option>
                {teams.map((team) => (
                    <option key={team} value={team}>
                        {team}
                    </option>
                ))}
            </select>
        </label>
    );
}

function CoachingBody({data}: {data: TeamPRReviewCoaching}): JSX.Element {
    const empty = data.all_pr.sufficient_periods === 0 && data.ai_assisted.sufficient_periods === 0;
    return (
        <div className="space-y-6">
            <p className="rounded-card bg-surface-raised px-3 py-2 text-xs text-muted">
                Team aggregates only. Individual developers' rework and review numbers are private to
                them — this view never shows or links to any one person's figures.
            </p>
            {empty ? (
                <StatePanel
                    tone="accent"
                    testId="team-coaching-empty"
                    title="No team coaching signal yet"
                    description="Once enough developers on this team have reviewed-and-merged PRs, the team's aggregate rework and review trajectory will appear here. Periods with too few contributors stay hidden to protect individuals."
                />
            ) : (
                <>
                    <TeamVariantSection variant={data.all_pr} />
                    <TeamVariantSection variant={data.ai_assisted} />
                </>
            )}
        </div>
    );
}

export function TeamCoaching(): JSX.Element {
    const [unit, setUnit] = useState<PRReviewPeriodUnit>('monthly');
    const [scope, setScope] = useState<string>(ORG_SCOPE);
    const teams = useTeams();
    const coaching = useTeamPRReviewCoaching(scope, unit);

    const teamNames = (teams.data ?? []).map((t) => t.name);

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold text-foreground">Team Coaching</h1>
                    <p className="mt-1 text-sm text-muted">
                        Team-level PR/review trends — aggregate only, never an individual's numbers.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <ScopeSelector value={scope} teams={teamNames} onChange={setScope} />
                    <PeriodUnitToggle value={unit} onChange={setUnit} />
                </div>
            </div>

            {coaching.isPending ? (
                <Card>
                    <SkeletonChart />
                </Card>
            ) : null}

            {coaching.isError ? (
                <ErrorState
                    title="Failed to load team coaching"
                    detail={coaching.error?.message}
                    onRetry={() => void coaching.refetch()}
                />
            ) : null}

            {!coaching.isPending && !coaching.isError && coaching.data ? (
                coaching.data.enabled ? (
                    <CoachingBody data={coaching.data} />
                ) : (
                    // Pillar 2 disabled org-wide or for this team (Task 5.10): the
                    // aggregate is hidden here too, not just on the developer view.
                    <StatePanel
                        tone="neutral"
                        testId="team-coaching-disabled"
                        title="PR/review coaching is turned off"
                        description="PR/review coaching is disabled for this scope, so no team aggregate is shown."
                    />
                )
            ) : null}
        </div>
    );
}
