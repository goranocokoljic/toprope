export type GitProviderType = 'github' | 'bitbucket' | 'gitlab';

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
     * The provider's human-readable repository name, for display only (#213):
     * Bitbucket/GitLab expose a display name distinct from the slug/path;
     * GitHub has no separate display name, so it equals `name` there. Never
     * used for filtering or API paths.
     */
    displayName: string;
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

export interface GitProvider {
    name: GitProviderType;
    listRepos(): Promise<GitRepo[]>;
    getCommits(repo: string, since: string, until: string): Promise<GitCommit[]>;
    getPullRequests(repo: string, state: string, since: string): Promise<GitPR[]>;
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
