-- Task 5.5 (#126): Key Management & Recovery — the developer owns the key to
-- their encrypted captures (Pillar 3), and owns (and can audit) their recovery.
--
-- Two tables, both deliberately holding NO key material the server could use to
-- decrypt a developer's captures:
--
--   capture_keys      — per-developer key METADATA + recovery posture. `key_id`
--                       is a REFERENCE (the same id stored in a capture's
--                       encryption_meta), never the AES key. `recovery_blob` is,
--                       for the recovery_path choice, the developer's capture key
--                       WRAPPED client-side by a key derived from a recovery
--                       secret only the developer holds — so the server stores an
--                       opaque blob it cannot unwrap. For no_recovery it is NULL:
--                       nothing recoverable is stored, by design.
--
--   key_recovery_log  — an append-only audit of EVERY recovery action. The only
--                       code path that writes here always sets
--                       visible_to_developer = 1, and the developer's own view
--                       reads it back — so a recovery flow can never be used
--                       silently. The developer can audit whether their recovery
--                       was ever used, and by whom.
--
-- The server-can-never-decrypt invariant is structural: no column here holds the
-- plaintext capture key or a recovery secret, and there is no admin/manager path
-- to either table (all access is developer-scoped under /api/me). For no_recovery
-- there is additionally no recovery material at all.

CREATE TABLE capture_keys (
    -- One key record per developer. CASCADE so the key metadata + any wrapped
    -- recovery blob die with the developer record (matching prompt_captures and
    -- every sibling FK that declares its intent), leaving no orphaned material.
    developer_id TEXT PRIMARY KEY REFERENCES developers(id) ON DELETE CASCADE,
    -- Identifier for the key the developer encrypts captures with — the SAME
    -- value carried in each capture's encryption_meta.key_id. NOT the key bytes.
    key_id TEXT NOT NULL,
    -- The developer's informed recovery posture, chosen at opt-in.
    recovery_choice TEXT NOT NULL CHECK (recovery_choice IN ('no_recovery', 'recovery_path')),
    -- recovery_path ONLY: the capture key wrapped (AES-256-GCM) by a key derived
    -- client-side from the developer's recovery secret. Opaque to the server,
    -- which holds neither the secret nor the derived wrapping key. NULL for
    -- no_recovery — a CHECK enforces the two postures can't be mixed up:
    --   no_recovery   => recovery_blob IS NULL  (nothing recoverable stored)
    --   recovery_path => recovery_blob IS NOT NULL
    recovery_blob BLOB,
    -- JSON: the public KDF/cipher parameters (salt, iv, auth_tag, algo, kdf) the
    -- client needs to re-derive the wrapping key and unwrap WITH the recovery
    -- secret. Never the secret, never the wrapping key. NULL for no_recovery.
    recovery_meta TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (recovery_choice = 'no_recovery' AND recovery_blob IS NULL AND recovery_meta IS NULL)
        OR
        (recovery_choice = 'recovery_path' AND recovery_blob IS NOT NULL AND recovery_meta IS NOT NULL)
    )
);

CREATE TABLE key_recovery_log (
    id TEXT PRIMARY KEY,
    -- CASCADE: the audit dies with the developer (no cross-developer retention).
    developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    -- The lifecycle of one recovery attempt. initiated is written when a recovery
    -- is started (and the wrapped blob handed back to the client); completed /
    -- failed when the client reports the unwrap outcome.
    event TEXT NOT NULL CHECK (event IN ('recovery_initiated', 'recovery_completed', 'recovery_failed')),
    -- Who triggered it — recorded so the developer can see a recovery was theirs
    -- (no anonymous/silent actor). Recovery is developer-initiated under their own
    -- session, so this is their own id.
    initiated_by TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    -- Always 1 on the write path: every recovery event is visible to the
    -- developer. The column exists so the developer view can filter on it and the
    -- invariant ("no hidden recovery") is enforced in the schema, not just code.
    visible_to_developer INTEGER NOT NULL DEFAULT 1 CHECK (visible_to_developer IN (0, 1))
);

-- The developer's recovery-log view is "my recovery events, newest first",
-- filtered to visible_to_developer = 1 — so the index leads with both columns the
-- read predicate uses before ordering on occurred_at.
CREATE INDEX idx_key_recovery_log_dev_visible_time
    ON key_recovery_log(developer_id, visible_to_developer, occurred_at);
