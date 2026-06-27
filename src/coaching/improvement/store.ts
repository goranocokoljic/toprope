/**
 * Persistence for private improvement reviews (Task 6.5 / #174).
 *
 * The store holds ONLY the analysis OUTPUT — the narrative, the structured
 * suggestions, the model name, and where analysis ran. It never sees the
 * developer's key and never the decrypted prompts (those live transiently in the
 * generator and are discarded). Every read/write/delete is scoped to a
 * developer_id the route derives from the SESSION, never from request input, so
 * one developer can never reach another's review.
 *
 * There is deliberately NO publish path and NO manager/aggregate path here — an
 * improvement review is private to its developer, full stop. The only functions
 * exported are owner-scoped insert/list/get/delete; nothing exposes another
 * developer's review or shares one outward.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {
    decodeAnalysisLocation,
    isImprovementCategory,
    type ImprovementReview,
    type ImprovementReviewOutput,
    type ImprovementSuggestion,
} from './types';

interface ImprovementReviewRow {
    id: string;
    developer_id: string;
    session_id: string;
    generated_at: string;
    analysis_model: string;
    analysis_location: string;
    review_text: string;
    suggestions: string;
    analyzed_capture_count: number;
    created_at: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Parse the suggestions JSON back into the structured shape. Keeps only
 * well-formed entries (a known category + a non-empty suggestion string) — the
 * write path validates before storing, so anything malformed on read is
 * corruption or a future-enum row, and a clean array is safer than asserting a
 * closed union the stored TEXT doesn't enforce.
 */
function parseSuggestions(raw: string): ImprovementSuggestion[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            console.warn('[improvement] suggestions JSON is not an array; treating as none');
            return [];
        }
        const out: ImprovementSuggestion[] = [];
        for (const entry of parsed) {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                const obj = entry as Record<string, unknown>;
                if (isImprovementCategory(obj.category) && typeof obj.suggestion === 'string' && obj.suggestion.length > 0) {
                    out.push({category: obj.category, suggestion: obj.suggestion});
                }
            }
        }
        return out;
    } catch {
        console.warn('[improvement] unparseable suggestions JSON; treating as none');
        return [];
    }
}

function rowToReview(row: ImprovementReviewRow): ImprovementReview {
    return {
        id: row.id,
        developerId: row.developer_id,
        sessionId: row.session_id,
        generatedAt: row.generated_at,
        analysisModel: row.analysis_model,
        analysisLocation: decodeAnalysisLocation(row.analysis_location, 'improvement'),
        reviewText: row.review_text,
        suggestions: parseSuggestions(row.suggestions),
        analyzedCaptureCount: row.analyzed_capture_count,
        createdAt: row.created_at,
    };
}

/**
 * Persist one improvement review (the analysis output) and return it with
 * server-assigned id/timestamp. Suggestions are validated against the category
 * allowlist at this trust boundary so a corrupt/unknown category can never be
 * written, even if a future caller passes unvalidated values.
 */
export function insertImprovementReview(db: Database.Database, output: ImprovementReviewOutput): ImprovementReview {
    const id = randomUUID();
    const createdAt = nowIso();
    const cleanSuggestions = output.suggestions.filter(
        (sg) => isImprovementCategory(sg.category) && typeof sg.suggestion === 'string' && sg.suggestion.length > 0,
    );
    const suggestionsJson = JSON.stringify(cleanSuggestions);
    db.prepare(
        `INSERT INTO improvement_reviews
         (id, developer_id, session_id, generated_at, analysis_model, analysis_location, review_text, suggestions, analyzed_capture_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        output.developerId,
        output.sessionId,
        output.generatedAt,
        output.analysisModel,
        output.analysisLocation,
        output.reviewText,
        suggestionsJson,
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
        reviewText: output.reviewText,
        suggestions: cleanSuggestions,
        analyzedCaptureCount: output.analyzedCaptureCount,
        createdAt,
    };
}

/** Every improvement review owned by a developer, newest first. */
export function listImprovementReviewsForDeveloper(db: Database.Database, developerId: string): ImprovementReview[] {
    const rows = db
        .prepare(
            `SELECT * FROM improvement_reviews
             WHERE developer_id = ?
             ORDER BY generated_at DESC, created_at DESC`,
        )
        .all(developerId) as ImprovementReviewRow[];
    return rows.map(rowToReview);
}

/**
 * One improvement review, scoped to the owner. The developer_id is part of the
 * WHERE clause (not just the id) so a guessed/leaked id belonging to another
 * developer returns undefined rather than their private review.
 */
export function getImprovementReviewForDeveloper(
    db: Database.Database,
    developerId: string,
    reviewId: string,
): ImprovementReview | undefined {
    const row = db
        .prepare('SELECT * FROM improvement_reviews WHERE id = ? AND developer_id = ?')
        .get(reviewId, developerId) as ImprovementReviewRow | undefined;
    return row ? rowToReview(row) : undefined;
}

/**
 * Delete one improvement review, scoped to the owner. Returns true when a row was
 * removed. Scoping the DELETE on developer_id means one developer can never delete
 * another's review even with a valid id.
 */
export function deleteImprovementReviewForDeveloper(
    db: Database.Database,
    developerId: string,
    reviewId: string,
): boolean {
    const result = db
        .prepare('DELETE FROM improvement_reviews WHERE id = ? AND developer_id = ?')
        .run(reviewId, developerId);
    return result.changes > 0;
}
