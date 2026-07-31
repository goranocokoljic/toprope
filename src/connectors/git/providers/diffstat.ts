/**
 * The one place a provider decides what to do with the ratchet cache (#273).
 *
 * Bitbucket and GitLab reach a commit's diffstat through the same three steps — look in the
 * cache, else call the provider's own per-commit endpoint, else (on a 404 and ONLY a 404)
 * record the deterministic "no diffstat exists" answer — and both then sum the file entries
 * to get the commit's totals. Written out per provider that is ~30 near-identical lines
 * twice, and the line that matters most is the one deciding WHICH faults may be cached: a
 * fix applied to one copy would silently leave the other caching failures. The graduated
 * project rule ("reuse the canonical helper instead of cloning shared logic") applies
 * exactly here, and this module is its home, beside `http-retry.ts` and `container.ts` which
 * exist for the same reason.
 *
 * GitHub deliberately does NOT use {@link resolveCommitDiffstat}. Its per-commit request is
 * the commit DETAIL, not a diffstat resource: the totals come from `stats` (authoritative
 * even where the `files` array is truncated at 300, so they must not be re-summed), and a
 * 404 on a sha GitHub's own commit list just returned is an anomaly to surface rather than
 * an answer to cache. It shares {@link loadDiffstats} and nothing else — forcing the two
 * shapes into one function would mean a flag deciding whether a 404 is an answer, which is
 * the distinction most worth keeping visible.
 */

import {GitProviderFetchError} from './http-retry.js';
import type {CommitDiffstat, CommitDiffstatCache, GitFileDiff} from './types.js';

/**
 * Is this value usable as a stored line/file count? A non-negative safe integer (#288).
 *
 * THE canonical predicate for the question, shared rather than restated, because three
 * boundaries ask it about the SAME value — a provider's commit-level total — and they must
 * not drift:
 *   - `providers/github.ts` classifies a commit-detail `stats` object as observed or not,
 *     which decides whether the churn is memoized and whether the developer-day is reported
 *     as understated;
 *   - `diffstat-cache.ts` refuses to persist a row whose counts are not counts;
 *   - `raw-author-daily.ts` THROWS on one, inside the run's single all-providers write
 *     transaction, which rolls back every provider's window and does so again on every
 *     later run.
 * The middle one drops the row silently and deliberately does not count a fault, so a value
 * the first boundary waves through and the second refuses is invisible on both channels
 * while still reaching the third. Keeping one predicate is what makes the front boundary's
 * classification actually protect the back one.
 *
 * TOTAL over `unknown`, and non-negative and safe-integer rather than merely integral. The
 * lower bound is what the two boundaries downstream already enforce. The upper bound is not
 * decoration either: `Number.isInteger(1e300)` is `true` and clears them both, and the value
 * then fails at better-sqlite3 bind time — again inside that write transaction, again
 * deterministically. Rejected here it costs one advisory line instead.
 */
export function isCommitCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Every diffstat already known for `shas` in `repo`, in one batched query.
 *
 * Returns an empty map when no cache was supplied, which is every probe path (`toprope
 * doctor`, the admin test-connection and repo-listing routes) — those never walk commits, so
 * they behave exactly as they did before #273.
 */
export async function loadDiffstats(
    cache: CommitDiffstatCache | undefined,
    repo: string,
    shas: readonly string[],
): Promise<Map<string, CommitDiffstat>> {
    return (await cache?.load(repo, shas)) ?? new Map();
}

/**
 * One commit's diffstat for a provider whose per-commit endpoint IS a diffstat resource
 * (Bitbucket, GitLab): served from `cached` when known, otherwise fetched and written
 * through.
 *
 * A hit is the same answer the endpoint would give — the fact is immutable — including the
 * `absent` case, whose stored form is `[]`/0/0, byte-identical to what the 404 branch below
 * produces.
 *
 * ONLY a successful response or a deterministic 404 is ever recorded. Everything else — 5xx,
 * rate limit, transport fault, an auth failure — rethrows before the write, so an outage can
 * never be frozen as a commit's answer. That single rule is why this function exists once
 * rather than twice.
 *
 * The write happens per commit and OUTSIDE the run's write transaction. That is the whole
 * point: the row has to survive a run that later fails and drops all its partial data (#231).
 */
export async function resolveCommitDiffstat(
    cache: CommitDiffstatCache | undefined,
    cached: Map<string, CommitDiffstat>,
    repo: string,
    sha: string,
    fetchEntries: () => Promise<GitFileDiff[]>,
): Promise<CommitDiffstat> {
    const hit = cached.get(sha);
    if (hit !== undefined) return hit;

    let entries: GitFileDiff[] = [];
    let absent = false;
    try {
        entries = await fetchEntries();
    } catch (err) {
        // 404 means the diffstat is absent for this commit (Bitbucket merge commits, GitLab
        // initial commits) — a deterministic per-commit answer, so it is recorded with zero
        // stats. It MUST be recorded, or those are exactly the commits re-asked every run
        // forever. Keyed on the typed status rather than a ' 404:' substring (#272): the
        // substring also matched a URL that merely CONTAINED it, and swallowing a real
        // failure here silently understates the commit's churn.
        if (!(err instanceof GitProviderFetchError) || err.status !== 404) throw err;
        absent = true;
    }

    const value: CommitDiffstat = {
        additions: entries.reduce((s, d) => s + d.additions, 0),
        deletions: entries.reduce((s, d) => s + d.deletions, 0),
        entries,
        absent,
    };
    cache?.put(repo, sha, value);
    return value;
}
