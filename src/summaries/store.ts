/**
 * Summary persistence (Task 3.9 / #78).
 *
 * Owns the read/write surface over the `summaries` table and the input-hash
 * helper the generator and staleness check share. A summary's identity is its
 * (scope, scope_name, period_type, period_value) — encoded into a deterministic
 * primary key so generate and regenerate target the same row (upsert by id) and
 * the staleness check can look a summary up by its coordinates.
 *
 * The table predates Phase 3 and still carries the V1 `data_hash NOT NULL`
 * column; the generator writes the same payload hash into both data_hash and the
 * new input_hash, keeping the legacy column populated while input_hash becomes the
 * column the staleness comparison reads.
 */

import {createHash} from 'crypto';
import type Database from 'better-sqlite3';
import type {SummaryInputPayload} from './input-builder';
import type {SummaryLevel} from './model-client';
import type {SummaryTarget} from './target';

/** A stored summary row, typed to the columns the summary layer reads/writes. */
export interface SummaryRecord {
    id: string;
    scope: SummaryScopeType;
    scope_name: string;
    period_type: SummaryLevel;
    period_value: string;
    summary_text: string;
    model_used: string;
    input_hash: string;
    generated_at: string;
    regenerated_count: number;
    is_stale: 0 | 1;
}

type SummaryScopeType = 'team' | 'org';

/**
 * The deterministic primary key for a target. Stable across regeneration so the
 * upsert overwrites in place, and reproducible from a target so the staleness
 * check can find the row without a secondary lookup.
 */
export function summaryId(target: SummaryTarget): string {
    return `summary:${target.scope.type}:${target.scope.name}:${target.level}:${target.period}`;
}

/**
 * SHA-256 of the canonical JSON of the numbers-only payload. Deterministic: the
 * payload is built field-by-field in a fixed order, so equal metrics hash equal
 * and a single changed number changes the hash — which is exactly what the
 * staleness check keys on.
 */
export function hashInput(payload: SummaryInputPayload): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

interface SummaryRow {
    id: string;
    scope: string;
    scope_name: string;
    period_type: string;
    period_value: string;
    summary_text: string;
    model_used: string;
    input_hash: string | null;
    generated_at: string;
    regenerated_count: number | null;
    is_stale: number | null;
}

function toRecord(row: SummaryRow): SummaryRecord {
    return {
        id: row.id,
        scope: row.scope as SummaryScopeType,
        scope_name: row.scope_name,
        period_type: row.period_type as SummaryLevel,
        period_value: row.period_value,
        summary_text: row.summary_text,
        model_used: row.model_used,
        input_hash: row.input_hash ?? '',
        generated_at: row.generated_at,
        regenerated_count: row.regenerated_count ?? 0,
        is_stale: row.is_stale === 1 ? 1 : 0,
    };
}

/** Look a summary up by its primary key, or null when none exists. */
export function getSummaryById(db: Database.Database, id: string): SummaryRecord | null {
    const row = db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow | undefined;
    return row ? toRecord(row) : null;
}

/** Look a summary up by its target coordinates. */
export function getSummaryByTarget(
    db: Database.Database,
    target: SummaryTarget,
): SummaryRecord | null {
    return getSummaryById(db, summaryId(target));
}

/** Every summary stored for a (period_type, period_value), most recent first. */
export function listSummariesForPeriod(
    db: Database.Database,
    periodType: SummaryLevel,
    periodValue: string,
): SummaryRecord[] {
    const rows = db
        .prepare(
            `SELECT * FROM summaries WHERE period_type = ? AND period_value = ?
             ORDER BY generated_at DESC`,
        )
        .all(periodType, periodValue) as SummaryRow[];
    return rows.map(toRecord);
}

/**
 * Insert or overwrite a summary by id. The same hash is written to both
 * input_hash and the legacy NOT NULL data_hash, and is_stale is reset to 0 — a
 * freshly written summary is, by definition, current with its input.
 */
export function upsertSummary(db: Database.Database, record: SummaryRecord): void {
    db.prepare(
        `INSERT INTO summaries (
            id, scope, scope_name, period_type, period_value, summary_text,
            model_used, data_hash, input_hash, generated_at, regenerated_count, is_stale
        ) VALUES (
            @id, @scope, @scope_name, @period_type, @period_value, @summary_text,
            @model_used, @input_hash, @input_hash, @generated_at, @regenerated_count, 0
        )
        ON CONFLICT(id) DO UPDATE SET
            scope = excluded.scope,
            scope_name = excluded.scope_name,
            period_type = excluded.period_type,
            period_value = excluded.period_value,
            summary_text = excluded.summary_text,
            model_used = excluded.model_used,
            data_hash = excluded.data_hash,
            input_hash = excluded.input_hash,
            generated_at = excluded.generated_at,
            regenerated_count = excluded.regenerated_count,
            is_stale = 0`,
    ).run({
        id: record.id,
        scope: record.scope,
        scope_name: record.scope_name,
        period_type: record.period_type,
        period_value: record.period_value,
        summary_text: record.summary_text,
        model_used: record.model_used,
        input_hash: record.input_hash,
        generated_at: record.generated_at,
        regenerated_count: record.regenerated_count,
    });
}

/** Set (or clear) a summary's stale flag by id. Returns whether a row was updated. */
export function setSummaryStale(db: Database.Database, id: string, stale: boolean): boolean {
    const result = db
        .prepare('UPDATE summaries SET is_stale = ? WHERE id = ?')
        .run(stale ? 1 : 0, id);
    return result.changes > 0;
}
