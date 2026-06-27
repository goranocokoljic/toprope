/**
 * Persistence for session retrospectives (Task 5.7 / #128).
 *
 * The store holds ONLY the analysis OUTPUT — the narrative, structured
 * highlights, the model name, and where analysis ran. It never sees the
 * developer's key and never the decrypted prompts (those live transiently in the
 * generator and are discarded). Every read/write is scoped to a developer_id the
 * route derives from the session, never from request input, so one developer can
 * never reach another's retrospective and there is no manager/aggregate path here.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {decodeAnalysisLocation, type Retrospective, type RetrospectiveHighlights, type RetrospectiveOutput} from './types';

interface RetrospectiveRow {
    id: string;
    developer_id: string;
    session_id: string;
    generated_at: string;
    analysis_model: string;
    analysis_location: string;
    retrospective_text: string;
    highlights: string | null;
    analyzed_capture_count: number;
    created_at: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

/** Parse the highlights JSON back into the structured shape, or null on absence/corruption. */
function parseHighlights(raw: string | null): RetrospectiveHighlights | null {
    if (raw === null) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            const worked = Array.isArray(obj.worked) ? obj.worked.filter((v): v is string => typeof v === 'string') : [];
            const improve = Array.isArray(obj.improve) ? obj.improve.filter((v): v is string => typeof v === 'string') : [];
            return {worked, improve};
        }
    } catch {
        console.warn('[retrospective] unparseable highlights JSON; treating as none');
    }
    return null;
}

function rowToRetrospective(row: RetrospectiveRow): Retrospective {
    return {
        id: row.id,
        developerId: row.developer_id,
        sessionId: row.session_id,
        generatedAt: row.generated_at,
        analysisModel: row.analysis_model,
        analysisLocation: decodeAnalysisLocation(row.analysis_location, 'retrospective'),
        retrospectiveText: row.retrospective_text,
        highlights: parseHighlights(row.highlights),
        analyzedCaptureCount: row.analyzed_capture_count,
        createdAt: row.created_at,
    };
}

/** Persist one retrospective (the analysis output) and return it with server-assigned id/timestamp. */
export function insertRetrospective(db: Database.Database, output: RetrospectiveOutput): Retrospective {
    const id = randomUUID();
    const createdAt = nowIso();
    const highlightsJson = output.highlights ? JSON.stringify(output.highlights) : null;
    db.prepare(
        `INSERT INTO retrospectives
         (id, developer_id, session_id, generated_at, analysis_model, analysis_location, retrospective_text, highlights, analyzed_capture_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        output.developerId,
        output.sessionId,
        output.generatedAt,
        output.analysisModel,
        output.analysisLocation,
        output.retrospectiveText,
        highlightsJson,
        output.analyzedCaptureCount,
        createdAt,
    );
    return {
        id,
        developerId: output.developerId,
        sessionId: output.sessionId,
        generatedAt: output.generatedAt,
        analysisModel: output.analysisModel,
        analysisLocation: output.analysisLocation,
        retrospectiveText: output.retrospectiveText,
        highlights: output.highlights,
        analyzedCaptureCount: output.analyzedCaptureCount,
        createdAt,
    };
}

/** Every retrospective owned by a developer, newest first. */
export function listRetrospectivesForDeveloper(db: Database.Database, developerId: string): Retrospective[] {
    const rows = db
        .prepare(
            `SELECT * FROM retrospectives
             WHERE developer_id = ?
             ORDER BY generated_at DESC, created_at DESC`,
        )
        .all(developerId) as RetrospectiveRow[];
    return rows.map(rowToRetrospective);
}

/**
 * One retrospective, scoped to the owner. The developer_id is part of the WHERE
 * clause (not just the id) so a guessed/leaked id belonging to another developer
 * returns undefined rather than their private narrative.
 */
export function getRetrospectiveForDeveloper(
    db: Database.Database,
    developerId: string,
    retrospectiveId: string,
): Retrospective | undefined {
    const row = db
        .prepare('SELECT * FROM retrospectives WHERE id = ? AND developer_id = ?')
        .get(retrospectiveId, developerId) as RetrospectiveRow | undefined;
    return row ? rowToRetrospective(row) : undefined;
}

/**
 * Delete one retrospective, scoped to the owner. Returns true when a row was
 * removed. Scoping the DELETE on developer_id means one developer can never delete
 * another's retrospective even with a valid id.
 */
export function deleteRetrospectiveForDeveloper(
    db: Database.Database,
    developerId: string,
    retrospectiveId: string,
): boolean {
    const result = db
        .prepare('DELETE FROM retrospectives WHERE id = ? AND developer_id = ?')
        .run(retrospectiveId, developerId);
    return result.changes > 0;
}
