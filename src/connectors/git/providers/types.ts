export type GitProviderType = 'github' | 'bitbucket' | 'gitlab';

/**
 * The runtime allowlist for {@link GitProviderType} — what a trust boundary must check a
 * caller-supplied string against, since the compile-time union proves nothing about a
 * value that arrives as arbitrary CLI/HTTP input.
 *
 * Derived from a Record keyed by the union, so this list cannot silently drift from it:
 * adding a member to GitProviderType without adding it here is a BUILD error (the Record
 * is missing a key), not a provider that quietly fails every runtime check.
 */
const GIT_PROVIDER_TYPE_SET: Record<GitProviderType, true> = {
    github: true,
    bitbucket: true,
    gitlab: true,
};

export const GIT_PROVIDER_TYPES = Object.keys(GIT_PROVIDER_TYPE_SET) as readonly GitProviderType[];

export interface GitAuthor {
    name: string;
    email: string;
    username: string;
}

export interface GitRepo {
    id: string;
    /**
     * The canonical repo identifier the sync pipeline filters and fetches by
     * (GitHub repo name, Bitbucket slug, GitLab path_with_namespace). Stored
     * repo-scope filters (`repos_include`/`repos_exclude`) match against THIS
     * value — it must stay stable.
     */
    name: string;
    fullName: string;
    /**
     * The provider's human-readable repository name, for display only (#213).
     * Set only where the provider exposes a name distinct from the slug/path
     * (Bitbucket, GitLab); absent for GitHub. The sole consumer (the admin
     * `/repos` projection) falls back to `name`. Never used for filtering or
     * API paths.
     */
    displayName?: string;
    defaultBranch: string;
    isArchived: boolean;
}

export interface GitCommit {
    sha: string;
    author: GitAuthor;
    date: string;
    message: string;
    additions: number;
    deletions: number;
    /**
     * Since #271 this is DERIVED — all three providers set it to `diffs.map(d => d.path)`
     * — and it has no production reader (`toAnalysisCommit` builds `AnalysisCommit.fileDiffs`
     * from the diffs the sync loop passes it, and `scoreAiSignature` counts those). Do not
     * treat it as independent input, and do not add a reader: use `diffs` and derive. Kept
     * only because removing it is a test-wide rename that #271 does not need.
     */
    filesChanged: string[];
    /**
     * The file-level diff already fetched for this commit, carried out of `getCommits` so
     * the consumer does not request it a second time (#271). All three in-tree providers
     * supply it — each already walks a per-commit endpoint while building this row — which
     * is what makes a sync cost ~N per-commit diff walks instead of ~2N. It is the SAME
     * value `getCommitDiff(repo, sha)` would return for this commit — with one deliberate
     * exception: where `getCommitDiff` would THROW a 404, this is `[]` (see below).
     *
     * NOT a source for the totals above, and do NOT re-derive them from it. On Bitbucket
     * and GitLab `additions`/`deletions` are in fact the sum of these entries, but on
     * GitHub they come from the commit's whole-commit `stats` while this list is the
     * `files` array GitHub truncates at 300 — so there the totals can legitimately EXCEED
     * what these entries sum to. Summing this to get a commit's line counts silently
     * under-reports exactly the largest GitHub commits.
     *
     * `undefined` and `[]` are NOT interchangeable. `undefined` means "this provider
     * supplied nothing — fetch it via `getCommitDiff`". `[]` means "the walk finished and
     * no further request will help" — which is EITHER a commit that genuinely touched no
     * files, OR a lossy degradation: Bitbucket and GitLab swallow a 404 from the
     * diffstat/diff endpoint into `[]`, and GitLab's 404 case is initial commits, which do
     * touch files. So do not read `diffs.length === 0` as "empty commit"; read it as "no
     * file-level detail is obtainable". Either way it must not fall back — collapsing `[]`
     * into `undefined` would send exactly these commits back to an endpoint that just
     * refused them, the duplicate request this field exists to remove.
     *
     * Optional deliberately: `getCommitDiff` stays on the interface for callers holding
     * only a sha, so an implementation that legitimately cannot pre-fetch the diff — one
     * whose commit-list endpoint already carries the totals, say — must be able to say "I
     * have none" and be served correctly rather than be forced to fabricate an empty array
     * that would read as "no detail obtainable".
     *
     * Paths are the provider's own, NOT repo-namespaced — the same contract
     * `getCommitDiff` returns, so a consumer namespaces both identically. Treat the array
     * and its entries as READ-ONLY: it is the provider's own array, handed over by
     * reference rather than copied, so a consumer that normalizes must map to new objects
     * (as `fetchProviderData` does when namespacing).
     */
    diffs?: GitFileDiff[];
}

export interface GitPR {
    id: string;
    title: string;
    author: GitAuthor;
    state: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    /**
     * The instant this PR was last touched (github `updated_at`, bitbucket
     * `updated_on`, gitlab `updated_at`) — the field all three providers list and
     * page PRs by. Required: every provider's list payload always carries it, so this
     * is guaranteed, not best-effort. `fetchProviderData` keys the catch-up-window
     * bound off it to defer the per-PR review fan-out for PRs updated after the run's
     * `until` (#247); see `prWithinFetchWindow` for the losslessness argument.
     */
    updatedAt: string;
    reviewers: GitAuthor[];
    additions: number;
    deletions: number;
}

export interface GitReviewComment {
    author: GitAuthor;
    body: string;
    createdAt: string;
    prId: string;
}

/**
 * Normalized review verdict states across providers:
 *   - GitHub: PR review states APPROVED / CHANGES_REQUESTED
 *   - Bitbucket: activity entries with `approval` / `changes_requested`
 *   - GitLab: system notes "approved this merge request" / "requested changes"
 * Only explicit verdicts are events — comment-level review activity is
 * deliberately excluded on every provider (it is covered by
 * getReviewComments), so the event stream is provider-equivalent.
 */
export type GitReviewState = 'approved' | 'changes_requested';

export interface GitPRReview {
    author: GitAuthor;
    state: GitReviewState;
    submittedAt: string;
    prId: string;
}

export interface GitFileDiff {
    path: string;
    additions: number;
    deletions: number;
    status: string;
}

/**
 * One commit's cached diffstat — everything the per-commit fetch produces that the sync
 * pipeline consumes (#273).
 *
 * `additions`/`deletions` are the COMMIT-LEVEL totals the provider reported and are NOT a
 * sum of `entries`: GitHub takes them from the commit's `stats` while truncating `files` at
 * 300, so re-deriving them would under-report exactly the largest GitHub commits. Store and
 * read both; never recompute one from the other.
 *
 * `absent` marks the deterministic 404 case — the provider says no diffstat exists for this
 * commit (Bitbucket merge commits, GitLab initial commits). It is a real answer and must be
 * cached, or those commits are re-asked on every run forever. It is deliberately distinct
 * from "this commit touched no files", even though both yield an identical zero-stat commit
 * downstream: when `absent` is true, `entries` is `[]` and both totals are 0.
 */
export interface CommitDiffstat {
    additions: number;
    deletions: number;
    entries: GitFileDiff[];
    absent: boolean;
}

/**
 * The persistent per-commit diffstat cache a provider consults instead of re-fetching (#273).
 *
 * A commit's diffstat is IMMUTABLE — `(repo, sha) -> file stats` is a property of an object
 * named by the hash of its own content — so there is no staleness, no invalidation, and no
 * integrity concern. The cache sits strictly UPSTREAM of the accumulator: it changes nothing
 * about cursor semantics, #231's drop-partials rule, or the additive-merge proof. Its whole
 * purpose is that a run which dies at commit 4,900 of 5,000 keeps those 4,899 fetches.
 *
 * Declared HERE, next to the provider interface, rather than beside its SQLite implementation
 * (`../diffstat-cache.ts`): the providers are plain HTTP clients with no database dependency,
 * and this keeps it that way — they depend on a two-method interface, and the sync pipeline
 * supplies the DB-backed one. It is also what makes a counting fake trivial in tests.
 *
 * Scoped to ONE `(providerType, container)` by construction, so a provider never passes — and
 * can never get wrong — the attribution half of the key.
 *
 * IMPLEMENTATIONS MUST NEVER CACHE A FAILURE. Only a successful response or a deterministic
 * 404 may be `put`; a 5xx, a rate limit or a transport fault is a statement about the server,
 * not about the commit, and caching one would make an outage permanent.
 */
export interface CommitDiffstatCache {
    /**
     * Every cached diffstat among `shas`, keyed by sha — resolved in ONE query (chunked), not
     * one per commit. Callers load the repo's whole set before their per-commit loop and do
     * in-memory lookups inside it. Missing/undecodable rows are simply absent from the map,
     * which reads as a MISS and re-fetches.
     */
    load(repo: string, shas: readonly string[]): Map<string, CommitDiffstat>;
    /**
     * Record one commit's diffstat, immediately and durably — outside any run-level
     * transaction. That is the ratchet: the row must survive a run that later fails and drops
     * every partial result. Idempotent (upsert): re-recording the same immutable fact is a
     * no-op in effect.
     */
    put(repo: string, sha: string, value: CommitDiffstat): void;
}

/**
 * How far a long-running provider fetch has advanced (#270).
 *
 * `total` is null while a list endpoint is still paging in — the size of the result
 * set genuinely is not knowable until the last page arrives — and `done` then reads
 * as "rows seen so far". Once the set is in hand `total` is real and the pair reads
 * as done-out-of-total.
 *
 * Those are the same SEMANTICS `GitSyncProgress.repo_step_done`/`repo_step_total`
 * carry on the wire (the sync loop renames the fields but does not reinterpret them),
 * which is why neither side needs a percentage or ETA: see the invariants documented
 * on `GitSyncProgress.repo_step`.
 */
export interface GitFetchProgress {
    done: number;
    total: number | null;
}

/**
 * Optional progress listener a caller may hand to the provider calls that do
 * unbounded network work. Always invoked through `?.()` with an inline argument,
 * so on a path that supplies no listener (the scheduled sync, `toprope doctor`)
 * neither the call nor the argument object is ever constructed — optional-call
 * short-circuiting does not evaluate its arguments.
 */
export type GitFetchProgressListener = (progress: GitFetchProgress) => void;

/**
 * One commit a provider LISTED but cannot return (#275).
 *
 * This is not a fetch failure and must never be reported as one. A fetch failure is
 * RECOVERABLE — it propagates out of `getCommits`, so #231 holds the provider's cursor and
 * the whole window is re-covered next run. A drop reported here is the opposite: the commit
 * WAS fetched and the response is simply unusable for attribution, so re-covering the window
 * would produce the identical unusable response forever. Holding the cursor for it would
 * brick the provider permanently rather than heal anything, which is why the two travel by
 * different channels (a throw vs. this listener) instead of one shared "incomplete" flag.
 *
 * The loss is therefore PERMANENT, which is exactly why it has to be said out loud: before
 * #275 such a commit vanished with nothing in `errors[]`, no trace in the sync log, and a
 * cursor already advanced past it.
 */
export interface GitCommitDrop {
    /** The sha as it appeared in the provider's own commit list. */
    sha: string;
    /**
     * Why the commit is unusable, in words an operator can act on. Provider-authored and
     * always a module-level constant on the provider (never interpolated from a response),
     * because it is pushed verbatim into `SyncResult.errors` and rendered in the admin UI.
     */
    reason: string;
}

/**
 * Optional sink for {@link GitCommitDrop}s, handed to `getCommits` alongside the progress
 * listener and invoked through `?.()` the same way — a caller that supplies none pays
 * nothing, and the argument object is never even constructed.
 *
 * Per-commit rather than a returned count so the caller can name the affected shas; the
 * caller aggregates to one line per repo (a systemic shape problem hits thousands of commits,
 * and an `errors` list that long is unreadable in the sync log and the admin UI alike).
 */
export type GitCommitDropListener = (drop: GitCommitDrop) => void;

export interface GitProvider {
    name: GitProviderType;
    listRepos(): Promise<GitRepo[]>;
    // `onProgress` (optional) is called as the commit list pages in and again per
    // commit during the per-commit detail/diff fan-out. Both are unbounded network
    // work — without it the whole call is one opaque await and an observer's
    // counter jumps 0 → N only when the repo is finished (#270).
    //
    // An implementation that fetches per-commit diff data while building its result MUST
    // also expose it on `GitCommit.diffs`, so the caller reuses that one fetch instead of
    // walking the same endpoint again per commit (#271).
    //
    // `onDrop` (optional) is the ONLY way an implementation may return fewer commits than it
    // listed (#275). Returning a short list silently is forbidden: the caller reads a normal
    // return as "this window is fully covered" and advances the provider's cursor past it
    // (#231), so an unreported drop is a permanent, invisible hole in `git_snapshots`. An
    // implementation that cannot use a listed commit must report it here; one that can retry
    // must THROW instead, so the fault reaches the in-run repo retry and then #231's cursor
    // hold. Bitbucket's in-memory `until` filter is neither — a commit outside the requested
    // window was never in this call's result set to begin with (#276).
    getCommits(
        repo: string,
        since: string,
        until: string,
        onProgress?: GitFetchProgressListener,
        onDrop?: GitCommitDropListener,
    ): Promise<GitCommit[]>;
    // `onProgress` (optional) reports the PR list paging in. The per-PR
    // comment/review fan-out lives in the sync loop, which reports that itself.
    getPullRequests(
        repo: string,
        state: string,
        since: string,
        onProgress?: GitFetchProgressListener,
    ): Promise<GitPR[]>;
    getReviewComments(repo: string, prId: string): Promise<GitReviewComment[]>;
    // Normalized review verdict events (approved / changes_requested /
    // commented) for one PR, in submission order. Task 5.2 uses these to count
    // review rounds and send-backs identically across providers.
    getPRReviews(repo: string, prId: string): Promise<GitPRReview[]>;
    // One commit's file-level diff. Since #271 the sync loop only calls this as a
    // FALLBACK, for a commit whose `GitCommit.diffs` is `undefined` — it stays on the
    // interface for that fallback and for callers holding only a sha.
    getCommitDiff(repo: string, commitSha: string): Promise<GitFileDiff[]>;
    // Cheap reachability/auth probe — fetches a single page, resolves on success
    // and throws on auth/network failure. Used by `toprope doctor` to validate
    // a provider without enumerating every repo.
    checkAccess(): Promise<void>;
}

// Provider-specific auth configs

export interface GitHubTokenAuth {
    type: 'token';
    api_token: string;
}

export interface GitHubProviderConfig {
    type: 'github';
    org: string;
    auth: GitHubTokenAuth;
    repos?: string[];
    exclude_repos?: string[];
}

export interface BitbucketAppPasswordAuth {
    type: 'app_password';
    username: string;
    app_password: string;
}

export interface BitbucketAccessTokenAuth {
    type: 'access_token';
    token: string;
}

export interface BitbucketOAuthAuth {
    type: 'oauth';
    token: string;
}

export type BitbucketAuth =
    | BitbucketAppPasswordAuth
    | BitbucketAccessTokenAuth
    | BitbucketOAuthAuth;

export interface BitbucketProviderConfig {
    type: 'bitbucket';
    workspace: string;
    auth: BitbucketAuth;
    repos?: string[];
    exclude_repos?: string[];
}

export interface GitLabPersonalAccessTokenAuth {
    type: 'personal_access_token';
    token: string;
}

export interface GitLabOAuthAuth {
    type: 'oauth';
    token: string;
}

export interface GitLabJobTokenAuth {
    type: 'job_token';
    token: string;
}

export type GitLabAuth =
    | GitLabPersonalAccessTokenAuth
    | GitLabOAuthAuth
    | GitLabJobTokenAuth;

export interface GitLabProviderConfig {
    type: 'gitlab';
    group: string;
    url?: string;
    auth: GitLabAuth;
    repos?: string[];
    include_subgroups?: boolean;
}

export type GitProviderConfig =
    | GitHubProviderConfig
    | BitbucketProviderConfig
    | GitLabProviderConfig;
