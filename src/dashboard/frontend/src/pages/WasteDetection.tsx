import {useMemo, useState} from 'react';
import {useWasteAlerts, useResolvedWaste, useResolveWaste} from '../hooks/useWaste';
import {Card, StatCard} from '../components/Card';
import {Badge} from '../components/Badge';
import {SkeletonStatCard, SkeletonText} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {EmptyState} from '../components/EmptyState';
import {toolLabel} from '../components/toolLabels';
import {wasteTypeLabel} from '../components/utilization';
import {formatCurrency} from '../components/format';
import {
    RESOLUTION_OPTIONS,
    describeWasteAlert,
    planRoiDetails,
    resolutionLabel,
} from '../components/waste';
import type {WasteAlert, WasteResolutionReason} from '../api/types';

// --- Summary ---------------------------------------------------------------

interface WasteTotals {
    monthlyWaste: number;
    annualSavings: number;
    alertCount: number;
    planRoiCount: number;
    byType: {type: string; count: number; monthlyWaste: number}[];
}

/**
 * Roll the active alert list into the headline numbers. plan_roi alerts carry a
 * null monthly_waste on purpose (a flagged upgrade is a *review prompt*, not
 * confirmed waste), so they never inflate the hard-dollar totals — they're
 * counted separately as reviews. Annual savings is simply 12× the confirmed
 * monthly waste.
 */
function computeTotals(alerts: WasteAlert[]): WasteTotals {
    const byTypeMap = new Map<string, {count: number; monthlyWaste: number}>();
    let monthlyWaste = 0;
    let planRoiCount = 0;

    for (const a of alerts) {
        // Guard the sum the way the detail readers guard their inputs: a null
        // (advisory plan_roi/cost_outlier) or any non-finite value contributes 0,
        // so the headline total and 12x projection can never read $NaN.
        const dollars =
            typeof a.monthly_waste === 'number' && Number.isFinite(a.monthly_waste) ? a.monthly_waste : 0;
        monthlyWaste += dollars;
        if (a.alert_type === 'plan_roi') planRoiCount += 1;
        const entry = byTypeMap.get(a.alert_type) ?? {count: 0, monthlyWaste: 0};
        entry.count += 1;
        entry.monthlyWaste += dollars;
        byTypeMap.set(a.alert_type, entry);
    }

    const byType = [...byTypeMap.entries()]
        .map(([type, v]) => ({type, ...v}))
        .sort((a, b) => b.monthlyWaste - a.monthlyWaste || b.count - a.count);

    return {
        monthlyWaste,
        annualSavings: monthlyWaste * 12,
        alertCount: alerts.length,
        planRoiCount,
        byType,
    };
}

function SummaryCards({totals}: {totals: WasteTotals}): JSX.Element {
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
                label="Monthly waste"
                value={formatCurrency(totals.monthlyWaste)}
                hint="from confirmed open alerts"
            />
            <StatCard
                label="Projected annual savings"
                value={formatCurrency(totals.annualSavings)}
                hint="if every open alert is resolved"
            />
            <StatCard
                label="Active alerts"
                value={String(totals.alertCount)}
                hint={`across ${totals.byType.length} ${totals.byType.length === 1 ? 'category' : 'categories'}`}
            />
            <StatCard
                label="Plan ROI reviews"
                value={String(totals.planRoiCount)}
                hint="upgrades worth a second look"
            />
        </div>
    );
}

function TypeBreakdown({totals}: {totals: WasteTotals}): JSX.Element {
    return (
        <Card title="Breakdown by type">
            <ul className="space-y-2">
                {totals.byType.map((t) => (
                    <li key={t.type} className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2">
                            <Badge tone="neutral">{wasteTypeLabel(t.type)}</Badge>
                            <span className="text-xs text-muted">
                                {t.count} {t.count === 1 ? 'alert' : 'alerts'}
                            </span>
                        </span>
                        <span className="tabular-nums text-sm font-medium text-foreground">
                            {t.monthlyWaste > 0 ? `${formatCurrency(t.monthlyWaste)}/mo` : 'review'}
                        </span>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

// --- Resolution control ----------------------------------------------------

function ResolveControl({alert}: {alert: WasteAlert}): JSX.Element {
    const resolve = useResolveWaste();
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState<WasteResolutionReason>(RESOLUTION_OPTIONS[0].value);

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised"
            >
                Review &amp; resolve
            </button>
        );
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted">
                <span>Outcome</span>
                <select
                    aria-label="Resolution reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value as WasteResolutionReason)}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
                >
                    {RESOLUTION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </label>
            <button
                type="button"
                onClick={() => resolve.mutate({id: alert.id, reason})}
                disabled={resolve.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
                {resolve.isPending ? 'Saving…' : 'Confirm'}
            </button>
            <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={resolve.isPending}
                className="text-xs font-medium text-muted hover:text-foreground"
            >
                Cancel
            </button>
            {resolve.isError ? (
                <span className="text-xs text-danger">Couldn&apos;t save — try again.</span>
            ) : null}
        </div>
    );
}

// --- Alert rows ------------------------------------------------------------

function AlertIdentity({alert}: {alert: WasteAlert}): JSX.Element {
    return (
        <span className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">{wasteTypeLabel(alert.alert_type)}</Badge>
            <span className="text-sm font-medium text-foreground">
                {alert.developer_name ?? 'Unassigned seat'}
            </span>
            {alert.tool ? <span className="text-xs text-muted">{toolLabel(alert.tool)}</span> : null}
            <span className="text-xs text-muted">· {alert.team}</span>
        </span>
    );
}

function GenericAlertCard({alert}: {alert: WasteAlert}): JSX.Element {
    const detail = describeWasteAlert(alert);
    return (
        <li className="rounded-card border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <AlertIdentity alert={alert} />
                <span className="tabular-nums text-sm font-semibold text-foreground">
                    {alert.monthly_waste != null ? `${formatCurrency(alert.monthly_waste)}/mo` : 'For review'}
                </span>
            </div>
            {detail ? <p className="mt-2 text-sm text-muted">{detail}</p> : null}
            <div className="mt-3">
                <ResolveControl alert={alert} />
            </div>
        </li>
    );
}

/**
 * Plan-ROI alerts get a dedicated, highlighted treatment: the before/after
 * plan, the cost delta, and the usage delta side by side, framed as a review
 * prompt ("worth confirming the upgrade is delivering value"), never as the
 * developer doing something wrong.
 */
function PlanRoiCard({alert}: {alert: WasteAlert}): JSX.Element {
    const d = planRoiDetails(alert);
    const costDeltaLabel =
        d.costDelta != null ? `${d.costDelta >= 0 ? '+' : ''}${formatCurrency(d.costDelta)}/mo` : '—';
    // usage_delta is a difference of average daily-usage rates the backend
    // rounds to 2dp, so it's usually fractional (e.g. 1.83). Round to 1dp for a
    // clean display rather than rendering the raw noisy decimal.
    const usageDeltaLabel =
        d.usageDelta != null
            ? `${d.usageDelta >= 0 ? '+' : ''}${Math.round(d.usageDelta * 10) / 10} interactions/day`
            : '—';

    return (
        <li className="rounded-card border border-accent/40 bg-accent-soft p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">Plan ROI review</Badge>
                    <span className="text-sm font-medium text-foreground">
                        {d.developerName ?? 'Developer'}
                    </span>
                    {d.tool ? <span className="text-xs text-muted">{toolLabel(d.tool)}</span> : null}
                    <span className="text-xs text-muted">· {alert.team}</span>
                </span>
                {d.daysSinceChange != null ? (
                    <span className="text-xs text-muted">{d.daysSinceChange} days ago</span>
                ) : null}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted">Plan change</p>
                    <p className="mt-1 text-sm text-foreground">
                        {d.oldPlan ?? 'Previous plan'} <span aria-hidden>→</span> {d.newPlan ?? 'New plan'}
                    </p>
                </div>
                <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted">Cost change</p>
                    <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">{costDeltaLabel}</p>
                </div>
                <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted">Usage change</p>
                    <p className="mt-1 text-sm tabular-nums text-foreground">{usageDeltaLabel}</p>
                </div>
            </div>

            <p className="mt-3 text-sm text-muted">
                {d.note ??
                    'Cost rose more than usage since this upgrade — worth confirming the higher plan is delivering value for this developer.'}
            </p>
            <div className="mt-3">
                <ResolveControl alert={alert} />
            </div>
        </li>
    );
}

function ActiveAlerts({alerts}: {alerts: WasteAlert[]}): JSX.Element {
    const planRoi = alerts.filter((a) => a.alert_type === 'plan_roi');
    const others = alerts.filter((a) => a.alert_type !== 'plan_roi');

    if (alerts.length === 0) {
        return (
            <EmptyState
                title="No active waste detected"
                message="Every tracked seat is being used and no plan changes need review right now. Your AI spend looks efficient — nice work."
                testId="waste-empty"
            />
        );
    }

    return (
        <div className="space-y-6">
            {planRoi.length > 0 ? (
                <Card title="Plan ROI — upgrades worth reviewing">
                    <p className="mb-3 text-xs text-muted">
                        A developer moved to a pricier plan but usage didn&apos;t rise to match. These are
                        prompts to review, not conclusions — there may be good reasons.
                    </p>
                    <ul className="space-y-3">
                        {planRoi.map((a) => (
                            <PlanRoiCard key={a.id} alert={a} />
                        ))}
                    </ul>
                </Card>
            ) : null}

            {others.length > 0 ? (
                <Card title="Waste alerts">
                    <ul className="space-y-3">
                        {others.map((a) => (
                            <GenericAlertCard key={a.id} alert={a} />
                        ))}
                    </ul>
                </Card>
            ) : null}
        </div>
    );
}

// --- Resolved (audit trail) ------------------------------------------------

function formatResolvedDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short', day: 'numeric'}).format(date);
}

function ResolvedAlerts(): JSX.Element {
    const {data, isPending, isError, error, refetch} = useResolvedWaste();
    const alerts = data ?? [];

    if (isPending) return <SkeletonText lines={4} />;
    if (isError) {
        return (
            <ErrorState
                title="Failed to load resolved alerts"
                detail={error?.message}
                onRetry={() => void refetch()}
            />
        );
    }
    if (alerts.length === 0) {
        return (
            <EmptyState
                title="No resolved alerts yet"
                message="Once you resolve a waste alert, it moves here as an audit trail of what was decided and why."
                testId="resolved-empty"
            />
        );
    }

    return (
        <Card title="Resolved alerts">
            <ul className="space-y-2">
                {alerts.map((a) => (
                    <li
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0"
                    >
                        <span className="flex flex-wrap items-center gap-2">
                            <Badge tone="neutral">{wasteTypeLabel(a.alert_type)}</Badge>
                            <span className="text-sm text-foreground">
                                {a.developer_name ?? 'Unassigned seat'}
                            </span>
                            {a.tool ? <span className="text-xs text-muted">{toolLabel(a.tool)}</span> : null}
                            <span className="text-xs text-muted">· {a.team}</span>
                        </span>
                        <span className="flex items-center gap-3 text-right">
                            <Badge tone="success">{resolutionLabel(a.resolution)}</Badge>
                            <span className="text-xs text-muted">{formatResolvedDate(a.resolved_at)}</span>
                        </span>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

// --- Page ------------------------------------------------------------------

type Tab = 'active' | 'resolved';

function TabButton({active, onClick, children}: {active: boolean; onClick: () => void; children: string}): JSX.Element {
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

function LoadingWaste(): JSX.Element {
    return (
        <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
            </div>
            <Card title="Waste alerts">
                <SkeletonText lines={4} />
            </Card>
        </>
    );
}

/**
 * Manager Waste Detection screen (Task 2.7). Active/resolved tabs, summary
 * totals, categorized alerts, highlighted Plan-ROI reviews, and a
 * resolve-with-reason workflow over the admin-guarded /api/waste family.
 *
 * Unlike ManagerOverview, this screen does NOT use the shared classifyDataState:
 * an alert list has no per-scope collection window, so "no active alerts" is a
 * genuine-empty (a positive "spend looks efficient" confirmation), never
 * cold-start. The simple isPending/isError/length branching below is deliberate.
 */
export function WasteDetection(): JSX.Element {
    const {data, isPending, isError, error, refetch} = useWasteAlerts();
    const [tab, setTab] = useState<Tab>('active');

    const alerts = useMemo(() => data ?? [], [data]);
    const totals = useMemo(() => computeTotals(alerts), [alerts]);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Waste Detection</h1>
                <p className="mt-1 text-sm text-muted">
                    Spend-optimization review — unused and underutilized seats, duplicate tools, cost
                    outliers, and plan-change ROI. Every alert is a prompt to review, never developer blame.
                </p>
            </div>

            <div className="flex gap-2">
                <TabButton active={tab === 'active'} onClick={() => setTab('active')}>
                    Active
                </TabButton>
                <TabButton active={tab === 'resolved'} onClick={() => setTab('resolved')}>
                    Resolved
                </TabButton>
            </div>

            {tab === 'active' ? (
                <>
                    {isPending ? <LoadingWaste /> : null}
                    {/* A failed load must NOT read as "all clear" on the savings surface. */}
                    {isError ? (
                        <ErrorState
                            title="Failed to load waste alerts"
                            detail={error?.message}
                            onRetry={() => void refetch()}
                        />
                    ) : null}
                    {!isPending && !isError ? (
                        <>
                            <SummaryCards totals={totals} />
                            {/* Single grid: ActiveAlerts owns its own empty state,
                                so the breakdown is simply omitted when there are no
                                alerts (byType is empty iff alerts is empty). */}
                            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                                <div className="lg:col-span-2">
                                    <ActiveAlerts alerts={alerts} />
                                </div>
                                {totals.byType.length > 0 ? (
                                    <div>
                                        <TypeBreakdown totals={totals} />
                                    </div>
                                ) : null}
                            </div>
                        </>
                    ) : null}
                </>
            ) : (
                <ResolvedAlerts />
            )}
        </div>
    );
}
