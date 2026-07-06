/**
 * Data-access layer for the Showcase companion tables (Task 6.3.1 / #164).
 *
 * CRUD over the five tables that hang off the contribution spine —
 * showcase_units, showcase_annotations, showcase_consent, scrub_flags,
 * showcase_practice_links. Each row references a `contributions` row by id; this
 * layer never touches the spine itself (creating the showcase contribution, its
 * title, body, and lifecycle is the spine store's job — 6.1.1). It only persists
 * and reads the showcase-specific state the spine cannot carry.
 *
 * Distinct from src/showcase/store.ts (the Phase 5 `showcase_examples` store).
 *
 * Trust-boundary contracts callers rely on:
 *   1. The MANDATORY curators' note is enforced as a GATE, not just a column: a
 *      missing/blank/whitespace note is rejected by `upsertShowcaseUnit` (the DB
 *      NOT NULL alone would accept an empty string). This is the 6.3.1 form of
 *      "enforced NOT NULL at publish"; the publish flow (6.3.2 / 6.3.4) builds on it.
 *   2. Closed enums (publish_path, visibility_scope, scrub tier) are validated
 *      against a runtime allowlist INSIDE each write function — not merely a
 *      compile-time TS union or the DB CHECK — so a future caller passing a
 *      request-supplied value is rejected at the trust boundary, fail-closed.
 *   3. `upsertShowcaseUnit` is an UPSERT on the 1:1 unit row (PRIMARY KEY is
 *      contribution_id): calling it twice updates in place rather than failing.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {
    isPublishPath,
    isScrubTier,
    isValidOutcomeLink,
    isVisibilityScope,
    type NewAnnotation,
    type NewConsent,
    type NewScrubFlag,
    type PublishPath,
    type ScrubFlag,
    type ScrubTier,
    type ShowcaseAnnotation,
    type ShowcaseConsent,
    type ShowcaseUnit,
    type ShowcaseUnitInput,
    type VisibilityScope,
} from './unitsTypes';

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Normalize an outcome link at the write boundary. An absent/blank value is "no
 * outcome" → null; a non-blank value MUST be a valid http(s) URL (see
 * {@link isValidOutcomeLink}) or the write is rejected fail-closed — a stored
 * `javascript:`/`data:` link would become a script-bearing clickable link (stored
 * XSS) when the detail view renders it as an `<a href>`. Returns the trimmed link, or
 * null. The route validates first for a clean 400; this is the belt-and-suspenders
 * gate so no code path (or direct call) can persist an unsafe link.
 */
function coerceOutcomeLink(raw: string | null | undefined, contributionId: string): string | null {
    if (raw === undefined || raw === null) {
        return null;
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
        return null;
    }
    if (!isValidOutcomeLink(trimmed)) {
        throw new Error(
            `[showcase] outcome_link must be an http(s) URL (contribution=${contributionId})`,
        );
    }
    return trimmed;
}

interface ShowcaseUnitRow {
    contribution_id: string;
    conversation: string;
    outcome_link: string | null;
    curators_note: string;
    ai_annotation: string | null;
    publish_path: string;
}

interface AnnotationRow {
    id: string;
    contribution_id: string;
    turn_ref: string;
    author_id: string;
    body: string;
    created_at: string;
}

interface ConsentRow {
    id: string;
    contribution_id: string;
    developer_id: string;
    approved: number;
    visibility_scope: string;
    approved_at: string | null;
}

interface ScrubFlagRow {
    id: string;
    contribution_id: string;
    tier: string;
    finding: string;
    resolved: number;
    created_at: string;
}

interface LinkRow {
    showcase_id: string;
    practice_id: string;
}

/**
 * Decode the publish_path column. The write path only stores an allowlisted value
 * and the DB CHECK enforces it, so an unrecognized value means corruption; warn
 * (mirroring the sibling stores' decoders) and fall back to the conservative
 * 'self_publish' — the developer-only path — rather than over-broadening a row to
 * the joint-curation path.
 */
function decodePublishPath(raw: string): PublishPath {
    if (isPublishPath(raw)) {
        return raw;
    }
    console.warn(`[showcase] unrecognized publish_path '${raw}'; defaulting to self_publish`);
    return 'self_publish';
}

/** Decode visibility_scope with the same posture; fall back to the narrower 'team'. */
function decodeVisibilityScope(raw: string): VisibilityScope {
    if (isVisibilityScope(raw)) {
        return raw;
    }
    console.warn(`[showcase] unrecognized visibility_scope '${raw}'; defaulting to team`);
    return 'team';
}

/**
 * Decode a scrub tier with a fail-CLOSED posture: an unrecognized tier defaults to
 * the more serious 'secret_high' so a corrupt row draws the reviewer's eye rather
 * than being quietly downgraded to a soft hint.
 */
function decodeScrubTier(raw: string): ScrubTier {
    if (isScrubTier(raw)) {
        return raw;
    }
    console.warn(`[showcase] unrecognized scrub tier '${raw}'; defaulting to secret_high`);
    return 'secret_high';
}

function rowToUnit(row: ShowcaseUnitRow): ShowcaseUnit {
    return {
        contributionId: row.contribution_id,
        conversation: row.conversation,
        outcomeLink: row.outcome_link,
        curatorsNote: row.curators_note,
        aiAnnotation: row.ai_annotation,
        publishPath: decodePublishPath(row.publish_path),
    };
}

function rowToAnnotation(row: AnnotationRow): ShowcaseAnnotation {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        turnRef: row.turn_ref,
        authorId: row.author_id,
        body: row.body,
        createdAt: row.created_at,
    };
}

function rowToConsent(row: ConsentRow): ShowcaseConsent {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        developerId: row.developer_id,
        approved: row.approved !== 0,
        visibilityScope: decodeVisibilityScope(row.visibility_scope),
        approvedAt: row.approved_at,
    };
}

function rowToScrubFlag(row: ScrubFlagRow): ScrubFlag {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        tier: decodeScrubTier(row.tier),
        finding: row.finding,
        resolved: row.resolved !== 0,
        createdAt: row.created_at,
    };
}

// --- Showcase unit (1:1 publishable payload) --------------------------------

/**
 * Create or update the 1:1 showcase unit for a contribution, UPSERTing on
 * contribution_id. On first call it inserts; on later calls it updates in place.
 *
 * Two trust-boundary gates run BEFORE the write:
 *   - the MANDATORY curators' note must be a non-blank string (a whitespace-only
 *     note is rejected — the DB NOT NULL would accept '');
 *   - publish_path must be on the runtime allowlist (fail-closed).
 * Both throw a typed Error rather than letting a bad value reach the DB. Returns
 * the stored unit.
 */
export function upsertShowcaseUnit(db: Database.Database, input: ShowcaseUnitInput): ShowcaseUnit {
    if (typeof input.curatorsNote !== 'string' || input.curatorsNote.trim().length === 0) {
        throw new Error(
            `[showcase] curators_note is mandatory and cannot be blank (contribution=${input.contributionId})`,
        );
    }
    if (!isPublishPath(input.publishPath)) {
        throw new Error(
            `[showcase] invalid publish_path '${String(input.publishPath)}' (contribution=${input.contributionId})`,
        );
    }

    const outcomeLink = coerceOutcomeLink(input.outcomeLink, input.contributionId);
    const aiAnnotation = input.aiAnnotation ?? null;

    db.prepare(
        `INSERT INTO showcase_units
            (contribution_id, conversation, outcome_link, curators_note, ai_annotation, publish_path)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(contribution_id) DO UPDATE SET
            conversation = excluded.conversation,
            outcome_link = excluded.outcome_link,
            curators_note = excluded.curators_note,
            ai_annotation = excluded.ai_annotation,
            publish_path = excluded.publish_path`,
    ).run(input.contributionId, input.conversation, outcomeLink, input.curatorsNote, aiAnnotation, input.publishPath);

    return {
        contributionId: input.contributionId,
        conversation: input.conversation,
        outcomeLink,
        curatorsNote: input.curatorsNote,
        aiAnnotation,
        publishPath: input.publishPath,
    };
}

/** The showcase unit for a contribution, or undefined when none has been set. */
export function getShowcaseUnit(db: Database.Database, contributionId: string): ShowcaseUnit | undefined {
    const row = db.prepare('SELECT * FROM showcase_units WHERE contribution_id = ?').get(contributionId) as
        | ShowcaseUnitRow
        | undefined;
    return row ? rowToUnit(row) : undefined;
}

// --- Annotations (inline, anchored to turns) --------------------------------

/** Record an inline developer annotation and return the stored row. */
export function addAnnotation(db: Database.Database, input: NewAnnotation): ShowcaseAnnotation {
    const id = randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    db.prepare(
        `INSERT INTO showcase_annotations (id, contribution_id, turn_ref, author_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.contributionId, input.turnRef, input.authorId, input.body, createdAt);
    return {
        id,
        contributionId: input.contributionId,
        turnRef: input.turnRef,
        authorId: input.authorId,
        body: input.body,
        createdAt,
    };
}

/**
 * A contribution's annotations in chronological order (oldest first). Ties on
 * `created_at` fall back to insertion order (rowid) so annotations recorded in the
 * same instant still read back in the order they were appended.
 */
export function listAnnotations(db: Database.Database, contributionId: string): ShowcaseAnnotation[] {
    const rows = db
        .prepare(
            `SELECT * FROM showcase_annotations
             WHERE contribution_id = ?
             ORDER BY created_at ASC, rowid ASC`,
        )
        .all(contributionId) as AnnotationRow[];
    return rows.map(rowToAnnotation);
}

/** A single annotation by its id, or undefined when none exists. */
export function getAnnotation(db: Database.Database, id: string): ShowcaseAnnotation | undefined {
    const row = db.prepare('SELECT * FROM showcase_annotations WHERE id = ?').get(id) as AnnotationRow | undefined;
    return row ? rowToAnnotation(row) : undefined;
}

/**
 * Replace an annotation's body in place (the live working copy). Returns the updated
 * annotation, or undefined when no row with that id exists. History of the prior body
 * is NOT kept in this table — the annotation layer's edit history lives in the unit's
 * 6.1.3 version lineage (the annotation service snapshots it on every mutation); this
 * table only ever holds the current annotation set.
 */
export function updateAnnotationBody(db: Database.Database, id: string, body: string): ShowcaseAnnotation | undefined {
    const res = db.prepare('UPDATE showcase_annotations SET body = ? WHERE id = ?').run(body, id);
    if (res.changes === 0) {
        return undefined;
    }
    return getAnnotation(db, id);
}

// --- Consent (developer approval + explicit visibility scope) ---------------

/**
 * Record a developer-consent decision and return the stored row. `visibilityScope`
 * is REQUIRED and validated against the runtime allowlist (fail-closed) — there is
 * no silent default, matching the schema. When `approved` is true, `approvedAt`
 * defaults to now unless an explicit timestamp is given; when not approved it stays
 * null.
 */
export function recordConsent(db: Database.Database, input: NewConsent): ShowcaseConsent {
    if (!isVisibilityScope(input.visibilityScope)) {
        throw new Error(
            `[showcase] invalid visibility_scope '${String(input.visibilityScope)}' (contribution=${input.contributionId})`,
        );
    }
    const id = randomUUID();
    const approved = input.approved ?? false;
    const approvedAt = approved ? (input.approvedAt ?? nowIso()) : (input.approvedAt ?? null);
    db.prepare(
        `INSERT INTO showcase_consent (id, contribution_id, developer_id, approved, visibility_scope, approved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.contributionId, input.developerId, approved ? 1 : 0, input.visibilityScope, approvedAt);
    return {
        id,
        contributionId: input.contributionId,
        developerId: input.developerId,
        approved,
        visibilityScope: input.visibilityScope,
        approvedAt,
    };
}

/**
 * The most recent consent record for a (contribution, developer), or undefined.
 * Ordered by insertion (rowid DESC) — NOT by a timestamp that can be null or
 * tie — so the latest decision is deterministic.
 */
export function getConsent(
    db: Database.Database,
    contributionId: string,
    developerId: string,
): ShowcaseConsent | undefined {
    const row = db
        .prepare(
            `SELECT * FROM showcase_consent
             WHERE contribution_id = ? AND developer_id = ?
             ORDER BY rowid DESC LIMIT 1`,
        )
        .get(contributionId, developerId) as ConsentRow | undefined;
    return row ? rowToConsent(row) : undefined;
}

/** All consent records for a contribution, newest first (rowid DESC for a total order). */
export function listConsent(db: Database.Database, contributionId: string): ShowcaseConsent[] {
    const rows = db
        .prepare('SELECT * FROM showcase_consent WHERE contribution_id = ? ORDER BY rowid DESC')
        .all(contributionId) as ConsentRow[];
    return rows.map(rowToConsent);
}

// --- Scrub flags (two-tier scrubber findings) -------------------------------

/**
 * Record a scrubber finding and return the stored row. `tier` is validated against
 * the runtime allowlist (fail-closed) so a bad tier never reaches the DB. New flags
 * start unresolved.
 */
export function addScrubFlag(db: Database.Database, input: NewScrubFlag): ScrubFlag {
    if (!isScrubTier(input.tier)) {
        throw new Error(
            `[showcase] invalid scrub tier '${String(input.tier)}' (contribution=${input.contributionId})`,
        );
    }
    const id = randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    db.prepare(
        `INSERT INTO scrub_flags (id, contribution_id, tier, finding, resolved, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(id, input.contributionId, input.tier, input.finding, createdAt);
    return {
        id,
        contributionId: input.contributionId,
        tier: input.tier,
        finding: input.finding,
        resolved: false,
        createdAt,
    };
}

/**
 * A contribution's scrub flags in chronological order (oldest first), ties broken
 * by insertion order (rowid). Both tiers are returned; the manual-review surface
 * (6.3.6) renders them distinctly.
 */
export function listScrubFlags(db: Database.Database, contributionId: string): ScrubFlag[] {
    const rows = db
        .prepare(
            `SELECT * FROM scrub_flags
             WHERE contribution_id = ?
             ORDER BY created_at ASC, rowid ASC`,
        )
        .all(contributionId) as ScrubFlagRow[];
    return rows.map(rowToScrubFlag);
}

/** Mark a scrub flag resolved by id. Returns true when a row was actually updated. */
export function resolveScrubFlag(db: Database.Database, id: string): boolean {
    const res = db.prepare('UPDATE scrub_flags SET resolved = 1 WHERE id = ?').run(id);
    return res.changes > 0;
}

// --- Showcase <-> best-practice cross-links ---------------------------------

/**
 * Link a showcase to a best practice (both are contributions). Idempotent: the
 * composite PRIMARY KEY means re-linking the same pair is a no-op rather than an
 * error. Returns true when a new link row was created, false when it already existed.
 */
export function linkPractice(db: Database.Database, showcaseId: string, practiceId: string): boolean {
    const res = db
        .prepare(
            `INSERT INTO showcase_practice_links (showcase_id, practice_id)
             VALUES (?, ?)
             ON CONFLICT(showcase_id, practice_id) DO NOTHING`,
        )
        .run(showcaseId, practiceId);
    return res.changes > 0;
}

/** Remove a cross-link. Returns true when a row was actually removed. */
export function unlinkPractice(db: Database.Database, showcaseId: string, practiceId: string): boolean {
    const res = db
        .prepare('DELETE FROM showcase_practice_links WHERE showcase_id = ? AND practice_id = ?')
        .run(showcaseId, practiceId);
    return res.changes > 0;
}

/** The practice ids linked to a showcase. */
export function listLinkedPractices(db: Database.Database, showcaseId: string): string[] {
    const rows = db
        .prepare('SELECT practice_id FROM showcase_practice_links WHERE showcase_id = ? ORDER BY practice_id')
        .all(showcaseId) as LinkRow[];
    return rows.map((r) => r.practice_id);
}

/** The showcase ids that link a given practice (the reverse direction). */
export function listLinkingShowcases(db: Database.Database, practiceId: string): string[] {
    const rows = db
        .prepare('SELECT showcase_id FROM showcase_practice_links WHERE practice_id = ? ORDER BY showcase_id')
        .all(practiceId) as LinkRow[];
    return rows.map((r) => r.showcase_id);
}
