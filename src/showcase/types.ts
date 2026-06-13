/**
 * Shared types for the exemplary-conversation showcase (Task 5.8 / #129).
 *
 * A showcase example is a conversation the developer DELIBERATELY shared: they
 * promoted one of their own captured sessions, redacted it, and published the
 * redacted text. The shapes here describe that shared, org-visible artifact —
 * never the private encrypted capture it was promoted from. There is no field
 * pointing back to prompt_captures: the two stores are connected only by the
 * owner's explicit publish action, not by a stored link.
 */

/** How widely a published example is shared. `team` keeps it within the author's team; `org` is org-wide. */
export type ShowcaseScope = 'team' | 'org';

export function isShowcaseScope(value: unknown): value is ShowcaseScope {
    return value === 'team' || value === 'org';
}

/** Lifecycle of a published example. 5.8 only ever writes `published`; the rest are 5.9 governance states. */
export type ShowcaseStatus = 'published' | 'unpublished' | 'removed';

export function isShowcaseStatus(value: unknown): value is ShowcaseStatus {
    return value === 'published' || value === 'unpublished' || value === 'removed';
}

/** A stored showcase example as readers see it. `content` is the owner's redacted, org-visible text. */
export interface ShowcaseExample {
    id: string;
    authorDeveloperId: string;
    publishedAt: string;
    scope: ShowcaseScope;
    /** The author's team when team-scoped; null for org-wide. */
    scopeTarget: string | null;
    title: string;
    /** Optional task classification (debugging | refactor | feature | …). */
    taskType: string | null;
    /** Optional AI tool the conversation used. */
    tool: string | null;
    /** The deliberately-shared, REDACTED conversation content. */
    content: string;
    /** Optional "why this is a good example" note from the author. */
    authorNote: string | null;
    status: ShowcaseStatus;
    createdAt: string;
}

/**
 * The fields a publish action persists (everything but the server-assigned
 * id/timestamps). `scopeTarget` is resolved server-side from the author's own
 * team, never accepted from request input.
 */
export interface ShowcasePublishRecord {
    authorDeveloperId: string;
    publishedAt: string;
    scope: ShowcaseScope;
    scopeTarget: string | null;
    title: string;
    taskType: string | null;
    tool: string | null;
    content: string;
    authorNote: string | null;
}
