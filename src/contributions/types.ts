/**
 * Shared types for the contribution spine (Task 6.1.1 / #151).
 *
 * These shapes describe the FEATURE-AGNOSTIC foundation both the Best Practices
 * (6.2) and Showcase (6.3) features sit on. Nothing here knows what a
 * best-practice or a showcase example is: a contribution carries a `contentType`
 * (an open enum), a title, an author, a scope, a lifecycle state, a version
 * lineage, free-form tags, and an audit trail of governance events. The
 * type-specific payload lives, opaque, inside each version's `body` (a JSON
 * string the spine never interprets) and in feature companion tables.
 */

/**
 * What kind of content a contribution is. Deliberately an OPEN enum — typed as a
 * plain `string` so the spine accepts any value and a future content type is a
 * feature code change, not a spine migration (the column carries no CHECK). The
 * two values in use today are listed in `KNOWN_CONTENT_TYPES` for reference.
 */
export type ContributionContentType = string;

/** The content types that exist today. Informational — the column is not constrained to them. */
export const KNOWN_CONTENT_TYPES = ['best_practice', 'showcase_example'] as const;

/** How widely a contribution is shared. `team` confines it to one team; `org` is org-wide. */
export type ContributionScope = 'org' | 'team';

export function isContributionScope(value: unknown): value is ContributionScope {
    return value === 'org' || value === 'team';
}

/**
 * Lifecycle state of a contribution. The set is closed (and DB-enforced), but the
 * legal transitions BETWEEN states are owned by the 6.1.2 state machine, not by
 * this type — here it is only a label.
 */
export type ContributionState = 'draft' | 'submitted' | 'published' | 'unpublished' | 'removed';

export const CONTRIBUTION_STATES = [
    'draft',
    'submitted',
    'published',
    'unpublished',
    'removed',
] as const;

export function isContributionState(value: unknown): value is ContributionState {
    return (CONTRIBUTION_STATES as readonly unknown[]).includes(value);
}

/**
 * A governance/lifecycle action recorded in the audit trail. Open enum like
 * `contentType` (typed as `string`, no CHECK): the audit trail must be able to
 * record whatever action a feature's governance flow performs. The actions in
 * use today are listed in `KNOWN_REVIEW_EVENTS` for reference.
 */
export type ReviewEventType = string;

/** The review-event actions in use today. Informational — the column is not constrained to them. */
export const KNOWN_REVIEW_EVENTS = [
    'submitted',
    'approved',
    'published',
    'unpublished',
    'removed',
    'redacted',
] as const;

/** A stored contribution — the spine row as callers see it (camelCase). */
export interface Contribution {
    id: string;
    contentType: ContributionContentType;
    title: string;
    authorId: string;
    scope: ContributionScope;
    /** The team name when team-scoped; null for org-wide. */
    scopeTarget: string | null;
    state: ContributionState;
    /** Points at the live version in the version lineage; starts at 1. */
    currentVersion: number;
    createdAt: string;
    updatedAt: string;
}

/**
 * The fields needed to create a contribution. Creating a contribution always
 * establishes version 1 atomically (a spine row with no version would violate
 * the `currentVersion` invariant), so the initial `body` and its `changeNote`
 * live here too. `state` defaults to `draft`; timestamps default to now.
 */
export interface NewContribution {
    contentType: ContributionContentType;
    title: string;
    authorId: string;
    scope: ContributionScope;
    scopeTarget?: string | null;
    /** Initial lifecycle state. Defaults to `draft`. */
    state?: ContributionState;
    /** The version-1 payload, an opaque JSON string the spine does not interpret. */
    body: string;
    /** Optional note describing the initial version. */
    changeNote?: string | null;
    /** UTC ISO timestamp for created_at/updated_at and the v1 row. Defaults to now. */
    timestamp?: string;
}

/** A single version in a contribution's lineage. */
export interface ContributionVersion {
    id: string;
    contributionId: string;
    version: number;
    /** The versioned payload, an opaque JSON string. */
    body: string;
    authorId: string;
    changeNote: string | null;
    createdAt: string;
}

/** The fields needed to append a new version to an existing contribution. */
export interface NewContributionVersion {
    body: string;
    authorId: string;
    changeNote?: string | null;
    /** UTC ISO timestamp; defaults to now. */
    timestamp?: string;
}

/** One recorded governance/lifecycle action in a contribution's audit trail. */
export interface ContributionReviewEvent {
    id: string;
    contributionId: string;
    event: ReviewEventType;
    actorId: string;
    note: string | null;
    occurredAt: string;
}

/** The fields needed to append a review event to the audit trail. */
export interface NewReviewEvent {
    contributionId: string;
    event: ReviewEventType;
    actorId: string;
    note?: string | null;
    /** UTC ISO timestamp of when the action happened; defaults to now. */
    occurredAt?: string;
}

/** Optional filters for listing contributions. All are ANDed; omitted fields don't filter. */
export interface ContributionFilters {
    contentType?: ContributionContentType;
    scope?: ContributionScope;
    /**
     * Narrow by `scope_target`. A string matches that team's rows; explicit
     * `null` matches the org-wide rows (whose `scope_target` is NULL). Omitting
     * the field (undefined) does not filter on target at all. Because SQL `= NULL`
     * is never true, the null case is handled with `IS NULL` in the store — so
     * passing `null` correctly selects org rows rather than silently matching none.
     */
    scopeTarget?: string | null;
    state?: ContributionState;
    authorId?: string;
}
