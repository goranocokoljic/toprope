/**
 * Container normalization — THE one definition of how a provider container
 * (GitHub org / Bitbucket workspace / GitLab group) is spelled (#266).
 *
 * `(type, container)` is the attribution key of every imported `raw_author_daily`
 * and `pr_records` row, of the three `sync_state` cursors, and of the
 * `UNIQUE(type, container)` guard added in #264 — so "the same workspace" has to
 * mean the same bytes everywhere. Before this module the guard compared raw text
 * with SQLite's case-sensitive `=`, so `Wireless_Media`, `wireless_media` and
 * `Wireless_Media ` (a trailing space, trivially pasted) were three DIFFERENT
 * containers for one real workspace: the same commits imported three times into
 * three independent buckets that `git_snapshots` then summed — a permanent
 * double-count reached through the front door of the feature added to prevent it.
 *
 * The rule this module encodes is the graduated project rule from #255 — *check
 * and store the same normalized value*. Normalize ONCE, and use that single value
 * for the duplicate lookup, the stored row, the cursor keys and the imported rows;
 * never normalize for the check and store the raw input.
 *
 * ── WHY THIS FILE HAS NO IMPORTS ──────────────────────────────────────────────
 * It is imported by BOTH the server (the codec/store/config seam) and the React
 * admin bundle (`pages/admin/AdminGitProviders.tsx`), which is what #266 AC9
 * requires: the client's "this container is already taken" affordance must key off
 * the SAME normalization the server enforces, because two copies of the rule is
 * exactly how a client starts accepting what the server rejects (or blocking what
 * it would allow). Keeping this module dependency-free is what makes that possible
 * — anything it pulled in (`config/types`, `process.env`, better-sqlite3) would
 * either break the browser bundle or drag the server graph into it.
 *
 * The client check is an AFFORDANCE, not the enforcement (the #228 rule): the
 * loaded provider list can be stale and another admin can create a provider
 * between load and submit, so the server's `duplicate_container` 409 stays
 * authoritative.
 */

/**
 * The canonical spelling of a container: surrounding whitespace removed, then
 * casefolded.
 *
 * Casefolding is safe for all three providers' top-level scopes because all three
 * RESOLVE them case-insensitively: GitHub org logins are case-insensitive, Bitbucket
 * workspace slugs are lowercase, and GitLab looks a namespace up by lowercased full
 * path (uniqueness is case-insensitive) even though its path syntax does permit
 * uppercase. So two spellings differing only by case always name the same real
 * workspace, and the lowercased form always resolves against the provider's API.
 * That is the property a fourth provider type has to satisfy before being added —
 * by then the stored data is permanently keyed by the casefolded value.
 *
 * `toLowerCase()` (not `toLocaleLowerCase()`) deliberately: the result is persisted
 * and compared across processes, so it must not depend on the host locale (a Turkish
 * locale lowercases `I` to `ı`, which would make the same input normalize
 * differently on two machines).
 *
 * Idempotent: `normalizeContainer(normalizeContainer(x)) === normalizeContainer(x)`,
 * which is what lets a downstream boundary re-apply it without having to know
 * whether the value already came through here.
 *
 * TOTAL over untrusted input, by design. `resolveGitProviderConfigs` deliberately
 * yields config-file entries that have NOT been validated (so `toprope doctor` can
 * report "bitbucket provider with no workspace" specifically instead of a generic
 * "no valid providers"), so a `container` reaching here can be absent or — from
 * YAML — not even a string. Anything that is not a string normalizes to `''`, which
 * {@link isBlankContainer} and the store's write guard then refuse with a typed
 * error. Throwing instead would take down the whole sync run at the point where the
 * container keys are built, which is outside the per-provider try/catch.
 */
export function normalizeContainer(raw: string | null | undefined): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Is this container empty once normalized? A blank container is not a container:
 * `(type, '')` would merge two workspaces back into one attribution bucket, which
 * is the defect #264 exists to remove. Callers at a write/trust boundary refuse it
 * with a typed error rather than letting an empty string reach the DB.
 */
export function isBlankContainer(raw: string | null | undefined): boolean {
    return normalizeContainer(raw) === '';
}

/**
 * Do these two spellings name the same container? The comparison every
 * duplicate/ownership check must use instead of `===` on raw input.
 */
export function sameContainer(
    a: string | null | undefined,
    b: string | null | undefined,
): boolean {
    return normalizeContainer(a) === normalizeContainer(b);
}
