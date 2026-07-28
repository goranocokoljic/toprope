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
    filesChanged: string[];
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
 * How far a long-running provider fetch has advanced (#270). Discriminated on
 * `phase` rather than passed as a bare `(done, total)` pair because the two
 * phases answer different questions and only one of them can know a total:
 *
 *   - `listing`  — paging a list endpoint. The size of the result set is genuinely
 *                  unknown until the last page arrives, so a running discovered
 *                  count is the only honest signal (the issue's non-goal: never
 *                  display a percentage the pipeline cannot compute).
 *   - `fetching` — the O(N) per-item detail fan-out over a now-known set, where
 *                  `done`/`total` is real.
 *
 * Collapsing both into one nullable-total pair would overload `done` to mean
 * "discovered" in one phase and "completed" in the other; the caller would have
 * to infer which from the total being null.
 */
export type GitFetchProgress =
    | {phase: 'listing'; discovered: number}
    | {phase: 'fetching'; done: number; total: number};

/**
 * Optional progress listener a caller may hand to the provider calls that do
 * unbounded network work. Always invoked through `?.()` with an inline argument,
 * so on a path that supplies no listener (the scheduled sync, `toprope doctor`)
 * neither the call nor the argument object is ever constructed — optional-call
 * short-circuiting does not evaluate its arguments.
 */
export type GitFetchProgressListener = (progress: GitFetchProgress) => void;

export interface GitProvider {
    name: GitProviderType;
    listRepos(): Promise<GitRepo[]>;
    // `onProgress` (optional) is called as the commit list pages in and again per
    // commit during the per-commit detail/diff fan-out. Both are unbounded network
    // work — without it the whole call is one opaque await and an observer's
    // counter jumps 0 → N only when the repo is finished (#270).
    getCommits(
        repo: string,
        since: string,
        until: string,
        onProgress?: GitFetchProgressListener,
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
