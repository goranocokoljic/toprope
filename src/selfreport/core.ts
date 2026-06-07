import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';

// Tools a developer can self-report. Mirrors the connector tool names plus
// integration-less tools (chatgpt) and an "other" escape hatch.
export const SELF_REPORT_TOOLS = [
    'copilot',
    'cursor',
    'claude_code',
    'windsurf',
    'chatgpt',
    'other',
] as const;
export type SelfReportTool = (typeof SELF_REPORT_TOOLS)[number];

// Where the report came from. The CLI (Task 4.1) sets "cli"; the Slack bot
// (Task 4.2) reuses this same core with "slack".
export const SELF_REPORT_INTERFACES = ['cli', 'slack'] as const;
export type SelfReportInterface = (typeof SELF_REPORT_INTERFACES)[number];

const SELF_REPORT_SOURCE = 'self_report';
const SELF_REPORT_QUALITY = 'medium';

export interface SelfReportInput {
    // The authenticated developer this report belongs to. The report is ALWAYS
    // attributed to this id — there is no separate "target" parameter, so a
    // caller can only ever log usage for themselves (enforced at the CLI/Slack
    // boundary, which derives this id from the caller's own identity).
    developerId: string;
    tool: string;
    // Usage date (YYYY-MM-DD). Defaults to today (UTC) when omitted.
    date?: string;
    // Optional rough effort in minutes. Stored only on the raw self_report; never
    // fabricated into a snapshot interaction_count.
    minutes?: number | null;
    // Optional private free text. Stored verbatim on the raw self_report, shown
    // only in the developer's own view, and NEVER copied into tool_snapshots or
    // any model input / manager-facing view.
    taskDescriptor?: string | null;
    sourceInterface: SelfReportInterface;
}

export interface SelfReportRecord {
    id: string;
    developer_id: string;
    date: string;
    tool: string;
    minutes: number | null;
    task_descriptor: string | null;
    source_interface: string;
    created_at: string;
}

// Outcome of aggregating the report into tool_snapshots:
// - created            : no snapshot existed → a self_report snapshot was written
// - already_self_report: a self_report snapshot already existed → kept active
// - api_wins           : an API snapshot already existed → left untouched
export type SnapshotOutcome = 'created' | 'already_self_report' | 'api_wins';

export interface CreateSelfReportResult {
    report: SelfReportRecord;
    snapshot: SnapshotOutcome;
}

// Thrown for any caller/input error (unknown developer, bad tool/date/minutes).
// The CLI maps this to a clean error message + non-zero exit.
export class SelfReportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SelfReportError';
    }
}

function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    // Reject impossible calendar dates (e.g. 2024-13-40) that pass the regex.
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Normalize optional minutes into a positive integer or null. A zero/negative or
// non-finite value is rejected — "I used it for 0 minutes" is not a usage report.
function normalizeMinutes(minutes: number | null | undefined): number | null {
    if (minutes === undefined || minutes === null) return null;
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes <= 0) {
        throw new SelfReportError('minutes must be a positive integer when provided');
    }
    return minutes;
}

function normalizeTaskDescriptor(task: string | null | undefined): string | null {
    if (task === undefined || task === null) return null;
    const trimmed = task.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function developerExists(db: Database.Database, developerId: string): boolean {
    const row = db
        .prepare('SELECT 1 AS ok FROM developers WHERE id = ?')
        .get(developerId) as {ok: number} | undefined;
    return row !== undefined;
}

/**
 * Create a self-report for the given (authenticated) developer and aggregate it
 * into tool_snapshots, respecting the API-wins rule.
 *
 * The raw entry is always persisted to self_reports (for the record, including
 * the private task_descriptor). The snapshot side only ever creates or keeps a
 * `self_report` snapshot active: an existing API snapshot for the same
 * developer/date/tool is never overwritten.
 *
 * Throws SelfReportError for unknown developers or invalid tool/date/minutes.
 */
export function createSelfReport(
    db: Database.Database,
    input: SelfReportInput,
): CreateSelfReportResult {
    if (!SELF_REPORT_TOOLS.includes(input.tool as SelfReportTool)) {
        throw new SelfReportError(
            `Unknown tool '${input.tool}'. Expected one of: ${SELF_REPORT_TOOLS.join(', ')}.`,
        );
    }
    if (!SELF_REPORT_INTERFACES.includes(input.sourceInterface)) {
        throw new SelfReportError(
            `Unknown source interface '${input.sourceInterface}'. Expected one of: ${SELF_REPORT_INTERFACES.join(', ')}.`,
        );
    }

    const date = input.date ?? todayUtc();
    if (!isIsoDate(date)) {
        throw new SelfReportError(`Invalid date '${date}'. Expected YYYY-MM-DD.`);
    }

    const minutes = normalizeMinutes(input.minutes);
    const taskDescriptor = normalizeTaskDescriptor(input.taskDescriptor);

    // Developer scoping: the report can only reference a real developer. The id
    // is the authenticated caller's own (the boundary never accepts an arbitrary
    // target), so this both validates and enforces self-only logging.
    if (!developerExists(db, input.developerId)) {
        throw new SelfReportError(`Unknown developer '${input.developerId}'.`);
    }

    const report: SelfReportRecord = {
        id: randomUUID(),
        developer_id: input.developerId,
        date,
        tool: input.tool,
        minutes,
        task_descriptor: taskDescriptor,
        source_interface: input.sourceInterface,
        created_at: new Date().toISOString(),
    };

    const tx = db.transaction((): SnapshotOutcome => {
        db.prepare(
            `INSERT INTO self_reports
             (id, developer_id, date, tool, minutes, task_descriptor, source_interface, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            report.id,
            report.developer_id,
            report.date,
            report.tool,
            report.minutes,
            report.task_descriptor,
            report.source_interface,
            report.created_at,
        );

        return aggregateIntoSnapshot(db, report.developer_id, report.date, report.tool);
    });

    const snapshot = tx();
    return {report, snapshot};
}

/**
 * Aggregate a self-report into tool_snapshots under the API-wins rule. Returns
 * the outcome. Must run inside the createSelfReport transaction.
 *
 * API wins in BOTH orderings:
 *  - self-report after API: the INSERT below hits ON CONFLICT and does nothing,
 *    so an existing API (or prior self-report) snapshot is left untouched.
 *  - API after self-report: the connector upserts overwrite a self_report-sourced
 *    snapshot with their measured data (DO UPDATE ... WHERE data_source =
 *    'self_report'), so a self-report that landed first is replaced, not frozen.
 *
 * Using INSERT ... ON CONFLICT DO NOTHING (rather than SELECT-then-INSERT) keeps
 * this atomic and idempotent even against a concurrent writer on another
 * connection — there is no window for a UNIQUE violation.
 */
function aggregateIntoSnapshot(
    db: Database.Database,
    developerId: string,
    date: string,
    tool: string,
): SnapshotOutcome {
    // Append a self-reported snapshot only when none exists yet. is_active = 1 for
    // the day; interaction_count / features_used stay null (we don't fabricate
    // measured counts from a time estimate). task_descriptor is deliberately NOT
    // written here — it stays private on the raw self_report row.
    const result = db
        .prepare(
            `INSERT INTO tool_snapshots
             (id, developer_id, date, tool, data_source, data_quality, is_active,
              interaction_count, acceptance_count, acceptance_rate, features_used,
              models_used, estimated_cost, tokens_consumed, raw_data)
             VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
             ON CONFLICT(developer_id, date, tool) DO NOTHING`,
        )
        .run(randomUUID(), developerId, date, tool, SELF_REPORT_SOURCE, SELF_REPORT_QUALITY);

    if (result.changes > 0) return 'created';

    // A snapshot already existed — classify the outcome for the caller's message.
    const existing = db
        .prepare(
            'SELECT data_source FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?',
        )
        .get(developerId, date, tool) as {data_source: string} | undefined;
    return existing?.data_source === SELF_REPORT_SOURCE ? 'already_self_report' : 'api_wins';
}

export interface GetSelfReportsOptions {
    tool?: string;
    // Inclusive date bounds (YYYY-MM-DD).
    from?: string;
    to?: string;
    limit?: number;
}

/**
 * Read a developer's own self-reports, including the private task_descriptor.
 * Scoped strictly to the given developer — this is the only accessor that
 * exposes task_descriptor, and it is intended for the developer's own view.
 * There is no manager-facing or model-facing accessor for task_descriptor.
 */
export function getSelfReportsForDeveloper(
    db: Database.Database,
    developerId: string,
    options: GetSelfReportsOptions = {},
): SelfReportRecord[] {
    const clauses = ['developer_id = ?'];
    const params: unknown[] = [developerId];

    if (options.tool !== undefined) {
        clauses.push('tool = ?');
        params.push(options.tool);
    }
    if (options.from !== undefined) {
        clauses.push('date >= ?');
        params.push(options.from);
    }
    if (options.to !== undefined) {
        clauses.push('date <= ?');
        params.push(options.to);
    }

    let sql = `SELECT id, developer_id, date, tool, minutes, task_descriptor, source_interface, created_at
               FROM self_reports
               WHERE ${clauses.join(' AND ')}
               ORDER BY date DESC, created_at DESC`;
    if (options.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
        sql += ' LIMIT ?';
        params.push(options.limit);
    }

    return db.prepare(sql).all(...params) as SelfReportRecord[];
}
