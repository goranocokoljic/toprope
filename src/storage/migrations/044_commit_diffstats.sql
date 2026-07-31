-- #273: a permanent, immutable cache of per-commit diffstats — the "ratchet" that makes a
-- failed git sync run keep the expensive work it already did.
--
-- THE PROBLEM. The dominant cost of a git sync is the per-commit diffstat fan-out: one API
-- call per commit, thousands of calls over hours on a full-history window. And it is
-- all-or-nothing — per #231 a repo failure holds the provider's forward cursor and discards
-- every partial result, because commit counts are ADDED across runs and persisting a
-- half-covered window would double-count. So a 503 on commit 4,900 of 5,000 throws away
-- 4,899 successful fetches, and the next run starts from zero. #272 made hitting a failure
-- rare; this table makes hitting one cheap.
--
-- WHY CACHING IS SOUND HERE, AND WHY THIS IS NOT AN APPEND-ONLY SNAPSHOT TABLE. A commit's
-- diffstat is IMMUTABLE: `(repo, sha) -> file stats` is a property of an object identified by
-- the hash of its own content and history. It can never go stale, so there is no invalidation
-- policy to get wrong. This table is therefore not a source of record and not a snapshot: it
-- is a memo of an idempotent remote read, sitting strictly UPSTREAM of the accumulator. It
-- changes nothing about cursor semantics, nothing about #231's drop-partials rule, and nothing
-- about the additive-merge proof in `raw-author-daily.ts` — deleting the whole table only
-- costs the next run some re-fetching. The project's append-only constraint governs
-- `tool_snapshots` and the other snapshot tables; its rationale (never rewrite observed
-- history) has no purchase on a derived, re-derivable memo, which is exactly why rows here may
-- be written per-commit as a run progresses, OUTSIDE the run's final write transaction. That
-- placement IS the feature: rows have to survive a run that later fails and rolls back.
--
-- ATTRIBUTION KEY. `(provider, container, repo, sha)` — the same `(provider, container)` pair
-- #264 made the attribution key of `raw_author_daily` and `pr_records`, and the same pair the
-- pipeline's cursors are keyed by. That is what lets the provider delete cascade retract this
-- container's rows alongside the rest, so "this container's contribution is gone" stays a true
-- statement. Correctness would survive a shared cache (the same sha in the same repo has the
-- same diffstat whoever fetched it), but a re-added provider must not silently inherit rows
-- its credentials no longer justify.
--
-- WHAT IS STORED, AND WHY BOTH THE TOTALS AND THE ENTRIES.
--   * `additions`/`deletions` are the COMMIT-LEVEL totals the provider reported, not a sum of
--     `entries`. On Bitbucket and GitLab those happen to be the same number, but GitHub takes
--     the totals from the commit's `stats` while truncating its `files` array at 300 — so
--     re-deriving the totals from the entries would silently under-report exactly the largest
--     GitHub commits. Both are stored so a cache hit reproduces what the fetch produced.
--   * `entries` is the file-level list as JSON (`[{path, additions, deletions, status}]`) — the
--     full list, uncapped. `code_churn_rate` and `ai_signature_score` are computed from the
--     per-file shape, so a cap would silently alter stats; and the same array already lives in
--     memory for the whole run today, so capping buys nothing at the point it would cost
--     accuracy. The growth characteristic is accepted: rows are small, bounded by distinct
--     commits ever synced, and the table can be emptied at any time with no data loss.
--   * `absent = 1` is the explicit 404 marker: the provider answered "no diffstat exists for
--     this commit" (Bitbucket merge commits, GitLab initial commits). That is a DETERMINISTIC
--     per-commit answer, so it is cacheable and must be — those are precisely the commits a
--     naive cache would re-ask forever. It is deliberately NOT the same statement as "this
--     commit touched no files", even though both produce a zero-stat commit downstream.
--
-- WHAT IS NEVER CACHED: a 5xx, a rate limit, or a transport fault. Those are statements about
-- the server's health, not about the commit, and the fetch sites rethrow them so no row is
-- written. Only a successful response or a deterministic 404 reaches a write.
--
-- THE RESIDUAL, STATED PLAINLY. Three answers are recorded as facts that in rare circumstances
-- are not facts about the commit:
--   * a 404 that means "you may not see this" rather than "this has no diffstat". Reaching the
--     diffstat call requires that repo's COMMIT LIST to have already succeeded on the same
--     credential, so this needs access to be revoked between the list and the per-commit walk —
--     which on a multi-hour full-history sync is a window measured in hours, not seconds;
--   * a 404 on page >= 2 of a PAGED diff. Both `fetchPaged` (Bitbucket) and the `x-next-page`
--     loop (GitLab) discard the pages already collected and throw, so a commit whose first page
--     listed 500 files is recorded as having none;
--   * a 200 that is silently truncated — e.g. a proxy stripping GitLab's `x-next-page` or
--     Bitbucket's `next`, so a paged diff ends early and its re-summed totals under-report.
-- None is new in KIND: all three already produced an understated commit, and on a run that
-- COMPLETED the cursor advanced past it, so the understatement was already permanent. What
-- changes is the one case where it used to self-heal — a run that later FAILED re-covered its
-- whole window and re-asked. The remedy is that this table is disposable: deleting the
-- affected rows (or the container's whole set) makes the next sync re-fetch them.
--     DELETE FROM commit_diffstats WHERE provider = ? AND container = ?;   -- and/or AND repo = ?
-- Since #286 that statement has an operator surface and does NOT require opening sqlite3
-- against the production database:
--     toprope git cache clear [--provider <t>] [--container <c>] [--repo <r>]
-- with every flag optional and composing (omitting one widens the scope). `toprope doctor`
-- reports the table's row count, its share of `absent` markers and the bytes its `entries`
-- occupy, which is the signal that says whether a purge is worth issuing.
-- The provider delete cascade (#264) issues the same DELETE for its container.
--
-- THIS TABLE IS PART OF THE GIT-DATA RESET CONTRACT — a future reset MUST clear it. Migrations
-- 042 and 043 established the project's remedy for wrong git data: empty `git_snapshots` /
-- `raw_author_daily`, clear the `git_*` cursors, and resync. That remedy works because the
-- resync re-asks the provider for everything. A resync that reads this table does NOT re-ask;
-- it replays whatever is cached, including any of the three answers above. So any future
-- migration or command that resets git data must add
--     DELETE FROM commit_diffstats;
-- or the reset will silently converge on the same numbers it was run to discard. (Nothing needs
-- adding to 042/043 themselves: both predate this table, so on any store that has run them the
-- table is empty or absent.)
--
-- DATA SCOPE — READ BEFORE ADDING A COLUMN. `entries` is the FIRST place this schema persists
-- actual source-tree paths from a customer's private repositories; every prior git table stored
-- counts only (`files_changed INTEGER`). The paths are unencrypted, in the same database as
-- `git_providers.token_ciphertext`, and are retained for as long as the row is — which is
-- forever, unless a provider is deleted. Nothing reads the table outside the sync fetch path
-- (no endpoint, no serializer, no aggregate), so the privacy model — individual data to that
-- developer only, managers to team aggregates — is untouched. But this IS a retention decision,
-- taken deliberately: the file-level entries are what `code_churn_rate` and `ai_signature_score`
-- are computed from, and a deployment that cannot accept storing them should not enable git
-- analysis at all. Excluding a repo after the fact stops it being listed; it does NOT retract
-- rows already cached — run `toprope git cache clear --repo <name>` (#286).

CREATE TABLE IF NOT EXISTS commit_diffstats (
    -- Provider family. Closed set, DB-enforced — same vocabulary as git_providers.
    provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'gitlab')),
    -- The provider INSTANCE (org/workspace/group), normalized by `normalizeContainer` at the
    -- write boundary. Never blank: a blank container would pool two workspaces into one cache
    -- bucket that no per-provider delete could retract.
    container TEXT NOT NULL CHECK (length(container) > 0),
    -- Repo identifier as the provider's fetch path spells it (GitHub name, Bitbucket slug,
    -- GitLab path_with_namespace) — NOT repo-namespaced the way the sync loop namespaces diff
    -- paths downstream.
    repo TEXT NOT NULL CHECK (length(repo) > 0),
    sha TEXT NOT NULL CHECK (length(sha) > 0),
    -- Commit-level totals as reported by the provider. See the header note on why these are
    -- stored rather than re-derived from `entries`.
    additions INTEGER NOT NULL CHECK (additions >= 0),
    deletions INTEGER NOT NULL CHECK (deletions >= 0),
    -- 1 iff the provider returned 404 for this commit's diffstat — a deterministic answer.
    absent INTEGER NOT NULL CHECK (absent IN (0, 1)),
    -- JSON array of {path, additions, deletions, status}. Read back through a shape check,
    -- never trusted: this is TEXT, so a hand-edited or truncated value must degrade to a cache
    -- MISS (re-fetch), not to a corrupted commit.
    entries TEXT NOT NULL,
    -- When this memo was recorded (UTC ISO). Provenance only — it is never consulted to decide
    -- freshness, because an immutable fact has none.
    fetched_at TEXT NOT NULL,
    -- An absent diffstat carries nothing: pinning that here stops a future writer inventing a
    -- row that claims both "no diffstat exists" and "here are its 40 changed lines".
    CHECK (absent = 0 OR (additions = 0 AND deletions = 0 AND entries = '[]')),
    PRIMARY KEY (provider, container, repo, sha)
);

-- NO SECONDARY INDEX, deliberately. Both access patterns are left-prefix seeks on the PRIMARY
-- KEY index SQLite creates for the declaration above:
--   * the batch read — `provider = ? AND container = ? AND repo = ? AND sha IN (...)` — uses all
--     four columns;
--   * the delete cascade (#264) — `provider = ? AND container = ?` — uses the leading two.
-- A second index on the same prefix would cost every per-commit write and buy nothing.
