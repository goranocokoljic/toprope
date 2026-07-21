/**
 * The git-attribution identity uniqueness guard (DO1 / #250).
 *
 * A git-attribution id (`github`/`bitbucket`/`gitlab`) or a git email must map to AT MOST
 * ONE developer: `buildDevLookupMap` builds a single `identifier → developer_id` map, so a
 * second claimant does not "share" the identity — it silently steals every commit that
 * identifier resolves, from whichever developer the map happens to lose.
 *
 * This module exists because there are now three writers that must apply the SAME rule with
 * the SAME message: the identities PATCH, the create route (DO1.1 / #251), and the
 * candidate-promotion path (DO1.5 / #255, via `connectors/git/onboarding`). It used to live
 * privately inside the admin route module; a second copy in the CLI would have been a second
 * definition of "already mapped", free to drift.
 *
 * Registry-layer and DB-only: no HTTP, no reply objects. Callers map the returned message
 * onto their own surface (a 409 body, a CLI stderr line).
 */

import type Database from 'better-sqlite3';
import {findByEmail, findByExternalId} from './developers';

/**
 * Git-attribution providers. Tool identities (Copilot/Claude/Windsurf/Cursor) are
 * deliberately absent: they are not attribution keys, so they are not unique-checked.
 */
export const ATTRIBUTION_PROVIDERS = ['github', 'bitbucket', 'gitlab'] as const;

export type AttributionProvider = (typeof ATTRIBUTION_PROVIDERS)[number];

/**
 * A set of git-attribution identities one developer is claiming. Emails carry their own
 * label: the primary `email` and each `git_emails` entry are both checked with `findByEmail`
 * (it matches either column) but read differently in the conflict message.
 */
export interface IdentityClaim {
    github?: string;
    bitbucket?: string;
    gitlab?: string;
    emails?: {value: string; label: string}[];
}

/**
 * The conflict message for the first claimed git-attribution identity or git email already
 * owned by a DIFFERENT developer, or null when the whole claim is free. `excludeId` is the
 * developer making the claim — null on create, where the row does not exist yet.
 *
 * MUST be called inside the same `db.transaction` as the write it guards. The uniqueness
 * model is best-effort (the ids live in a JSON blob with no DB unique index), so the
 * transaction is what closes the read-then-write race that would otherwise let two
 * concurrent writes both pass the check and map one git identity to two developers.
 */
export function findIdentityConflict(
    db: Database.Database,
    claim: IdentityClaim,
    excludeId: string | null,
): string | null {
    for (const provider of ATTRIBUTION_PROVIDERS) {
        const value = claim[provider]?.trim();
        if (!value) continue;
        const owner = findByExternalId(db, provider, value);
        if (owner && owner.id !== excludeId) {
            return `${provider} identity '${value}' is already mapped to ${owner.name}`;
        }
    }
    for (const {value, label} of claim.emails ?? []) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        const owner = findByEmail(db, trimmed);
        if (owner && owner.id !== excludeId) {
            return `${label} '${trimmed}' is already mapped to ${owner.name}`;
        }
    }
    return null;
}
