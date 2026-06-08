import Database from 'better-sqlite3';
import {randomUUID} from 'crypto';

/**
 * Expense reconciliation (Task 4.4 / #99).
 *
 * Matches imported expense charges against the subscription registry for a
 * period and records each mismatch in reconciliation_results, so a manager can
 * trust the platform's "total monthly AI spend" number. Results are surfaced to
 * the admin for resolution (resolve with a note, or ignore to suppress).
 */

export type ReconciliationResultType =
    | 'expense_no_subscription'
    | 'subscription_no_expense'
    | 'cost_discrepancy';

export type ReconciliationStatus = 'open' | 'resolved' | 'ignored';

/** A row of reconciliation_results. */
export interface ReconciliationResult {
    id: string;
    run_at: string;
    period: string;
    result_type: ReconciliationResultType;
    developer_id: string | null;
    tool: string | null;
    expense_amount: number | null;
    registry_amount: number | null;
    details: string | null;
    status: ReconciliationStatus;
    resolution: string | null;
    resolved_at: string | null;
}

/** A reconciliation result joined with its developer's name/email/team. */
export interface ReconciliationResultWithDeveloper extends ReconciliationResult {
    developer_name: string | null;
    developer_email: string | null;
    team: string | null;
}

/**
 * Default cost tolerance ($). Discrepancies at or below this are treated as
 * rounding/noise and not flagged. Overridable per run (config / CLI).
 */
export const DEFAULT_COST_TOLERANCE = 1;

/**
 * Billing models whose seats are expected to appear in a reimbursement expense
 * feed. A subscription with any other billing model — most importantly
 * `company_managed` — is NOT flagged subscription_no_expense, because a
 * company-managed/central seat legitimately never shows up in a reimbursement
 * feed and flagging it would be a false positive.
 */
export const EXPENSE_EXPECTED_BILLING_MODELS = new Set(['reimbursed', 'personal']);

export interface ReconcileOptions {
    /** Cost tolerance ($) for cost_discrepancy. Defaults to DEFAULT_COST_TOLERANCE. */
    tolerance?: number;
    /** Override the run timestamp (testing). Defaults to now. */
    runAt?: string;
}

export interface ReconcileSummary {
    period: string;
    run_at: string;
    tolerance: number;
    /** Newly inserted results this run. */
    created: number;
    /** Conditions skipped because an open/ignored result already existed. */
    skipped: number;
    byType: Record<ReconciliationResultType, number>;
}

// YYYY-MM with a real month (01-12), so an impossible month like 2026-13 is
// rejected at the boundary rather than silently reconciling nothing.
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Aggregated expense side of a (developer, tool) for one period. */
interface ExpenseAgg {
    developer_id: string;
    tool: string;
    /** Summed normalized monthly cost, or null when no charge carried a cost. */
    amount: number | null;
    charge_count: number;
}

/** The representative subscription seat for a (developer, tool) in one period. */
interface SubAgg {
    developer_id: string;
    tool: string;
    amount: number | null;
    billing_model: string;
}

function key(developerId: string, tool: string): string {
    return `${developerId} ${tool}`;
}

/**
 * Shift a YYYY-MM period back by `months` calendar months. Used to build the
 * trailing window over which an annual charge is considered to cover a month.
 * `period` must already be validated YYYY-MM.
 */
function periodMinusMonths(period: string, months: number): string {
    const [year, month] = period.split('-').map(Number);
    const zeroBased = year * 12 + (month - 1) - months;
    const newYear = Math.floor(zeroBased / 12);
    const newMonth = (zeroBased % 12) + 1;
    return `${String(newYear).padStart(4, '0')}-${String(newMonth).padStart(2, '0')}`;
}

// An annual charge pays for the 12 months starting at its charge period, so a
// charge seen in month Q covers reconciliation for Q .. Q+11. Without this an
// annually-billed seat would be flagged subscription_no_expense for the other 11
// months of the year (the charge row only exists in Q).
const ANNUAL_COVERAGE_MONTHS = 12;

/**
 * Recurring expense charges relevant to the period, aggregated per (developer,
 * tool). Only matched charges (developer_id set) with a recurring charge type
 * are considered — one-time charges and unmatched rows (handled by the
 * resolution queue) are not subscriptions and never produce reconciliation
 * results. Monthly charges match the exact period; an annual charge matches when
 * the reconciled period falls inside its 12-month coverage window
 * (chargePeriod .. chargePeriod+11), so an annually-billed seat is not
 * false-flagged in the 11 months its single charge row does not fall in.
 */
function getPeriodExpenses(db: Database.Database, period: string): ExpenseAgg[] {
    const annualWindowStart = periodMinusMonths(period, ANNUAL_COVERAGE_MONTHS - 1);
    return db
        .prepare(
            `SELECT developer_id, tool,
                    SUM(monthly_cost) AS amount,
                    COUNT(*) AS charge_count
             FROM expense_charges e
             WHERE developer_id IS NOT NULL
               AND (
                 (charge_type = 'recurring_monthly' AND period = ?)
                 OR (
                   charge_type = 'recurring_annual'
                   AND period >= ? AND period <= ?
                   -- Annual coverage is a fallback: only when this dev/tool has no
                   -- monthly charge for the exact period. Otherwise an annual row
                   -- (from an earlier month in the window) and the period's monthly
                   -- row would both be summed, double-counting the expense and
                   -- manufacturing a phantom cost_discrepancy.
                   AND NOT EXISTS (
                     SELECT 1 FROM expense_charges m
                     WHERE m.developer_id = e.developer_id AND m.tool = e.tool
                       AND m.charge_type = 'recurring_monthly' AND m.period = ?
                   )
                 )
               )
             GROUP BY developer_id, tool`,
        )
        .all(period, annualWindowStart, period, period) as ExpenseAgg[];
}

/**
 * The single subscription seat representing each (developer, tool) for the
 * period: the seat active during the period with the latest seat_assigned_at
 * (ties broken by id). A seat is active in a month when it was assigned on or
 * before that month (a NULL assign date is treated as "always assigned") and not
 * revoked before it, compared on the YYYY-MM prefix so a seat held for any part
 * of the month counts.
 *
 * This is a deliberate month-granularity rule, distinct from subscription-
 * tracker's day-level isActiveOnDate. It picks ONE row per (developer, tool)
 * rather than aggregating, because the tracker models a plan change as
 * revoke-old + insert-new for the same dev/tool: within the reconciled month
 * BOTH rows overlap, and summing them would double-count the registry cost
 * (manufacturing a phantom cost_discrepancy) while a MIN() over their billing
 * models could misclassify the seat. Taking the latest-assigned active seat
 * yields the plan in effect at period end — the right basis to compare a monthly
 * expense against — with its true billing_model.
 */
function getPeriodSubscriptions(db: Database.Database, period: string): SubAgg[] {
    return db
        .prepare(
            `SELECT developer_id, tool, monthly_cost AS amount, billing_model
             FROM (
                 SELECT developer_id, tool, monthly_cost, billing_model,
                        ROW_NUMBER() OVER (
                            PARTITION BY developer_id, tool
                            -- Latest-assigned seat = plan in effect at period end.
                            -- Tie-break deterministically (id is a random UUID, not
                            -- a sequence): prefer the still-active seat, then a
                            -- stable id order.
                            ORDER BY seat_assigned_at DESC,
                                     (seat_revoked_at IS NULL) DESC,
                                     id DESC
                        ) AS rn
                 FROM subscriptions
                 WHERE (seat_assigned_at IS NULL OR substr(seat_assigned_at, 1, 7) <= ?)
                   AND (seat_revoked_at IS NULL OR substr(seat_revoked_at, 1, 7) >= ?)
             )
             WHERE rn = 1`,
        )
        .all(period, period) as SubAgg[];
}

/**
 * True when an open or ignored result already exists for this exact condition.
 * Open prevents duplicating an unresolved finding on re-run; ignored keeps a
 * deliberately-suppressed condition suppressed. A previously *resolved*
 * condition that recurs is allowed to re-open, since the underlying problem came
 * back. NULL-safe on developer_id/tool via `IS`.
 *
 * A cost_discrepancy whose cost could not be verified (details.cost_unknown) is
 * a DIFFERENT condition from one with a real computed difference, so the
 * cost_unknown flag is part of the identity. Otherwise ignoring a "cost unknown"
 * result would later suppress a genuine over/under-charge once the missing cost
 * is filled in and the amounts actually diverge.
 */
function conditionAlreadyTracked(
    db: Database.Database,
    period: string,
    type: ReconciliationResultType,
    developerId: string | null,
    tool: string | null,
    costUnknown: boolean,
): boolean {
    const row = db
        .prepare(
            `SELECT 1 FROM reconciliation_results
             WHERE period = ? AND result_type = ?
               AND developer_id IS ? AND tool IS ?
               AND COALESCE(json_extract(details, '$.cost_unknown'), 0) = ?
               AND status IN ('open', 'ignored')
             LIMIT 1`,
        )
        .get(period, type, developerId, tool, costUnknown ? 1 : 0);
    return row !== undefined;
}

interface NewResult {
    result_type: ReconciliationResultType;
    developer_id: string | null;
    tool: string | null;
    expense_amount: number | null;
    registry_amount: number | null;
    // When true, this is a cost_discrepancy that could not be verified because
    // one side had no cost — kept distinct in the idempotency identity (and
    // recorded as details.cost_unknown) so it never masks a real discrepancy.
    cost_unknown?: boolean;
    details: Record<string, unknown>;
}

function insertResult(
    db: Database.Database,
    runAt: string,
    period: string,
    r: NewResult,
): void {
    db.prepare(
        `INSERT INTO reconciliation_results
           (id, run_at, period, result_type, developer_id, tool,
            expense_amount, registry_amount, details, status, resolution, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL)`,
    ).run(
        randomUUID(),
        runAt,
        period,
        r.result_type,
        r.developer_id,
        r.tool,
        r.expense_amount,
        r.registry_amount,
        JSON.stringify(r.details),
    );
}

/**
 * Reconcile one period (YYYY-MM): compare aggregated expense charges against the
 * active subscription registry and record each mismatch as an open result. The
 * whole run is one transaction. Idempotent — a condition already open or ignored
 * is not re-inserted (see {@link conditionAlreadyTracked}).
 *
 * Throws on a malformed period so a bad CLI/API argument fails loudly rather
 * than silently reconciling nothing.
 */
export function reconcilePeriod(
    db: Database.Database,
    period: string,
    options: ReconcileOptions = {},
): ReconcileSummary {
    if (!PERIOD_RE.test(period)) {
        throw new Error(`Invalid period '${period}'. Expected YYYY-MM.`);
    }
    const tolerance = options.tolerance ?? DEFAULT_COST_TOLERANCE;
    if (!Number.isFinite(tolerance) || tolerance < 0) {
        throw new Error('tolerance must be a non-negative number.');
    }
    const runAt = options.runAt ?? new Date().toISOString();

    const summary: ReconcileSummary = {
        period,
        run_at: runAt,
        tolerance,
        created: 0,
        skipped: 0,
        byType: {
            expense_no_subscription: 0,
            subscription_no_expense: 0,
            cost_discrepancy: 0,
        },
    };

    return db.transaction((): ReconcileSummary => {
        const expenses = new Map<string, ExpenseAgg>();
        for (const e of getPeriodExpenses(db, period)) {
            expenses.set(key(e.developer_id, e.tool), e);
        }
        const subs = new Map<string, SubAgg>();
        for (const s of getPeriodSubscriptions(db, period)) {
            subs.set(key(s.developer_id, s.tool), s);
        }

        const emit = (r: NewResult): void => {
            if (
                conditionAlreadyTracked(
                    db,
                    period,
                    r.result_type,
                    r.developer_id,
                    r.tool,
                    r.cost_unknown ?? false,
                )
            ) {
                summary.skipped += 1;
                return;
            }
            insertResult(db, runAt, period, r);
            summary.created += 1;
            summary.byType[r.result_type] += 1;
        };

        // Every (developer, tool) seen on either side.
        const allKeys = new Set<string>([...expenses.keys(), ...subs.keys()]);

        for (const k of allKeys) {
            const exp = expenses.get(k);
            const sub = subs.get(k);

            if (exp && !sub) {
                emit({
                    result_type: 'expense_no_subscription',
                    developer_id: exp.developer_id,
                    tool: exp.tool,
                    expense_amount: exp.amount,
                    registry_amount: null,
                    details: {
                        charge_count: exp.charge_count,
                        message:
                            'Expense charge present with no active subscription registered.',
                    },
                });
                continue;
            }

            if (sub && !exp) {
                // Billing-model awareness: only flag seats expected to appear in
                // a reimbursement feed. Company-managed (and any non-reimbursed)
                // seats are not false-flagged.
                if (!EXPENSE_EXPECTED_BILLING_MODELS.has(sub.billing_model)) {
                    continue;
                }
                emit({
                    result_type: 'subscription_no_expense',
                    developer_id: sub.developer_id,
                    tool: sub.tool,
                    expense_amount: null,
                    registry_amount: sub.amount,
                    details: {
                        billing_model: sub.billing_model,
                        message:
                            'Active subscription with no matching expense charge in this period.',
                    },
                });
                continue;
            }

            // Both present. Compare costs when both are known; flag beyond
            // tolerance. When exactly one side has a known cost the other is
            // unknown, so it can't be validated either way — surface that as a
            // cost_discrepancy with cost_unknown rather than silently dropping it
            // (a registered seat with no cost, or a charge with no resolvable
            // amount, would otherwise produce no result of any type).
            if (exp && sub) {
                const expCost = exp.amount;
                const subCost = sub.amount;
                if (expCost != null && subCost != null) {
                    const diff = Math.abs(expCost - subCost);
                    if (diff > tolerance) {
                        emit({
                            result_type: 'cost_discrepancy',
                            developer_id: exp.developer_id,
                            tool: exp.tool,
                            expense_amount: expCost,
                            registry_amount: subCost,
                            details: {
                                difference: Number(diff.toFixed(2)),
                                tolerance,
                                billing_model: sub.billing_model,
                                message: `Expense ($${expCost.toFixed(2)}) and registry ($${subCost.toFixed(2)}) differ beyond tolerance.`,
                            },
                        });
                    }
                } else if (expCost != null || subCost != null) {
                    // Exactly one side known — the other is an unverifiable cost.
                    emit({
                        result_type: 'cost_discrepancy',
                        developer_id: exp.developer_id,
                        tool: exp.tool,
                        expense_amount: expCost,
                        registry_amount: subCost,
                        cost_unknown: true,
                        details: {
                            cost_unknown: true,
                            billing_model: sub.billing_model,
                            message:
                                'Expense and subscription both present but one has no cost — unable to verify.',
                        },
                    });
                }
                // Neither side has a cost: nothing comparable, nothing to flag.
            }
        }

        return summary;
    })();
}

/**
 * The most recent period present in the expense ledger, or null when there are
 * no periodized charges. Lets the CLI default to "reconcile the latest data we
 * have" when no --period is given.
 */
export function latestExpensePeriod(db: Database.Database): string | null {
    const row = db
        .prepare(
            `SELECT period FROM expense_charges
             WHERE period IS NOT NULL AND period != ''
             ORDER BY period DESC LIMIT 1`,
        )
        .get() as {period: string} | undefined;
    return row?.period ?? null;
}

export interface ListReconciliationOptions {
    /** Filter by status. Defaults to 'open'. Pass 'all' for every status. */
    status?: ReconciliationStatus | 'all';
    /** Filter by reconciled period (YYYY-MM). */
    period?: string;
}

/**
 * Reconciliation results joined with developer name/email/team, newest run
 * first. Defaults to open results (the admin action queue); pass status:'all' or
 * a specific status to widen.
 */
export function listReconciliationResults(
    db: Database.Database,
    options: ListReconciliationOptions = {},
): ReconciliationResultWithDeveloper[] {
    const status = options.status ?? 'open';
    const clauses: string[] = [];
    const params: string[] = [];
    if (status !== 'all') {
        clauses.push('r.status = ?');
        params.push(status);
    }
    if (options.period) {
        clauses.push('r.period = ?');
        params.push(options.period);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return db
        .prepare(
            `SELECT r.*, d.name AS developer_name, d.email AS developer_email, d.team
             FROM reconciliation_results r
             LEFT JOIN developers d ON r.developer_id = d.id
             ${where}
             ORDER BY r.run_at DESC, r.id`,
        )
        .all(...params) as ReconciliationResultWithDeveloper[];
}

export function getReconciliationResultById(
    db: Database.Database,
    id: string,
): ReconciliationResult | null {
    const row = db
        .prepare('SELECT * FROM reconciliation_results WHERE id = ?')
        .get(id) as ReconciliationResult | undefined;
    return row ?? null;
}

/**
 * Move an open result to a terminal status. `resolved` records the admin's note
 * (required — "resolve records a note"); `ignored` suppresses the condition so a
 * re-run won't re-raise it (note optional). Throws when the id is unknown or the
 * result is no longer open, so a double-action fails loudly.
 */
function setTerminalStatus(
    db: Database.Database,
    id: string,
    status: 'resolved' | 'ignored',
    resolution: string | null,
): ReconciliationResult {
    return db.transaction((): ReconciliationResult => {
        const existing = getReconciliationResultById(db, id);
        if (!existing) {
            throw new Error(`No reconciliation result found with id '${id}'.`);
        }
        if (existing.status !== 'open') {
            throw new Error(`Reconciliation result '${id}' is already ${existing.status}.`);
        }
        const now = new Date().toISOString();
        db.prepare(
            `UPDATE reconciliation_results
             SET status = ?, resolution = ?, resolved_at = ?
             WHERE id = ?`,
        ).run(status, resolution, now, id);
        return {...existing, status, resolution, resolved_at: now};
    })();
}

/** Resolve an open result with a (required) note. */
export function resolveReconciliationResult(
    db: Database.Database,
    id: string,
    resolution: string,
): ReconciliationResult {
    const note = resolution.trim();
    if (!note) {
        throw new Error('A resolution note is required to resolve a result.');
    }
    return setTerminalStatus(db, id, 'resolved', note);
}

/** Ignore an open result (suppress it). An optional note explains why. */
export function ignoreReconciliationResult(
    db: Database.Database,
    id: string,
    note?: string,
): ReconciliationResult {
    const trimmed = note?.trim();
    return setTerminalStatus(db, id, 'ignored', trimmed ? trimmed : null);
}
