import {useState} from 'react';
import {useTeams, useManagerCoachingPanel} from '../hooks/useTeamData';
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
    LoopNudgeAggregate,
    ManagerCoachingPanel,
    PRReviewPeriodUnit,
    TeamAvailableCoaching,
    TeamAvailablePoint,
    TeamCoachingOpportunity,
    TeamCoachingVariantTrajectory,
    TeamPRReviewCoaching,
} from '../api/types';

/**
 * Manager "Team Coaching" — the unified TEAM-LEVEL aggregate panel (Task 5.11).
 * Surfaces all three coaching pillars (PR/review trends, churn/effectiveness
 * trends, and anonymized loop/nudge patterns from opted-in developers only) plus
 * synthesized team coaching opportunities. There is NO way to reach an individual
 * developer's coaching from here: every section is a server-floored aggregate, the
 * loop/nudge data is opted-in only, and no payload carries a developer id.
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
                    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
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

/** A small section frame with a heading, used by each pillar block. */
function Section({title, subtitle, children}: {title: string; subtitle: string; children: React.ReactNode}): JSX.Element {
    return (
        <section className="space-y-3">
            <div>
                <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                <p className="text-sm text-muted">{subtitle}</p>
            </div>
            {children}
        </section>
    );
}

/** A pillar that org/team policy has turned off — shown as a neutral off-state. */
function PillarOff({testId, title, description}: {testId: string; title: string; description: string}): JSX.Element {
    return <StatePanel tone="neutral" testId={testId} title={title} description={description} />;
}

// ── Opportunities ───────────────────────────────────────────────────────────

function OpportunitiesSection({opportunities}: {opportunities: TeamCoachingOpportunity[]}): JSX.Element | null {
    if (opportunities.length === 0) return null;
    return (
        <Card>
            <h2 className="text-lg font-semibold text-foreground">Team coaching opportunities</h2>
            <p className="mt-1 text-sm text-muted">
                Suggestions drawn from team-level patterns — opportunities to support the team, never
                a judgment of any individual.
            </p>
            <ul className="mt-4 space-y-3" data-testid="coaching-opportunities">
                {opportunities.map((op) => (
                    <li key={op.id} className="rounded-card bg-surface-raised px-3 py-2">
                        <p className="text-sm font-medium text-foreground">{op.title}</p>
                        <p className="mt-1 text-sm text-muted">{op.suggestion}</p>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

// ── PR/review pillar ─────────────────────────────────────────────────────────

function PRReviewSection({pr}: {pr: TeamPRReviewCoaching}): JSX.Element {
    const empty = pr.all_pr.sufficient_periods === 0 && pr.ai_assisted.sufficient_periods === 0;
    return (
        <Section
            title="PR & review trends"
            subtitle="Team-level rework and review trajectory — all PRs (factual) and AI-assisted PRs (inferred), kept separate."
        >
            {empty ? (
                <StatePanel
                    tone="accent"
                    testId="team-coaching-empty"
                    title="No team PR/review signal yet"
                    description="Once enough developers on this team have reviewed-and-merged PRs, the team's aggregate rework and review trajectory will appear here. Periods with too few contributors stay hidden to protect individuals."
                />
            ) : (
                <>
                    <TeamVariantSection variant={pr.all_pr} />
                    <TeamVariantSection variant={pr.ai_assisted} />
                </>
            )}
        </Section>
    );
}

// ── Available-data (churn/effectiveness) pillar ──────────────────────────────

const SIGNAL_LABEL: Record<string, string> = {
    churn_reflection: 'Code churn',
    acceptance_trend: 'Suggestion acceptance',
    journey_coaching: 'Adoption journey',
    personal_insight: 'Personal insights',
};

/** The most recent non-suppressed point of a signal series, or null. */
function latestSufficient(points: TeamAvailablePoint[]): TeamAvailablePoint | null {
    for (let i = points.length - 1; i >= 0; i--) {
        if (!points[i].suppressed) return points[i];
    }
    return null;
}

/** A compact "category × count" summary of one aggregated point. */
function categorySummary(point: TeamAvailablePoint): string {
    if (!point.categories) return '';
    return Object.entries(point.categories)
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => `${count} ${category}`)
        .join(', ');
}

function AvailableSection({available}: {available: TeamAvailableCoaching}): JSX.Element {
    const rows = available.series
        .map((s) => ({signal_type: s.signal_type, point: latestSufficient(s.points)}))
        .filter((r): r is {signal_type: typeof r.signal_type; point: TeamAvailablePoint} => r.point !== null);

    return (
        <Section
            title="Effectiveness & churn"
            subtitle="Team-level trends from available data (git churn, acceptance, journey) — counts only, never an individual's figures or coaching text."
        >
            <Card>
                {rows.length === 0 ? (
                    <p className="text-sm text-muted" data-testid="available-empty">
                        Not enough team-level coaching data yet — periods with too few contributing
                        developers stay hidden, so nothing here can identify an individual.
                    </p>
                ) : (
                    <ul className="space-y-2" data-testid="available-summary">
                        {rows.map(({signal_type, point}) => (
                            <li key={signal_type} className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-sm font-medium text-foreground">
                                    {SIGNAL_LABEL[signal_type] ?? signal_type}
                                </span>
                                <span className="text-sm text-muted">
                                    {point.developers} developers · {categorySummary(point)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </Section>
    );
}

// ── Loop/nudge pillar (opted-in only) ────────────────────────────────────────

const NUDGE_LABEL: Record<string, string> = {
    short_prompt: 'Very short prompts',
    missing_context: 'Missing context',
    missing_error: 'Missing error text',
    repeated_prompt: 'Repeated prompts',
};

function LoopNudgeSection({loopNudge}: {loopNudge: LoopNudgeAggregate}): JSX.Element {
    const cells: Array<{label: string; cell: {suppressed: boolean; developers: number | null}}> = [
        {label: 'Detection loops', cell: loopNudge.loops},
        ...loopNudge.nudges.map((n) => ({label: NUDGE_LABEL[n.nudge_type] ?? n.nudge_type, cell: n})),
    ];
    const anyShown = cells.some((c) => !c.cell.suppressed);
    // The eligibility count is floored: null = "some, but too few to name safely";
    // 0 = nobody opted in; a number = the exact (>= floor) count.
    const optInBasis =
        loopNudge.opted_in_developers === null
            ? 'Based on the opted-in developers in this scope (too few to show the exact count without identifying them).'
            : loopNudge.opted_in_developers === 0
              ? 'No developers in this scope have opted into prompt capture yet.'
              : `Based on ${loopNudge.opted_in_developers} opted-in developers in this scope.`;

    return (
        <Section
            title="Prompt loops & nudges"
            subtitle="Anonymized patterns from developers who opted into prompt capture — counts only, never prompt content."
        >
            <Card>
                <p className="text-xs text-muted" data-testid="loop-nudge-optin">
                    {optInBasis} Only opted-in developers' patterns are ever included.
                </p>
                {anyShown ? (
                    <ul className="mt-3 space-y-2" data-testid="loop-nudge-summary">
                        {cells
                            .filter((c) => !c.cell.suppressed)
                            .map((c) => (
                                <li key={c.label} className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium text-foreground">{c.label}</span>
                                    <span className="text-sm text-muted">{c.cell.developers} developers</span>
                                </li>
                            ))}
                    </ul>
                ) : (
                    <p className="mt-3 text-sm text-muted" data-testid="loop-nudge-empty">
                        No team-level loop/nudge pattern to show yet. Patterns stay hidden until enough
                        opted-in developers share them, so no individual can be identified.
                    </p>
                )}
            </Card>
        </Section>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function PanelBody({panel}: {panel: ManagerCoachingPanel}): JSX.Element {
    return (
        <div className="space-y-8">
            <p className="rounded-card bg-surface-raised px-3 py-2 text-xs text-muted">
                Team aggregates only. Individual developers' coaching — their rework and review numbers,
                churn, and prompt loops/nudges — is private to them. This view never shows or links to any
                one person's figures.
            </p>

            <OpportunitiesSection opportunities={panel.opportunities} />

            {panel.pr_review.enabled ? (
                <PRReviewSection pr={panel.pr_review} />
            ) : (
                <PillarOff
                    testId="pr-review-disabled"
                    title="PR/review coaching is turned off"
                    description="PR/review coaching is disabled for this scope, so no team aggregate is shown."
                />
            )}

            {panel.available.enabled ? (
                <AvailableSection available={panel.available} />
            ) : (
                <PillarOff
                    testId="available-disabled"
                    title="Available-data coaching is turned off"
                    description="Churn/effectiveness coaching is disabled for this scope, so no team aggregate is shown."
                />
            )}

            {panel.loop_nudge.enabled ? (
                <LoopNudgeSection loopNudge={panel.loop_nudge} />
            ) : (
                <PillarOff
                    testId="loop-nudge-disabled"
                    title="Prompt-capture coaching is not enabled"
                    description="Prompt capture is not permitted for this scope, so there are no opted-in loop/nudge patterns to aggregate."
                />
            )}
        </div>
    );
}

export function TeamCoaching(): JSX.Element {
    const [unit, setUnit] = useState<PRReviewPeriodUnit>('monthly');
    const [scope, setScope] = useState<string>(ORG_SCOPE);
    const teams = useTeams();
    const panel = useManagerCoachingPanel(scope, unit);

    const teamNames = (teams.data ?? []).map((t) => t.name);

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold text-foreground">Team Coaching</h1>
                    <p className="mt-1 text-sm text-muted">
                        Team-level coaching aggregates across every pillar — aggregate only, never an
                        individual's numbers.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <ScopeSelector value={scope} teams={teamNames} onChange={setScope} />
                    <PeriodUnitToggle value={unit} onChange={setUnit} />
                </div>
            </div>

            {panel.isPending ? (
                <Card>
                    <SkeletonChart />
                </Card>
            ) : null}

            {panel.isError ? (
                <ErrorState
                    title="Failed to load team coaching"
                    detail={panel.error?.message}
                    onRetry={() => void panel.refetch()}
                />
            ) : null}

            {!panel.isPending && !panel.isError && panel.data ? <PanelBody panel={panel.data} /> : null}
        </div>
    );
}
