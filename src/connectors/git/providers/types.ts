export type GitProviderType = 'github' | 'bitbucket' | 'gitlab';

export interface GitAuthor {
    name: string;
    email: string;
    username: string;
}

export interface GitRepo {
    id: string;
    name: string;
    fullName: string;
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
 *   - GitHub: PR review states APPROVED / CHANGES_REQUESTED / COMMENTED
 *   - Bitbucket: activity entries with `approval` / `changes_requested`
 *   - GitLab: system notes "approved this merge request" / "requested changes"
 * Anything that is review activity but not an explicit verdict maps to
 * 'commented'.
 */
export type GitReviewState = 'approved' | 'changes_requested' | 'commented';

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
    // and throws on auth/network failure. Used by `govproxy doctor` to validate
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
