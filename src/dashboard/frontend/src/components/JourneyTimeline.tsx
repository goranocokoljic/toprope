import {Card} from './Card';
import {Badge, type BadgeTone} from './Badge';
import {TrendChart, type ChartDatum} from '../charts/TrendChart';
import {toolLabel} from './toolLabels';
import {tierLabel, tierTone, tierDescription} from './tier';
import {formatCurrency, formatDateTick} from './format';
import type {
    DeveloperJourney,
    JourneyAnnotation,
    JourneyTrajectoryPoint,
    MeJourneyEvent,
    MeJourneyTool,
} from '../api/types';

/**
 * The adoption-journey visualization (Task 4.11). A polished timeline of a
 * developer's AI adoption — first activity → now — with tool/plan transitions,
 * an activity trajectory, and annotated key moments. Shared by the developer's
 * own My Dashboard (`framing='self'`) and the manager's developer-detail view
 * (`framing='manager'`); the two differ only in copy. The payload carries no
 * prompt content and nothing rankable, so the manager surface is aggregate
 * journey/health, never a report card.
 */

export type JourneyFraming = 'self' | 'manager';

/** 'YYYY-MM-DD' → "March 2026"; passes bad input straight through. */
function formatMonthYear(value: string): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat(undefined, {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(date);
}

/** A signed monthly-cost delta like "+$180/mo", or null when costs are absent. */
function costDelta(oldCost: number | null, newCost: number | null): string | null {
    if (oldCost === null || newCost === null) {
        return null;
    }
    const delta = newCost - oldCost;
    if (delta === 0) {
        return null;
    }
    const sign = delta > 0 ? '+' : '−';
    return `${sign}${formatCurrency(Math.abs(delta))}/mo`;
}

/** Title + optional cost detail for a milestone. Neutral phrasing reads for both framings. */
function journeyEventText(event: MeJourneyEvent): {title: string; detail: string | null} {
    const tool = toolLabel(event.tool);
    if (event.type === 'started') {
        return {title: `Started using ${tool}`, detail: null};
    }
    if (event.type === 'tool_switch') {
        const from = event.from_tool ? toolLabel(event.from_tool) : 'another tool';
        return {
            title: `Switched from ${from} to ${tool}`,
            detail: costDelta(event.old_monthly_cost, event.new_monthly_cost),
        };
    }
    const from = event.from_plan ?? 'previous plan';
    const to = event.to_plan ?? 'a new plan';
    return {title: `${tool}: ${from} → ${to}`, detail: costDelta(event.old_monthly_cost, event.new_monthly_cost)};
}

function ToolSummary({tool}: {tool: MeJourneyTool}): JSX.Element {
    const parts: string[] = [];
    if (tool.started_on) {
        parts.push(`since ${formatMonthYear(tool.started_on)}`);
    }
    if (tool.active && tool.current_plan) {
        parts.push(tool.current_plan);
    }
    return (
        <span
            className={[
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                tool.active ? 'bg-accent-soft text-accent' : 'bg-surface-raised text-muted',
            ].join(' ')}
        >
            <span className="font-semibold">{toolLabel(tool.tool)}</span>
            {parts.length > 0 ? <span className="text-muted">{parts.join(' · ')}</span> : null}
        </span>
    );
}

const ANNOTATION_TONE: Record<JourneyAnnotation['type'], BadgeTone> = {
    first_active_week: 'accent',
    sustained_ramp: 'success',
    plateau: 'neutral',
};

/** The annotated key moments (first active week, sustained ramp, plateau). */
function KeyMoments({annotations}: {annotations: JourneyAnnotation[]}): JSX.Element | null {
    if (annotations.length === 0) {
        return null;
    }
    return (
        <div className="mb-4 flex flex-wrap gap-2" data-testid="journey-annotations">
            {annotations.map((a) => (
                <Badge key={`${a.type}-${a.week_start}`} tone={ANNOTATION_TONE[a.type]}>
                    {a.label} · {formatMonthYear(a.week_start)}
                </Badge>
            ))}
        </div>
    );
}

/** The weekly activity trajectory — engagement (active days) with magnitude overlaid. */
function Trajectory({trajectory}: {trajectory: JourneyTrajectoryPoint[]}): JSX.Element | null {
    if (trajectory.length === 0) {
        return null;
    }
    const data: ChartDatum[] = trajectory.map((p) => ({
        week_start: p.week_start,
        active_days: p.active_days,
        interactions: p.interactions,
        commits: p.commits,
    }));
    return (
        <div className="mb-5" data-testid="journey-trajectory">
            <TrendChart
                data={data}
                xKey="week_start"
                series={[
                    {key: 'active_days', label: 'Active days', axis: 'left'},
                    {key: 'interactions', label: 'AI interactions', axis: 'right'},
                    {key: 'commits', label: 'Commits', axis: 'right'},
                ]}
                variant="area"
                height={200}
                xTickFormatter={formatDateTick}
                emptyMessage="No activity yet."
                testId="journey-trajectory-chart"
            />
        </div>
    );
}

export function JourneyTimeline({
    journey,
    framing,
}: {
    journey: DeveloperJourney;
    framing: JourneyFraming;
}): JSX.Element {
    const title = framing === 'self' ? 'My adoption journey' : 'Adoption journey';
    const intro =
        framing === 'self'
            ? 'When you started with each tool and how your setup has evolved.'
            : 'This developer’s AI adoption over time — a growth story, not a ranking.';

    const {first_activity} = journey.bounds;

    return (
        <Card title={title}>
            <div className="-mt-2 mb-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted">{intro}</p>
                <div className="flex items-center gap-2">
                    {first_activity ? (
                        <span className="text-xs text-muted" data-testid="journey-since">
                            First activity {formatMonthYear(first_activity)}
                        </span>
                    ) : null}
                    {journey.tier !== 'none' ? (
                        <Badge tone={tierTone(journey.tier)} title={tierDescription(journey.tier)}>
                            {tierLabel(journey.tier)}
                        </Badge>
                    ) : null}
                </div>
            </div>

            <Trajectory trajectory={journey.trajectory} />
            <KeyMoments annotations={journey.annotations} />

            {journey.tools.length > 0 ? (
                <div className="mb-5 flex flex-wrap gap-2" data-testid="journey-tools">
                    {journey.tools.map((tool) => (
                        <ToolSummary key={tool.tool} tool={tool} />
                    ))}
                </div>
            ) : null}

            {journey.events.length > 0 ? (
                <ol className="space-y-4" data-testid="journey-timeline">
                    {journey.events.map((event, i) => {
                        const {title: eventTitle, detail} = journeyEventText(event);
                        return (
                            <li key={`${event.date}-${event.type}-${event.tool}-${i}`} className="flex gap-3">
                                <div className="flex flex-col items-center">
                                    <span aria-hidden className="mt-1 h-2.5 w-2.5 rounded-full bg-accent" />
                                    {i < journey.events.length - 1 ? (
                                        <span aria-hidden className="mt-1 w-px flex-1 bg-border" />
                                    ) : null}
                                </div>
                                <div className="pb-1">
                                    <p className="text-xs font-medium uppercase tracking-wider text-muted">
                                        {formatMonthYear(event.date)}
                                    </p>
                                    <p className="text-sm font-medium text-foreground">{eventTitle}</p>
                                    {detail ? <p className="text-xs text-muted">{detail}</p> : null}
                                </div>
                            </li>
                        );
                    })}
                </ol>
            ) : (
                <p className="text-sm text-muted">
                    {framing === 'self'
                        ? 'Your journey starts here — milestones will appear as your tool usage is tracked.'
                        : 'No milestones yet — they will appear as this developer’s tool usage is tracked.'}
                </p>
            )}
        </Card>
    );
}
