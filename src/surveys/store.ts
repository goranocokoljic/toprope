/**
 * Persistence + state transitions for data-prompted surveys (Task 4.3 / #98).
 *
 * This module owns the `surveys` / `survey_responses` tables: creating surveys,
 * the queued → sent → answered/declined/dismissed lifecycle, and the read paths
 * for both the manager queue and a developer's own surveys.
 *
 * Privacy is enforced HERE, not just at the HTTP boundary: the respond/decline
 * paths take the acting developer's id and refuse to touch a survey that isn't
 * theirs (`forbidden`). A developer can only ever answer their own surveys.
 */
import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {
    type SurveyChoice,
    type SurveyDelivery,
    type SurveyQuestion,
    type SurveyRecord,
    type SurveyResponseRecord,
    type SurveyStatus,
    type SurveyTriggerType,
} from './types';

interface SurveyRow {
    id: string;
    developer_id: string;
    trigger_type: string;
    trigger_context: string | null;
    question_text: string;
    choices: string | null;
    status: string;
    delivery: string | null;
    created_at: string;
    sent_at: string | null;
}

function nowIso(): string {
    return new Date().toISOString();
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function parseChoices(raw: string | null): SurveyChoice[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        const out: SurveyChoice[] = [];
        for (const c of parsed) {
            if (c && typeof c === 'object') {
                const value = (c as Record<string, unknown>).value;
                const label = (c as Record<string, unknown>).label;
                if (typeof value === 'string' && typeof label === 'string') {
                    out.push({value, label});
                }
            }
        }
        return out;
    } catch {
        return [];
    }
}

function rowToSurvey(row: SurveyRow): SurveyRecord {
    return {
        id: row.id,
        developer_id: row.developer_id,
        trigger_type: row.trigger_type,
        trigger_context: parseJsonObject(row.trigger_context),
        question_text: row.question_text,
        choices: parseChoices(row.choices),
        status: row.status,
        delivery: row.delivery,
        created_at: row.created_at,
        sent_at: row.sent_at,
    };
}

export interface CreateSurveyInput {
    developerId: string;
    triggerType: SurveyTriggerType;
    triggerContext?: Record<string, unknown> | null;
    question: SurveyQuestion;
}

/**
 * Create a queued survey. Validation of the developer/trigger type is the
 * caller's responsibility (dispatch resolves a real developer first); this is
 * the low-level insert. Returns the persisted record.
 */
export function createSurvey(db: Database.Database, input: CreateSurveyInput): SurveyRecord {
    const id = randomUUID();
    const createdAt = nowIso();
    const contextJson =
        input.triggerContext != null ? JSON.stringify(input.triggerContext) : null;
    const choicesJson =
        input.question.choices.length > 0 ? JSON.stringify(input.question.choices) : null;

    db.prepare(
        `INSERT INTO surveys
         (id, developer_id, trigger_type, trigger_context, question_text, choices, status, delivery, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL)`,
    ).run(
        id,
        input.developerId,
        input.triggerType,
        contextJson,
        input.question.questionText,
        choicesJson,
        createdAt,
    );

    return {
        id,
        developer_id: input.developerId,
        trigger_type: input.triggerType,
        trigger_context: input.triggerContext ?? null,
        question_text: input.question.questionText,
        choices: input.question.choices,
        status: 'queued',
        delivery: null,
        created_at: createdAt,
        sent_at: null,
    };
}

export function getSurveyById(db: Database.Database, id: string): SurveyRecord | null {
    const row = db.prepare('SELECT * FROM surveys WHERE id = ?').get(id) as SurveyRow | undefined;
    return row ? rowToSurvey(row) : null;
}

/**
 * Whether an "open" survey already exists for this developer + trigger type
 * created on or after `since` (ISO). Used to avoid re-asking the same question
 * every detection run. `manual` surveys are never deduped — a manager who
 * explicitly creates one means it.
 */
export function hasRecentOpenSurvey(
    db: Database.Database,
    developerId: string,
    triggerType: SurveyTriggerType,
    since: string,
): boolean {
    const row = db
        .prepare(
            `SELECT 1 AS ok FROM surveys
             WHERE developer_id = ? AND trigger_type = ?
               AND status IN ('queued', 'sent', 'answered')
               AND created_at >= ?
             LIMIT 1`,
        )
        .get(developerId, triggerType, since) as {ok: number} | undefined;
    return row !== undefined;
}

export interface SurveyListFilter {
    status?: SurveyStatus;
    triggerType?: SurveyTriggerType;
    team?: string;
    developerId?: string;
    limit?: number;
}

// A survey enriched for the manager view: developer identity + any response.
export interface SurveyWithContext extends SurveyRecord {
    developer_name: string | null;
    team: string | null;
    response: SurveyResponseRecord | null;
}

/**
 * Manager-facing list of surveys, newest first, joined to developer identity and
 * the latest response (the "response shown alongside the triggering data" view).
 */
export function listSurveys(db: Database.Database, filter: SurveyListFilter = {}): SurveyWithContext[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
        clauses.push('s.status = ?');
        params.push(filter.status);
    }
    if (filter.triggerType) {
        clauses.push('s.trigger_type = ?');
        params.push(filter.triggerType);
    }
    if (filter.team) {
        clauses.push('d.team = ?');
        params.push(filter.team);
    }
    if (filter.developerId) {
        clauses.push('s.developer_id = ?');
        params.push(filter.developerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `
        SELECT s.*, d.name AS developer_name, d.team AS team
        FROM surveys s
        LEFT JOIN developers d ON d.id = s.developer_id
        ${where}
        ORDER BY s.created_at DESC`;
    if (filter.limit !== undefined && Number.isInteger(filter.limit) && filter.limit > 0) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
    }
    const rows = db.prepare(sql).all(...params) as (SurveyRow & {
        developer_name: string | null;
        team: string | null;
    })[];
    return rows.map((row) => ({
        ...rowToSurvey(row),
        developer_name: row.developer_name,
        team: row.team,
        response: getLatestResponse(db, row.id),
    }));
}

/**
 * A developer's own surveys — only ones that have actually been delivered to
 * them (sent/answered/declined). Queued surveys still awaiting a manager's send
 * are deliberately excluded, so a developer never sees a survey before it's
 * dispatched. Scoped strictly to the given developer id.
 */
export function listSurveysForDeveloper(
    db: Database.Database,
    developerId: string,
): SurveyWithContext[] {
    const rows = db
        .prepare(
            `SELECT * FROM surveys
             WHERE developer_id = ?
               AND status IN ('sent', 'answered', 'declined')
             ORDER BY created_at DESC`,
        )
        .all(developerId) as SurveyRow[];
    return rows.map((row) => ({
        ...rowToSurvey(row),
        developer_name: null,
        team: null,
        response: getLatestResponse(db, row.id),
    }));
}

export function getLatestResponse(
    db: Database.Database,
    surveyId: string,
): SurveyResponseRecord | null {
    const row = db
        .prepare(
            'SELECT * FROM survey_responses WHERE survey_id = ? ORDER BY answered_at DESC LIMIT 1',
        )
        .get(surveyId) as SurveyResponseRecord | undefined;
    return row ?? null;
}

/**
 * Mark a queued survey sent with the delivery channel used. Idempotency: only a
 * `queued` survey transitions; returns false if it was already sent/answered/etc
 * (so a double-send can't reset sent_at or overwrite a response).
 */
export function markSurveySent(
    db: Database.Database,
    id: string,
    delivery: SurveyDelivery,
): boolean {
    const result = db
        .prepare(
            `UPDATE surveys SET status = 'sent', delivery = ?, sent_at = ?
             WHERE id = ? AND status = 'queued'`,
        )
        .run(delivery, nowIso(), id);
    return result.changes > 0;
}

/**
 * Dismiss a queued survey (manager action) — discard without sending. Only a
 * queued survey can be dismissed; an already-sent one is left untouched.
 */
export function dismissSurvey(db: Database.Database, id: string): boolean {
    const result = db
        .prepare("UPDATE surveys SET status = 'dismissed' WHERE id = ? AND status = 'queued'")
        .run(id);
    return result.changes > 0;
}

// Outcome of a developer respond/decline attempt. Maps cleanly onto HTTP codes
// at the API boundary (404 / 403 / 409) and is independently testable.
export type RespondOutcome = 'ok' | 'not_found' | 'forbidden' | 'invalid_status';

export interface RespondInput {
    responseText?: string | null;
    responseChoice?: string | null;
}

/**
 * Record a developer's answer to a survey, enforcing ownership and a valid
 * status in one atomic transaction.
 *
 *  - not_found     : no such survey
 *  - forbidden     : the survey belongs to a different developer
 *  - invalid_status: not in a state that accepts an answer (already
 *                    answered/declined/dismissed, or never sent)
 *
 * A `sent` survey becomes `answered`. The choice (if any) is validated against
 * the survey's stored choices so a caller can't smuggle an arbitrary value.
 */
export function respondToSurvey(
    db: Database.Database,
    surveyId: string,
    developerId: string,
    input: RespondInput,
): RespondOutcome {
    const tx = db.transaction((): RespondOutcome => {
        const survey = getSurveyById(db, surveyId);
        if (!survey) return 'not_found';
        if (survey.developer_id !== developerId) return 'forbidden';
        if (survey.status !== 'sent') return 'invalid_status';

        const text = normalizeText(input.responseText);
        const choice = normalizeChoice(survey.choices, input.responseChoice);
        // Require at least one of choice/text — an empty response is not an answer.
        if (choice === null && text === null) return 'invalid_status';

        db.prepare(
            `INSERT INTO survey_responses (id, survey_id, response_text, response_choice, answered_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), surveyId, text, choice, nowIso());
        db.prepare("UPDATE surveys SET status = 'answered' WHERE id = ?").run(surveyId);
        return 'ok';
    });
    return tx();
}

/**
 * Record that a developer declined a survey (status = declined). Voluntary by
 * design — declining is a first-class, recorded outcome, never held against the
 * developer. Same ownership + status guarding as respondToSurvey.
 */
export function declineSurvey(
    db: Database.Database,
    surveyId: string,
    developerId: string,
): RespondOutcome {
    const survey = getSurveyById(db, surveyId);
    if (!survey) return 'not_found';
    if (survey.developer_id !== developerId) return 'forbidden';
    if (survey.status !== 'sent') return 'invalid_status';
    db.prepare("UPDATE surveys SET status = 'declined' WHERE id = ?").run(surveyId);
    return 'ok';
}

function normalizeText(text: string | null | undefined): string | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
}

// Accept a choice only if it matches one of the survey's offered values, so the
// stored response_choice is always a known option (free text goes in text).
function normalizeChoice(choices: SurveyChoice[], choice: string | null | undefined): string | null {
    if (typeof choice !== 'string') return null;
    const trimmed = choice.trim();
    if (!trimmed) return null;
    return choices.some((c) => c.value === trimmed) ? trimmed : null;
}
