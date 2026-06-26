# GovProxy — Additional Tasks: Multi-Provider Git Connectors

**Bitbucket + GitLab Support for Git Repository Analysis**

These tasks modify Task 1.7 (Git Repository Analysis) to support GitHub, Bitbucket, and GitLab from day one. Since WMG uses Bitbucket, this is essential for dogfooding.

---

## Architecture Change

The original Task 1.7 assumed GitHub REST API only. The updated design introduces a git provider abstraction layer so the analyzer, churn calculator, and AI signature scorer work identically regardless of which git provider hosts the repos.

```
src/connectors/git/
├── providers/
│   ├── types.ts              # GitProvider interface (shared contract)
│   ├── github.ts             # GitHub REST API implementation
│   ├── bitbucket.ts          # Bitbucket Cloud REST API 2.0 implementation
│   ├── gitlab.ts             # GitLab REST API v4 implementation
│   └── factory.ts            # Creates correct provider from config
├── analyzer.ts               # Commit pattern analysis (provider-agnostic)
├── churn.ts                  # Code churn calculation (provider-agnostic)
├── ai-signature.ts           # AI signature scoring (provider-agnostic)
└── sync.ts                   # Sync job (uses GitProvider interface)
```

The GitProvider interface normalizes the data from each platform into a common format. The analyzer, churn calculator, and AI signature scorer never know which provider the data came from.

---

## Updated Configuration

```yaml
connectors:
  git:
    enabled: true
    providers:
      - type: "bitbucket"                    # bitbucket|github|gitlab
        workspace: "wmg-workspace"           # Bitbucket workspace slug
        auth:
          type: "app_password"               # app_password|access_token|oauth
          username: "${BITBUCKET_USERNAME}"
          app_password: "${BITBUCKET_APP_PASSWORD}"
        repos: []                            # empty = all workspace repos
        exclude_repos: ["archived-*"]        # glob patterns to exclude

      - type: "github"
        org: "wmg-oss"
        auth:
          type: "token"
          api_token: "${GITHUB_API_TOKEN}"
        repos: []

      - type: "gitlab"
        group: "wmg-group"                   # GitLab group/namespace
        url: "https://gitlab.com"            # or self-managed URL
        auth:
          type: "personal_access_token"      # personal_access_token|oauth|job_token
          token: "${GITLAB_API_TOKEN}"
        repos: []
        include_subgroups: true

    sync_interval: "daily"
    sync_time: "03:30"
    analysis:
      churn_window_hours: 48
      ai_signature_enabled: true
```

Key design decisions:
- Multiple providers can be configured simultaneously (WMG might have Bitbucket for main repos + GitHub for open source)
- Each provider has its own auth config since auth mechanisms differ significantly
- Repo filtering works the same across all providers (include list, exclude patterns)

---

## Task 1.7a: Git Provider Abstraction Layer

**Branch:** `task/1.7a-git-provider-interface`
**Estimate:** Day 10–11
**Depends on:** 1.3

### GitHub Issue Description

```
## Task 1.7a: Git Provider Abstraction Layer

Create a provider-agnostic interface for git data that GitHub, Bitbucket,
and GitLab implementations conform to. The analysis layer (churn, AI
signatures, commit metrics) operates on this normalized data.

### Deliverables

- [ ] GitProvider interface (src/connectors/git/providers/types.ts)
  Defines the contract every provider must implement:
  ```typescript
  interface GitProvider {
    name: string;                          // "github" | "bitbucket" | "gitlab"

    // Discovery
    listRepos(): Promise<GitRepo[]>;

    // Commit data
    getCommits(repo: string, since: string, until: string): Promise<GitCommit[]>;

    // PR / Merge Request data
    getPullRequests(repo: string, state: string, since: string): Promise<GitPR[]>;

    // Review / Comment data
    getReviewComments(repo: string, prId: string): Promise<GitReviewComment[]>;

    // File-level diff for churn analysis
    getCommitDiff(repo: string, commitSha: string): Promise<GitFileDiff[]>;
  }

  interface GitRepo {
    id: string;
    name: string;
    fullName: string;                      // "workspace/repo" or "org/repo"
    defaultBranch: string;
    isArchived: boolean;
  }

  interface GitCommit {
    sha: string;
    author: GitAuthor;
    date: string;                          // ISO 8601
    message: string;
    additions: number;
    deletions: number;
    filesChanged: string[];                // file paths
  }

  interface GitAuthor {
    name: string;
    email: string;
    username: string;                      // platform username
  }

  interface GitPR {
    id: string;
    title: string;
    author: GitAuthor;
    state: string;                         // open|merged|declined|closed
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    reviewers: GitAuthor[];
    additions: number;
    deletions: number;
  }

  interface GitReviewComment {
    author: GitAuthor;
    body: string;
    createdAt: string;
    prId: string;
  }

  interface GitFileDiff {
    path: string;
    additions: number;
    deletions: number;
    status: string;                        // added|modified|deleted|renamed
  }
  ```

- [ ] Provider factory (src/connectors/git/providers/factory.ts)
  - Takes provider config, returns correct GitProvider instance
  - Validates auth config per provider type
  - Throws clear error for unsupported provider type

### Acceptance Criteria

- [ ] Interface types are exported and compile without errors
- [ ] Factory creates correct provider instance based on config type
- [ ] Factory throws descriptive error for invalid provider type
- [ ] Factory validates required auth fields per provider (e.g., Bitbucket needs username + app_password)
- [ ] Interface is expressive enough for all three platforms (no platform-specific leaks)
- [ ] Unit tests for factory with all three provider types + invalid type
```

---

## Task 1.7b: GitHub Provider Implementation

**Branch:** `task/1.7b-github-provider`
**Estimate:** Day 11–12
**Depends on:** 1.7a

### GitHub Issue Description

```
## Task 1.7b: GitHub Provider Implementation

Implement the GitProvider interface for GitHub using the REST API v3.

### API Reference

- Base URL: https://api.github.com
- Auth: `Authorization: Bearer <token>`
- Rate limit: 5,000 requests/hour (authenticated)
- Pagination: Link header based

### Deliverables

- [ ] GitHub provider (src/connectors/git/providers/github.ts)
  - `listRepos()` → GET /orgs/{org}/repos (handles pagination)
  - `getCommits()` → GET /repos/{owner}/{repo}/commits?since=&until= (per-commit stats)
  - `getPullRequests()` → GET /repos/{owner}/{repo}/pulls?state=&since=
  - `getReviewComments()` → GET /repos/{owner}/{repo}/pulls/{number}/comments
  - `getCommitDiff()` → GET /repos/{owner}/{repo}/commits/{sha} (files array)
- [ ] Rate limit handling: read X-RateLimit-Remaining header, pause when low
- [ ] Pagination: follow Link header for all paginated endpoints
- [ ] Author mapping: extract login (username), name, email from commit/PR data
- [ ] Repo filtering: apply include/exclude patterns from config

### Acceptance Criteria

- [ ] All GitProvider interface methods implemented and return correctly typed data
- [ ] Pagination: correctly fetches all pages for repos with 100+ commits
- [ ] Rate limiting: pauses and resumes when approaching limit
- [ ] Author data: username, name, and email correctly extracted
- [ ] Archived repos excluded by default
- [ ] Repo filtering: include list and exclude glob patterns work
- [ ] Empty repos handled gracefully (empty arrays, no errors)
- [ ] Unit tests with fixture data for each endpoint
- [ ] Integration test: full flow from listRepos → getCommits → getCommitDiff
```

---

## Task 1.7c: Bitbucket Provider Implementation

**Branch:** `task/1.7c-bitbucket-provider`
**Estimate:** Day 12–14
**Depends on:** 1.7a

### GitHub Issue Description

```
## Task 1.7c: Bitbucket Provider Implementation

Implement the GitProvider interface for Bitbucket Cloud using REST API 2.0.
This is the priority provider since WMG uses Bitbucket.

### API Reference

- Base URL: https://api.bitbucket.org/2.0
- Auth options:
  - App password: Basic auth with username:app_password
  - Access token: `Authorization: Bearer <token>`
  - OAuth 2.0: client credentials flow
- Rate limit: 1,000 requests/hour (varies by auth type)
- Pagination: `next` URL in response body (not Link header)

### Key API Differences from GitHub

- Repos: GET /repositories/{workspace}?role=member
- Commits: GET /repositories/{workspace}/{repo_slug}/commits
  - Diffstat for file-level changes: GET /repositories/{workspace}/{repo_slug}/diffstat/{spec}
- PRs: GET /repositories/{workspace}/{repo_slug}/pullrequests
  - Bitbucket calls them "pull requests" (same as GitHub)
  - States: OPEN, MERGED, DECLINED, SUPERSEDED
- Reviews: GET /repositories/{workspace}/{repo_slug}/pullrequests/{id}/comments
  - Comments include "inline" field for code review comments vs general comments
- Author identification:
  - Commits use "raw" author string: "Name <email>"
  - PRs use account UUID or nickname
  - Must normalize both to GitAuthor format

### Deliverables

- [ ] Bitbucket provider (src/connectors/git/providers/bitbucket.ts)
  - `listRepos()` → GET /repositories/{workspace}
    - Filter by role=member to only get repos user has access to
    - Handle workspace vs project organization
  - `getCommits()` → GET /repositories/{workspace}/{repo_slug}/commits
    - Parse "raw" author string into name + email
    - Get per-commit additions/deletions via diffstat endpoint
  - `getPullRequests()` → GET /repositories/{workspace}/{repo_slug}/pullrequests
    - Map Bitbucket states (OPEN, MERGED, DECLINED) to normalized states
    - Extract merge timestamp from merge_commit if available
  - `getReviewComments()` → GET /.../pullrequests/{id}/comments
    - Filter inline comments (actual code review) from general comments
  - `getCommitDiff()` → GET /repositories/{workspace}/{repo_slug}/diffstat/{sha}
    - Returns per-file additions/deletions/status
- [ ] Auth support for all three methods: app_password, access_token, oauth
- [ ] Pagination: follow `next` URL in response body
- [ ] Rate limit handling: respect 429 responses with Retry-After header
- [ ] Workspace auto-detection from config

### Acceptance Criteria

- [ ] All GitProvider interface methods return correctly typed data
- [ ] App password auth works: Basic auth with username:app_password
- [ ] Access token auth works: Bearer token in header
- [ ] Pagination: follows `next` URL correctly, handles final page (no next)
- [ ] Rate limiting: handles 429 with Retry-After, retries after delay
- [ ] Author parsing: "Goran <goran@wmg.rs>" correctly splits into name + email
- [ ] Author mapping: Bitbucket account UUIDs/nicknames mapped to GitAuthor
- [ ] PR states correctly normalized: MERGED → merged, DECLINED → closed, OPEN → open
- [ ] Diffstat correctly returns per-file additions/deletions
- [ ] Repo filtering works with workspace slug format
- [ ] Archived/read-only repos excluded
- [ ] Empty workspace handled (no repos → empty array)
- [ ] Unit tests with Bitbucket-specific fixture data
- [ ] Integration test: full flow with realistic Bitbucket API response fixtures
```

---

## Task 1.7d: GitLab Provider Implementation

**Branch:** `task/1.7d-gitlab-provider`
**Estimate:** Day 14–16 (can overlap with other tasks)
**Depends on:** 1.7a

### GitHub Issue Description

```
## Task 1.7d: GitLab Provider Implementation

Implement the GitProvider interface for GitLab using REST API v4.
Supports both GitLab.com (SaaS) and self-managed instances.

### API Reference

- Base URL: https://gitlab.com/api/v4 (or self-managed: https://gitlab.example.com/api/v4)
- Auth options:
  - Personal access token: `PRIVATE-TOKEN: <token>` header
  - OAuth 2.0: `Authorization: Bearer <token>`
  - Job token: `JOB-TOKEN: <token>` (CI/CD context)
- Rate limit: varies by instance (gitlab.com: authenticated ~2,000/min)
- Pagination: X-Total, X-Page headers + Link header

### Key API Differences from GitHub

- Repos are called "Projects": GET /groups/{group}/projects
- Commits: GET /projects/{id}/repository/commits
  - Diff for file-level: GET /projects/{id}/repository/commits/{sha}/diff
- PRs are called "Merge Requests": GET /projects/{id}/merge_requests
  - States: opened, closed, merged, locked
- Reviews: GET /projects/{id}/merge_requests/{iid}/notes
  - "Notes" = comments. Type "DiffNote" = code review comment
- Author identification:
  - Commits return author_name, author_email
  - MRs return author object with username, name, email
- Projects identified by numeric ID or URL-encoded path (group%2Fproject)
- Subgroups: GitLab has nested group hierarchy

### Deliverables

- [ ] GitLab provider (src/connectors/git/providers/gitlab.ts)
  - `listRepos()` → GET /groups/{group}/projects
    - Support include_subgroups=true for nested groups
    - URL-encode group path for API calls
    - Handle both SaaS and self-managed base URLs
  - `getCommits()` → GET /projects/{id}/repository/commits
    - Extract author_name, author_email directly (cleaner than Bitbucket)
    - Get per-commit diff via /commits/{sha}/diff endpoint
    - Calculate additions/deletions from diff hunks
  - `getPullRequests()` → GET /projects/{id}/merge_requests
    - Map GitLab states (opened, merged, closed) to normalized states
    - Extract merged_at timestamp
  - `getReviewComments()` → GET /projects/{id}/merge_requests/{iid}/notes
    - Filter to type=DiffNote for actual code review comments
    - Exclude system-generated notes (label changes, assignments)
  - `getCommitDiff()` → GET /projects/{id}/repository/commits/{sha}/diff
    - Parse diff hunks to count additions/deletions per file
    - Map diff status (new, modified, deleted, renamed)
- [ ] Self-managed instance support: configurable base URL
- [ ] Auth support: personal_access_token, oauth, job_token
- [ ] Pagination: use X-Total header + page parameter
- [ ] Rate limit handling: respect RateLimit-Remaining header and 429 responses
- [ ] Subgroup traversal when include_subgroups=true

### Acceptance Criteria

- [ ] All GitProvider interface methods return correctly typed data
- [ ] Personal access token auth works via PRIVATE-TOKEN header
- [ ] OAuth token auth works via Authorization: Bearer header
- [ ] Self-managed GitLab URL configuration works (non-gitlab.com instances)
- [ ] Subgroup projects discovered when include_subgroups=true
- [ ] URL-encoded paths work for groups with slashes (group/subgroup)
- [ ] Pagination handles X-Total + page parameter correctly
- [ ] Rate limiting: handles 429 with Retry-After
- [ ] MR states correctly normalized: opened → open, merged → merged, closed → closed
- [ ] DiffNote vs regular Note filtering works (only code review comments counted)
- [ ] System-generated notes excluded (label/assignment changes)
- [ ] Diff hunks correctly parsed into additions/deletions per file
- [ ] Archived projects excluded
- [ ] Empty group handled (no projects → empty array)
- [ ] Unit tests with GitLab-specific fixture data
- [ ] Works identically whether talking to gitlab.com or self-managed instance
```

---

## Task 1.7e: Git Analysis Engine (Provider-Agnostic)

**Branch:** `task/1.7e-git-analysis-engine`
**Estimate:** Day 16–18
**Depends on:** 1.7a, at least one of 1.7b/1.7c/1.7d

### GitHub Issue Description

```
## Task 1.7e: Git Analysis Engine (Provider-Agnostic)

The analysis layer that operates on normalized GitProvider data.
Calculates all git metrics regardless of which provider the data came from.
This replaces the original Task 1.7 analysis code.

### Deliverables

- [ ] Commit analyzer (src/connectors/git/analyzer.ts)
  - Input: GitCommit[] from any provider
  - Aggregate per-developer per-day: commits, lines added/removed, files changed
  - PR metrics: opened, merged, review comments given, avg time-to-merge
- [ ] Code churn calculator (src/connectors/git/churn.ts)
  - Input: GitCommit[] + GitFileDiff[] from any provider
  - For each file changed, check if same file changed again within window
  - Churn rate = lines re-changed / total lines changed
  - Configurable window (default: 48 hours)
- [ ] AI signature scorer (src/connectors/git/ai-signature.ts)
  - Input: GitCommit[] + GitFileDiff[] from any provider
  - Heuristic scoring (0-100), conservative
  - Signals: large commits with consistent formatting, bulk error handling,
    multiple new boilerplate files, comprehensive test generation
  - Score explicitly labeled as "estimated"
- [ ] Commit burst detector
  - 3+ commits within 30 minutes by same author
- [ ] Sync orchestrator (src/connectors/git/sync.ts)
  - Reads provider configs (supports multiple providers simultaneously)
  - For each provider: create instance via factory, fetch data, run analysis
  - Store results as git_snapshots (one row per developer per day)
  - Track sync state per provider independently
  - CLI: `govproxy sync git` runs all configured providers
  - CLI: `govproxy sync git --provider bitbucket` runs single provider
- [ ] Developer mapping
  - Match git authors (email/username) to developer_id via external_ids
  - Handle multiple email addresses per developer
  - Flag unmatched authors for manual mapping

### Acceptance Criteria

- [ ] Analysis produces identical git_snapshots from equivalent GitHub, Bitbucket, and GitLab data
- [ ] Churn rate calculated correctly regardless of provider
- [ ] AI signature score consistent across providers for same commit patterns
- [ ] Commit bursts detected correctly across providers
- [ ] Multi-provider sync: Bitbucket repos + GitHub repos analyzed in same run
- [ ] Per-provider sync state tracked independently
- [ ] `govproxy sync git --provider bitbucket` only syncs Bitbucket
- [ ] `govproxy sync git` syncs all configured providers
- [ ] Developer mapping works with email matching across providers
- [ ] Unmatched authors flagged but don't block analysis
- [ ] git_snapshots have correct data_source per provider
- [ ] No duplicates when same developer commits to repos on different providers
- [ ] Unit tests: run same analysis fixtures through all three providers, verify identical output
```

---

## Updated Task Dependencies

```
Original Task 1.7 is now split into:

1.7a  Git Provider Interface           (Day 10-11)   depends on: 1.3
1.7b  GitHub Provider                  (Day 11-12)   depends on: 1.7a
1.7c  Bitbucket Provider (PRIORITY)    (Day 12-14)   depends on: 1.7a
1.7d  GitLab Provider                  (Day 14-16)   depends on: 1.7a
1.7e  Git Analysis Engine              (Day 16-18)   depends on: 1.7a + at least one provider

Note: 1.7b, 1.7c, and 1.7d can be developed in parallel since they
only depend on 1.7a (the interface), not on each other.

Recommended order: 1.7a → 1.7c (Bitbucket, since WMG uses it) → 1.7b (GitHub) → 1.7d (GitLab) → 1.7e
```

---

## Updated Timeline Impact

The original Task 1.7 was estimated at Day 10–14 (5 days). The expanded multi-provider version is Day 10–18 (9 days). This adds approximately 4 days to Phase 1, extending it from 4 weeks to ~5 weeks. The remaining tasks (1.8–1.12) shift accordingly:

| Task | Original | Updated |
|---|---|---|
| 1.7a Git Provider Interface | — | Day 10–11 |
| 1.7b GitHub Provider | Day 10–14 (combined) | Day 11–12 |
| 1.7c Bitbucket Provider | — | Day 12–14 |
| 1.7d GitLab Provider | — | Day 14–16 |
| 1.7e Git Analysis Engine | — | Day 16–18 |
| 1.8 Expense Import | Day 14–16 | Day 18–20 |
| 1.9 API Endpoints | Day 16–18 | Day 20–22 |
| 1.10 Waste Detection | Day 18–20 | Day 22–24 |
| 1.11 CLI Doctor | Day 20–21 | Day 24–25 |
| 1.12 Sync Pipeline | Day 21–22 | Day 25–26 |

**Phase 1 total: ~5 weeks instead of 4 weeks.** All subsequent phases shift by 1 week.

---

## Updated CLI Commands

```bash
# Git sync — all providers
govproxy sync git

# Git sync — single provider
govproxy sync git --provider bitbucket
govproxy sync git --provider github
govproxy sync git --provider gitlab

# Developer git identity mapping
govproxy dev link --id <dev-id> --git-email "goran@wmg.rs" --git-email "goran@personal.com"
```

---

## Updated Doctor Checks

```
govproxy doctor output (git section):

Git Providers:
  ✓ Bitbucket: workspace 'wmg-workspace' accessible (23 repos)
  ✓ GitHub: org 'wmg-oss' accessible (5 repos)
  ✗ GitLab: token invalid — ensure token has 'read_api' scope
    Fix: Generate a new token at https://gitlab.com/-/user_settings/personal_access_tokens
         with scopes: read_api, read_repository
```

---

## Phase 1 Completion Checklist (Updated)

```
[ ] govproxy doctor — all checks pass (3 tool APIs + 3 git providers + database)
[ ] govproxy sync all — pulls data from all sources without errors
[ ] govproxy sync git — syncs from all configured git providers
[ ] govproxy sync git --provider bitbucket — syncs Bitbucket only
[ ] govproxy status — shows all git providers with last sync time
[ ] git_snapshots contain data from all configured providers
[ ] Same developer committing to Bitbucket + GitHub repos has unified git_snapshots
[ ] curl /api/overview — unified summary includes git data from all providers
[ ] npm test — all tests pass including provider-specific fixtures
```

---

*End of Document — Multi-Provider Git Connector Tasks*
