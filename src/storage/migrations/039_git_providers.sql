-- GC1.1 (#193): git_providers — the persistence spine for UI-connected git
-- providers (Epic GC1 / #192). One row per connected provider. A row decodes
-- losslessly back into the `GitProviderConfig` union the factory already
-- validates (see codec.ts); the token is stored encrypted-at-rest (GC1.2) and
-- is NEVER kept as plaintext.
--
-- Fail-closed at the schema edge too: `type`, `auth_method`, `last_sync_status`
-- and the two boolean columns carry CHECK constraints so a corrupt value can't
-- masquerade as a shape the codec/resolver trusts. The codec is the primary
-- fail-closed gate (typed error on unknown type/auth_method); these CHECKs are
-- defense-in-depth, matching the CHECK-heavy convention of the 037 schema.
--
-- IF NOT EXISTS makes re-running the migration a no-op (idempotent) even outside
-- the schema_migrations ledger.
CREATE TABLE IF NOT EXISTS git_providers (
    id TEXT PRIMARY KEY,                     -- uuid
    -- Provider family. Closed set, DB-enforced (github | bitbucket | gitlab).
    type TEXT NOT NULL CHECK (type IN ('github', 'bitbucket', 'gitlab')),
    -- The provider's top-level scope: org (github) / workspace (bitbucket) / group (gitlab).
    container TEXT NOT NULL,
    -- GitLab self-hosted base URL. Nullable (gitlab.com / other providers leave it NULL).
    url TEXT,
    -- GitLab-only recurse-into-subgroups flag. Nullable (not applicable elsewhere);
    -- when set it must be an honest 0/1 boolean.
    include_subgroups INTEGER CHECK (include_subgroups IN (0, 1)),
    -- Provider-specific auth method. Closed set across all three providers, DB-enforced.
    auth_method TEXT NOT NULL CHECK (
        auth_method IN (
            'token',                          -- github
            'app_password', 'access_token', 'oauth',  -- bitbucket
            'personal_access_token', 'job_token'      -- gitlab (oauth shared above)
        )
    ),
    -- Bitbucket app_password auth carries a username alongside the secret; NULL otherwise.
    auth_username TEXT,
    -- The encrypted secret (AES-256-GCM ciphertext, GC1.2). Never plaintext.
    token_ciphertext BLOB NOT NULL,
    -- JSON envelope for the ciphertext: {algo, iv, auth_tag, key_id}.
    token_meta TEXT NOT NULL,
    -- Last 4 chars of the plaintext secret, for masked display only.
    token_last4 TEXT,
    -- Repo scope. JSON string arrays; NULL repos_include = "monitor all" (NOT an empty list).
    repos_include TEXT,
    repos_exclude TEXT,
    -- Soft on/off without deleting the row. Honest 0/1 boolean.
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,                 -- UTC ISO
    updated_at TEXT NOT NULL,                 -- UTC ISO
    -- Audit: which user connected this provider. SET NULL so removing a user
    -- leaves the provider row intact rather than failing the delete.
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    last_sync_at TEXT,                        -- UTC ISO; NULL until first sync
    -- Last sync outcome. Closed set (ok | error | never), DB-enforced; NULL until first sync.
    last_sync_status TEXT CHECK (last_sync_status IN ('ok', 'error', 'never')),
    last_sync_error TEXT                      -- last error summary; NULL on success/never
);

-- The resolver looks providers up by (type, container) to de-dupe against
-- config-file providers (DB wins); index that access path.
CREATE INDEX IF NOT EXISTS idx_git_providers_type_container ON git_providers(type, container);
