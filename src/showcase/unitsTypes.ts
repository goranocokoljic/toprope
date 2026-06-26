/**
 * Shared types for the Showcase companion tables (Task 6.3.1 / #164).
 *
 * These shapes describe the five tables Showcase (Epic 6.3) adds on top of the 6.1
 * contribution spine — showcase_units, showcase_annotations, showcase_consent,
 * scrub_flags, showcase_practice_links. A showcase itself is a `contributions` row
 * (content_type = 'showcase_example'); these companions carry only what the
 * feature-agnostic spine cannot.
 *
 * Distinct from the Phase 5 `showcase_examples` store (src/showcase/types.ts):
 * that is the standalone Phase 5 self-publish store; this is the Phase 6 layer that
 * reuses the shared contribution spine (no duplicate store).
 */

/**
 * The spine `content_type` a showcase carries. A showcase IS a `contributions`
 * row distinguished by this value (see migration 037); the companion tables hang
 * off it by reference. Exported as the ONE canonical literal so the browse,
 * governance, cross-link, and publish surfaces all key off a single source of
 * truth rather than re-hardcoding the string (which would silently drift).
 */
export const SHOWCASE_CONTENT_TYPE = 'showcase_example';

/** Which publish path produced a showcase unit. Closed set. */
export type PublishPath = 'self_publish' | 'joint_curation';

export const PUBLISH_PATHS = ['self_publish', 'joint_curation'] as const;

export function isPublishPath(value: unknown): value is PublishPath {
    return value === 'self_publish' || value === 'joint_curation';
}

/** The reach a developer consented to. Closed set; no silent default. */
export type VisibilityScope = 'team' | 'org';

export const VISIBILITY_SCOPES = ['team', 'org'] as const;

export function isVisibilityScope(value: unknown): value is VisibilityScope {
    return value === 'team' || value === 'org';
}

/**
 * A scrubber confidence tier. `secret_high` = secrets/keys/credentials, flagged
 * firmly; `pii_hint_low` = softer PII, a fallible non-blocking hint.
 */
export type ScrubTier = 'secret_high' | 'pii_hint_low';

export const SCRUB_TIERS = ['secret_high', 'pii_hint_low'] as const;

export function isScrubTier(value: unknown): value is ScrubTier {
    return value === 'secret_high' || value === 'pii_hint_low';
}

/** The 1:1 showcase-specific payload for a contribution. */
export interface ShowcaseUnit {
    contributionId: string;
    /** Redacted conversation content (opaque JSON of turns). */
    conversation: string;
    /** Optional PR/code/goal reference. */
    outcomeLink: string | null;
    /** MANDATORY curators' note (the data layer rejects a blank one). */
    curatorsNote: string;
    /** Optional AI prompt-technique annotation. */
    aiAnnotation: string | null;
    publishPath: PublishPath;
}

/** The fields needed to create/update a showcase unit. */
export interface ShowcaseUnitInput {
    contributionId: string;
    conversation: string;
    /** MANDATORY — a blank/whitespace value is rejected at the write boundary. */
    curatorsNote: string;
    publishPath: PublishPath;
    outcomeLink?: string | null;
    aiAnnotation?: string | null;
}

/** A stored inline developer annotation anchored to a turn. */
export interface ShowcaseAnnotation {
    id: string;
    contributionId: string;
    turnRef: string;
    authorId: string;
    body: string;
    createdAt: string;
}

/** The fields needed to record an annotation. */
export interface NewAnnotation {
    contributionId: string;
    turnRef: string;
    authorId: string;
    body: string;
    /** UTC ISO timestamp; defaults to now. */
    createdAt?: string;
}

/** A stored developer-consent record. */
export interface ShowcaseConsent {
    id: string;
    contributionId: string;
    developerId: string;
    approved: boolean;
    visibilityScope: VisibilityScope;
    /** UTC ISO when approved, or null. */
    approvedAt: string | null;
}

/**
 * The fields needed to record consent. `visibilityScope` is REQUIRED — there is no
 * default, matching the no-silent-default schema constraint.
 */
export interface NewConsent {
    contributionId: string;
    developerId: string;
    visibilityScope: VisibilityScope;
    /** Defaults to false (consent recorded but not yet approved). */
    approved?: boolean;
    /** UTC ISO when approved; defaults to now when `approved` is true, else null. */
    approvedAt?: string | null;
}

/** A stored scrubber finding. */
export interface ScrubFlag {
    id: string;
    contributionId: string;
    tier: ScrubTier;
    finding: string;
    resolved: boolean;
    createdAt: string;
}

/** The fields needed to record a scrub flag. */
export interface NewScrubFlag {
    contributionId: string;
    tier: ScrubTier;
    finding: string;
    /** UTC ISO timestamp; defaults to now. */
    createdAt?: string;
}
