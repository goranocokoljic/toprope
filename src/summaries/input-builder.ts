/**
 * Summary input builder (Task 3.7 / #76).
 *
 * Turns an already-computed aggregate (plus the prior period for deltas and the
 * org benchmark for context) into a compact, NUMBERS-ONLY payload for the model.
 *
 * Privacy is the whole point of this module. The model that writes the summaries
 * must never see code, commit messages, or any free text from repositories.
 * There are two layers of defence:
 *
 *   1. By construction — the input type (`AggregateMetrics`) carries only numeric
 *      metrics, so there is no field through which repo free text could enter the
 *      payload. This is the primary guarantee.
 *   2. A runtime allowlist gate (`assertNumbersOnly`) that verifies every string
 *      in the assembled payload belongs to the controlled set: the level / scope
 *      type / data-quality / maturity-basis enums, the period key + ISO dates (a
 *      restricted character class), one of the generated data_basis sentences,
 *      and the scope name (the one operator/registry-supplied label, which is
 *      length- and character-restricted — never repo free text). `buildSummaryInput`
 *      runs this gate on its own output, so the guarantee is enforced at
 *      construction, not left for a future caller to remember.
 *
 * The gate is an allowlist, not a code-token blocklist: it asserts what each
 * string MUST be rather than guessing at what it must not contain, so a future
 * widening of the payload that introduced a free-text field would fail the gate
 * rather than slip through.
 *
 * The `data_basis` field is the bridge to Task 3.8's tier-aware prompts: it
 * states, in words, what the numbers are derived from (e.g. "git analysis +
 * expense data; no direct tool usage") so the prompt can carry that into the
 * narrative and never imply measured usage the data doesn't contain.
 */

import type {DataQuality} from '../aggregation/compute';
import type {MaturityBasis} from '../aggregation/team-period';
import {pctChange, countPctChange, pointDelta} from '../aggregation/deltas';
import type {SummaryLevel} from './model-client';

/**
 * The numeric metrics a summary is built from — a numbers-only subset shared by
 * the team/org-level rollups (weekly is team-scoped for the manager audience;
 * monthly+ roll up to department/org). Deliberately contains NO free-text fields
 * so nothing from a repo can ride along into the payload.
 */
export interface AggregateMetrics {
    /** Developers in scope for the period. */
    developer_count: number;
    /** Of those, the ones with any activity (git or tool) during the period. */
    active_developer_count: number;
    total_commits: number;
    total_prs_merged: number;
    /** Average code churn rate (0–1); null when no git churn data. */
    avg_code_churn: number | null;
    /** Estimated AI signature score; null when not computed. */
    avg_ai_signature_score: number | null;
    /** Subscription spend in scope for the period. */
    subscription_cost: number;
    /** Cost per merged PR; null when no PRs merged. */
    cost_per_pr: number | null;
    /** AI maturity score 0–100; null when no developers / not computed. */
    ai_maturity_score: number | null;
    /** What the maturity score is derived from. */
    ai_maturity_basis: MaturityBasis;
    /** Data quality tier for the period (high = API, medium = git, low = expense only). */
    data_quality: DataQuality;
}

/** Scope a summary covers — a single team or the whole org. */
export interface SummaryScope {
    type: 'team' | 'org';
    /** Team name (from the registry) or 'org'. A label, never repo free text. */
    name: string;
}

/** Org-wide benchmark context for the same period (Phase 3: internal org average). */
export interface SummaryBenchmark {
    /** Org-average cost per merged PR across teams. Null when no org-wide PRs. */
    org_avg_cost_per_pr: number | null;
    /** Org-average maturity score across teams. Null when not available. */
    org_avg_maturity_score: number | null;
}

/** Period-over-period changes carried into the payload (null = no prior period). */
export interface SummaryDeltas {
    commit_velocity_delta_pct: number | null;
    prs_merged_delta_pct: number | null;
    churn_rate_delta: number | null;
    ai_signature_delta: number | null;
    cost_per_pr_delta_pct: number | null;
    maturity_score_delta: number | null;
}

/** The compact, numbers-only payload handed to the prompt/model. */
export interface SummaryInputPayload {
    period: {
        level: SummaryLevel;
        /** Period key, e.g. '2026-W21' / '2026-05' / '2026-Q2' / '2026'. */
        label: string;
        /** Inclusive ISO date range of the period. */
        start: string;
        end: string;
    };
    scope: SummaryScope & {
        developer_count: number;
        active_developer_count: number;
    };
    metrics: {
        total_commits: number;
        total_prs_merged: number;
        avg_code_churn: number | null;
        avg_ai_signature_score: number | null;
        subscription_cost: number;
        cost_per_pr: number | null;
        ai_maturity_score: number | null;
        ai_maturity_basis: MaturityBasis;
    };
    deltas: SummaryDeltas;
    benchmark: SummaryBenchmark;
    /** Whether this is the first period (no prior data → no deltas). */
    is_first_period: boolean;
    /** Human-readable statement of what the numbers are derived from (the tier). */
    data_basis: string;
    /** The data-quality tier this period was computed at. */
    data_quality: DataQuality;
}

/**
 * Map the maturity basis (which tracks how much real usage data backs the
 * numbers) to the sentence the prompt carries into the narrative. git_estimate
 * is the launch state — everything is git + expense derived, no direct tool
 * usage — and the wording makes that explicit so the model can't drift into
 * describing measured usage that doesn't exist.
 */
export function deriveDataBasis(basis: MaturityBasis): string {
    switch (basis) {
        case 'git_estimate':
            return 'git analysis + expense data; no direct tool usage';
        case 'mixed':
            return 'git analysis + expense data + partial direct tool usage';
        case 'measured':
            return 'direct tool usage + git analysis + expense data';
    }
}

/**
 * Compute the deltas the payload carries from the current and prior metrics.
 * Reuses the delta-layer helpers so the "+18% vs last week" numbers match the
 * stored aggregate deltas exactly. `prior === null` → all deltas null (first
 * period), never a fabricated 0%.
 */
function computeDeltas(current: AggregateMetrics, prior: AggregateMetrics | null): SummaryDeltas {
    if (prior === null) {
        return {
            commit_velocity_delta_pct: null,
            prs_merged_delta_pct: null,
            churn_rate_delta: null,
            ai_signature_delta: null,
            cost_per_pr_delta_pct: null,
            maturity_score_delta: null,
        };
    }
    return {
        commit_velocity_delta_pct: countPctChange(current.total_commits, prior.total_commits, 1),
        prs_merged_delta_pct: countPctChange(current.total_prs_merged, prior.total_prs_merged, 1),
        churn_rate_delta: pointDelta(current.avg_code_churn, prior.avg_code_churn),
        ai_signature_delta: pointDelta(current.avg_ai_signature_score, prior.avg_ai_signature_score),
        cost_per_pr_delta_pct: pctChange(current.cost_per_pr, prior.cost_per_pr, 0.01),
        maturity_score_delta: pointDelta(current.ai_maturity_score, prior.ai_maturity_score),
    };
}

/**
 * Assemble the numbers-only payload for one summary. Pure: no DB, no I/O. The
 * caller (the generator, Task 3.9) supplies the already-computed current
 * metrics, the prior period's metrics for deltas (or null for the first
 * period), and the org benchmark context.
 */
export function buildSummaryInput(params: {
    level: SummaryLevel;
    periodLabel: string;
    start: string;
    end: string;
    scope: SummaryScope;
    current: AggregateMetrics;
    prior: AggregateMetrics | null;
    benchmark?: SummaryBenchmark;
}): SummaryInputPayload {
    const {level, periodLabel, start, end, scope, current, prior} = params;
    const benchmark: SummaryBenchmark = params.benchmark ?? {
        org_avg_cost_per_pr: null,
        org_avg_maturity_score: null,
    };

    const payload: SummaryInputPayload = {
        period: {level, label: periodLabel, start, end},
        scope: {
            type: scope.type,
            name: scope.name,
            developer_count: current.developer_count,
            active_developer_count: current.active_developer_count,
        },
        metrics: {
            total_commits: current.total_commits,
            total_prs_merged: current.total_prs_merged,
            avg_code_churn: current.avg_code_churn,
            avg_ai_signature_score: current.avg_ai_signature_score,
            subscription_cost: current.subscription_cost,
            cost_per_pr: current.cost_per_pr,
            ai_maturity_score: current.ai_maturity_score,
            ai_maturity_basis: current.ai_maturity_basis,
        },
        deltas: computeDeltas(current, prior),
        benchmark,
        is_first_period: prior === null,
        data_basis: deriveDataBasis(current.ai_maturity_basis),
        data_quality: current.data_quality,
    };
    // Enforce the privacy allowlist on our own output, so the numbers-only
    // guarantee holds at construction time rather than depending on a downstream
    // caller remembering to check.
    assertNumbersOnly(payload);
    return payload;
}

/**
 * Render the payload as the compact, human/model-readable input block (the shape
 * shown in the design doc §5.2). Numbers-only by construction — it reads fields
 * off the typed payload, so there is no path for repo free text to appear here.
 * This is the string Task 3.8's prompt templates embed.
 */
export function formatSummaryInput(payload: SummaryInputPayload): string {
    const {period, scope, metrics, deltas} = payload;
    const lines: string[] = [
        `Period: ${period.label} (${period.start}–${period.end}, ${period.level})`,
        `Scope: ${scope.name} (${scope.type})`,
        `Developers: ${scope.developer_count} (${scope.active_developer_count} active)`,
        `Total commits: ${metrics.total_commits}${fmtPct(deltas.commit_velocity_delta_pct)}`,
        `PRs merged: ${metrics.total_prs_merged}${fmtPct(deltas.prs_merged_delta_pct)}`,
        `Avg code churn: ${fmtRate(metrics.avg_code_churn)}${fmtPoint(deltas.churn_rate_delta)}`,
        `Avg AI signature (est.): ${fmtNum(metrics.avg_ai_signature_score)}${fmtPoint(deltas.ai_signature_delta)}`,
        `Subscription cost: ${fmtMoney(metrics.subscription_cost)}`,
        `Cost per PR: ${fmtMoney(metrics.cost_per_pr)}${fmtPct(deltas.cost_per_pr_delta_pct)}`,
        `AI maturity score: ${fmtNum(metrics.ai_maturity_score)}${fmtPoint(deltas.maturity_score_delta)} (${metrics.ai_maturity_basis})`,
        `Org-average cost per PR: ${fmtMoney(payload.benchmark.org_avg_cost_per_pr)}`,
        `Org-average maturity score: ${fmtNum(payload.benchmark.org_avg_maturity_score)}`,
        `Data basis: ${payload.data_basis}`,
    ];
    if (payload.is_first_period) {
        lines.push('Note: first period for this scope — no prior-period comparison available.');
    }
    return lines.join('\n');
}

function fmtNum(value: number | null): string {
    return value === null ? 'n/a' : String(value);
}

function fmtRate(value: number | null): string {
    return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function fmtMoney(value: number | null): string {
    return value === null ? 'n/a' : `$${value.toFixed(2)}`;
}

function fmtPct(value: number | null): string {
    if (value === null) return '';
    const sign = value >= 0 ? '+' : '';
    return ` (${sign}${value}% vs prior)`;
}

function fmtPoint(value: number | null): string {
    if (value === null) return '';
    const sign = value >= 0 ? '+' : '';
    return ` (${sign}${value} pts vs prior)`;
}

/**
 * The exact controlled strings a payload may contain: the closed enums plus the
 * generated data_basis sentences (one per maturity basis). Anything matching one
 * of these is, by definition, not repo free text.
 */
const ALLOWED_EXACT: ReadonlySet<string> = new Set<string>([
    // SummaryLevel
    'weekly',
    'monthly',
    'quarterly',
    'yearly',
    // SummaryScope.type
    'team',
    'org',
    // MaturityBasis
    'git_estimate',
    'mixed',
    'measured',
    // DataQuality
    'high',
    'medium',
    'low',
    // The generated data_basis sentences — every value deriveDataBasis can emit.
    deriveDataBasis('git_estimate'),
    deriveDataBasis('mixed'),
    deriveDataBasis('measured'),
]);

/**
 * Period keys and ISO dates: alphanumerics and dashes only (e.g. '2026-W21',
 * '2026-Q2', '2026-05', '2026', '2026-05-19'). No spaces, no punctuation that
 * could carry prose.
 */
const PERIOD_TOKEN = /^[0-9A-Za-z-]+$/;

/**
 * The scope name is the single operator/registry-supplied label (a team or org
 * name), so it cannot be an exact-match enum. It is constrained to a tight set
 * of name characters and a short length — enough for real team names, but with
 * no newlines, braces, slashes, or other markers that prose, commit messages,
 * or code carry. Repo free text cannot satisfy this.
 */
const SCOPE_NAME = /^[A-Za-z0-9 ._\-&,']{1,64}$/;

/**
 * Collect every string value reachable in the payload (recursively). Used by the
 * allowlist gate and the privacy test to inspect the payload's text content.
 */
export function collectStringValues(value: unknown, acc: string[] = []): string[] {
    if (typeof value === 'string') {
        acc.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) collectStringValues(item, acc);
    } else if (value !== null && typeof value === 'object') {
        for (const v of Object.values(value)) collectStringValues(v, acc);
    }
    return acc;
}

/**
 * Privacy gate (allowlist). Throws unless every string in the payload is one of:
 * a controlled enum value, a generated data_basis sentence, a period-key/ISO-date
 * token, or a scope name within the restricted name pattern. Because it asserts
 * what each string MUST be (not what it must not contain), a future change that
 * introduced a free-text field would fail here rather than slip through a token
 * blocklist. `buildSummaryInput` runs this on its own output, so a thrown error
 * means a programming regression that must fail loudly rather than leak data.
 */
export function assertNumbersOnly(payload: SummaryInputPayload): void {
    for (const str of collectStringValues(payload)) {
        const allowed = ALLOWED_EXACT.has(str) || PERIOD_TOKEN.test(str) || SCOPE_NAME.test(str);
        if (!allowed) {
            throw new Error(
                `Summary input payload contains a string outside the numbers-only allowlist ` +
                    `(${JSON.stringify(str.slice(0, 80))}); refusing to send to model`,
            );
        }
    }
}
