# Toprope — Git Connection UI Task Tracker

**Feature: In-dashboard Git Provider Connection (GitHub + Bitbucket + GitLab)**

1 Epic + 10 dependency-ordered children | Design: `Git_Connection_UI_Design_Document.md`
| Source finding: #3 (no UI to connect git repos)

> Same epic-and-subtask format as the Phase trackers. The epic is the tracking
> parent carrying full context + cross-cutting acceptance criteria (written once);
> children are day-or-less, independently-testable, PR-per-unit work items that
> inherit the epic's context by reference and carry their own mechanical criteria.
>
> Two-level numbering: epic = `GC1`; children = `GC1.1`, `GC1.2`, … Feed the LEAF
> numbers into the dev-cycle-phases skill as executable units.
>
> GitHub: the epic is a parent issue with a checklist linking child issues; each
> child back-references the epic. The epic closes when all children are checked.

---

## Workflow Per Child Task

```
1. Open the child issue (context inherited from the epic)
2. Create branch: feature/issue-{n}-gc1-{short-slug}
3. Implement in Claude Code (reference the child's acceptance criteria)
4. Write tests alongside
5. npm test && npm run typecheck && npm run lint
6. PR referencing the child issue ("Closes #N"); check it off in the epic checklist
7. AI-assisted review → address → re-test (dev-cycle skill, max 3 iterations)
8. Merge (squash into develop; delete branch)
9. When all children checked, close the epic
```

## Build Order

```
GC1.1 (schema+codec) → GC1.2 (crypto) → GC1.3 (store) are the foundation; do in order.
GC1.4 (resolver merge) unblocks sync visibility and can land right after GC1.3.
GC1.5 (CRUD API) needs GC1.3. GC1.6 (test/repos API) + GC1.7 (sync-now) need GC1.5.
GC1.8 (UI list+form) needs GC1.5/GC1.6. GC1.9 (repo scope + empty state) needs GC1.6/GC1.8.
GC1.10 (docs) last.
Within the epic: schema first → logic → API surface → UI → docs.
```

## Cross-cutting acceptance criteria (apply to the whole epic)

```
- All provider write paths validate via the EXISTING factory validate* functions
  (connectors/git/providers/factory.ts) — no re-implemented provider validation.
- Tokens are write-only end to end: accepted on create/update, encrypted at rest,
  NEVER returned by any GET. Responses expose only token_last4 + a masked string.
- Fail-closed everywhere: unknown provider type, unknown auth method, or a missing
  server secret key must reject with a typed error — never fall through to a
  permissive/plaintext path (review-rule: security gates fail closed).
- Every admin write is admin-gated (isAdmin) at the API — the server is the trust
  boundary even though the UI also hides non-admin surfaces.
- Config-file providers stay valid and read-only in the UI; DB wins on (type,
  container) de-dupe, and the shadowing is logged.
- Provider list ordering is deterministic (explicit ORDER BY; stable tiebreak).
- Reuse canonical helpers: doctor's gitProviderFixHint for remediation copy,
  provider.checkAccess()/listRepos() for probes — do not clone them.
- Each child ships unit tests incl. failure paths; the epic ships one integration
  test: connect (all 3 provider shapes) → test → sync-now → snapshots exist.
```

## Children checklist

```
- [ ] #193 GC1.1 — git_providers schema + migration + row⇄config codec
- [ ] #194 GC1.2 — Server-side secret module (AES-256-GCM, server key, fail-closed)
- [ ] #195 GC1.3 — Provider store (DB CRUD data layer, codec + encryption, masked projection)
- [ ] #196 GC1.4 — Resolver merge (DB ∪ config, DB-wins de-dupe) across sync/doctor/scheduler
- [ ] #197 GC1.5 — Admin CRUD API (list/create/patch/delete)
- [ ] #198 GC1.6 — Test-connection + repo-listing API (saved + draft)
- [ ] #199 GC1.7 — Sync-now API (per-provider async trigger + status)
- [ ] #200 GC1.8 — UI: provider list + add/edit dynamic form (all 3 providers)
- [ ] #201 GC1.9 — UI: repo-scope editor + empty-state onboarding
- [ ] #202 GC1.10 — Docs: config docs note UI as the primary path
```

> GitHub: Epic **#192**; children **#193–#202**, linked as native sub-issues.

---

# EPIC GC1 — Git Connection UI

**Parent issue.** Let an admin connect, test, edit, remove, and sync git providers
(GitHub, Bitbucket, GitLab incl. self-hosted) entirely from the dashboard, choosing
which repositories are analyzed — no config-file edit, no CLI.

### Epic context (inherited by all GC1.x children)

```
Providers today live ONLY in YAML (connectors.git.providers[]) and flow through a
single seam — resolveGitProviderConfigs() — into GitSync (CLI sync + scheduler) and
doctor. This epic adds a DB-backed source of providers merged at that same seam, so
the entire existing pipeline picks up UI-connected providers with no analysis-side
changes.

Four parts: (a) git_providers table + a codec that decodes a row losslessly back
into the GitProviderConfig union the factory already validates; (b) a server-side
AES-256-GCM secret module (server-held key, fail-closed) for token-at-rest; (c) an
admin CRUD + test + repos + sync-now API; (d) an Admin → Connectors → Git page with
a provider-driven dynamic form.

Provider model (what forms/rows must capture):
- GitHub:    container=org;       auth: token
- Bitbucket: container=workspace; auth: app_password(username+app_password) | access_token(token) | oauth(token)
- GitLab:    container=group;     auth: personal_access_token | oauth | job_token (all just token);
             optional url (self-hosted, http/https) + include_subgroups
- All: repos[] include (supports include:/exclude: prefixes) + exclude_repos[]

LOCKED decisions: DB-backed + resolver-merge; fail-closed secret key
(TOPROPE_SECRET_KEY, base64 32 bytes); monitor-all repos by default; Sync-now in v1;
config providers read-only in UI (DB wins de-dupe); all three providers in v1.
```

### Cross-cutting acceptance criteria

See the block above (applies to every child).

---

## GC1.1 — git_providers schema + migration + row⇄config codec

```
Epic: #192 (GC1 Git Connection UI)

### Scope
The persistence spine + a lossless codec between a DB row and the
GitProviderConfig union. No API/UI yet.

### Schema (migration)
CREATE TABLE git_providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                 -- github | bitbucket | gitlab
  container TEXT NOT NULL,            -- org / workspace / group
  url TEXT,                           -- gitlab self-hosted base URL (nullable)
  include_subgroups INTEGER,          -- gitlab only (0/1, nullable)
  auth_method TEXT NOT NULL,          -- token | app_password | access_token | oauth | personal_access_token | job_token
  auth_username TEXT,                 -- bitbucket app_password only
  token_ciphertext BLOB NOT NULL,
  token_meta TEXT NOT NULL,           -- JSON {algo, iv, auth_tag, key_id}
  token_last4 TEXT,
  repos_include TEXT,                 -- JSON array (nullable = monitor all)
  repos_exclude TEXT,                 -- JSON array (nullable)
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  last_sync_at TEXT,
  last_sync_status TEXT,              -- ok | error | never
  last_sync_error TEXT
);
CREATE INDEX idx_git_providers_type_container ON git_providers(type, container);

### Codec
- rowToProviderConfig(row, decryptedToken) → GitProviderConfig (github/bitbucket/gitlab)
- providerConfigToRowFields(config) → column values (minus encrypted token)
- Round-trips every provider/auth-method shape without loss.
- Decoded config MUST pass the existing factory validate* on the way out.

### Acceptance criteria
- Migration applies forward cleanly on an existing DB.
- Codec round-trips all 3 provider types + every auth-method variant (incl.
  bitbucket app_password's two fields and gitlab url/include_subgroups).
- Unknown type/auth_method → codec throws a typed error (fail-closed).
- repos_include null decodes to "monitor all" (undefined repos), not [].

### Testing
- Codec unit tests: one per provider/auth variant + the null-repos and
  url/subgroups edge cases; a malformed-row (bad type) rejection test.
- Migration test: table + index exist; a hand-inserted row reads back.
```

---

## GC1.2 — Server-side secret module (AES-256-GCM, server key, fail-closed)

```
Epic: #192 (GC1 Git Connection UI)

### Scope
A NEW server-side crypto module for provider tokens. Do NOT overload
capture/encryption.ts (that is the client-side, blind-server model). Same
AES-256-GCM primitive, but the key is server-held.

### Design
- loadServerKey(): reads TOPROPE_SECRET_KEY (base64 → 32 bytes). Returns a typed
  "no key configured" result when unset — callers fail-closed on it.
- encryptSecret(plaintext, key) → {ciphertext, meta{algo,iv,auth_tag,key_id}}
- decryptSecret(ciphertext, meta, key) → plaintext (GCM verify → throws on tamper/wrong key)
- Fresh random 96-bit IV per call (never caller-supplied).

### Acceptance criteria
- Round-trips a token; tampered ciphertext or wrong key throws (not garbage).
- Missing/short/invalid TOPROPE_SECRET_KEY → typed "not configured/invalid"
  error; NEVER a plaintext fallback.
- key_id recorded in meta (rotation-ready; rotation itself out of scope).

### Testing
- Encrypt→decrypt happy path; wrong-key and flipped-auth_tag rejection tests.
- Missing-key and malformed-key (not base64 / not 32 bytes) rejection tests.
```

---

## GC1.3 — Provider store (DB CRUD data layer, codec + encryption, masked projection)

```
Epic: #192 (GC1 Git Connection UI)

### Scope
The data-access layer over git_providers: create/list/get/update/delete +
a masked public projection. Composes GC1.1 codec + GC1.2 crypto. No HTTP yet.

### Surface
- createProvider(db, key, input) — validates via factory validate*, encrypts token,
  stamps token_last4, writes row.
- listProviders(db) / getProvider(db, id) — deterministic order (created_at, id tiebreak).
- updateProvider(db, key, id, patch) — token optional (keep stored if omitted;
  re-encrypt + refresh last4 if provided).
- deleteProvider(db, id).
- toPublicProvider(row) — masked token only (token_last4 + "••••" ), NEVER ciphertext/plaintext.
- getDecryptedConfig(db, key, id) — internal-only; used by test/sync/resolver.

### Acceptance criteria
- Create rejects an invalid provider shape (delegated to factory validate*), and
  rejects when the server key is unconfigured (fail-closed).
- Public projection never contains token_ciphertext, token_meta, or plaintext.
- Update without a token preserves the existing ciphertext exactly.
- List order is total + deterministic (>=2-row test proving order).

### Testing
- CRUD unit tests per provider type; masked-projection leak test (assert no secret
  fields present); update-keeps-token test; unconfigured-key create-rejection test.
```

---

## GC1.4 — Resolver merge (DB ∪ config) across sync/doctor/scheduler

```
Epic: #192 (GC1 Git Connection UI)

### Scope
Make DB providers visible to the whole pipeline at the single existing seam.

### Change
- New resolveAllGitProviders(db, key, gitConfig): merges DB providers (enabled only)
  with resolveGitProviderConfigs(gitConfig). De-dupe by (type, container): DB wins;
  log the shadowed config entry.
- Wire GitSync + doctor to use it (scheduler + cli sync + doctor paths). GitSync
  gains db access (or is constructed with a pre-resolved provider list).

### Acceptance criteria
- A DB provider appears in a sync run and produces snapshots (integration).
- A config provider with the same (type, container) as a DB one is shadowed
  (DB wins) and the shadowing is logged; different containers → both run.
- Disabled DB providers are excluded.
- Existing config-only behavior is unchanged when there are no DB providers.

### Testing
- Merge unit tests: DB-only, config-only, overlap (DB-wins + log), disabled-excluded.
- Regression: existing sync/doctor tests still pass with the new resolver.
```

---

## GC1.5 — Admin CRUD API (list/create/patch/delete)

```
Epic: #192 (GC1 Git Connection UI)
New module: dashboard/api/admin/git-providers.ts (mirror admin/developers.ts guards)

### Endpoints (all admin-gated)
- GET    /api/admin/git/providers            → list (masked) incl. config rows flagged source:"config"
- POST   /api/admin/git/providers            → create (validate, encrypt, fail-closed on missing key)
- PATCH  /api/admin/git/providers/:id         → edit; token optional; 409/forbidden for source:"config"
- DELETE /api/admin/git/providers/:id         → delete DB provider (not config)

### Acceptance criteria
- Non-admin → 403 on every route (server-side, not just UI-gated).
- Create with unknown type/auth_method → 400 typed error; missing server key →
  clear "secret key not configured" error (fail-closed), not a 500.
- GET responses contain NO token material (masked only) — asserted.
- PATCH/DELETE on a config-source provider is rejected (read-only).
- :id not found → typed 404 (not a raw DB error).

### Testing
- Per-route auth tests; create-validation + missing-key tests; token-never-leaked
  test; config-row-immutability test; not-found test.
```

---

## GC1.6 — Test-connection + repo-listing API (saved + draft)

```
Epic: #192 (GC1 Git Connection UI)

### Endpoints (admin-gated)
- POST /api/admin/git/providers/:id/test   → checkAccess() on the stored provider
- POST /api/admin/git/providers/test        → checkAccess() on a DRAFT body (unsaved,
                                              token from the request; nothing persisted)
- GET  /api/admin/git/providers/:id/repos    → provider.listRepos() → [{name, archived, defaultBranch}]

### Acceptance criteria
- Test reuses provider.checkAccess(); on failure returns a typed error + a fix hint
  reusing doctor's gitProviderFixHint (single source of remediation copy).
- Draft test validates the shape via factory validate* before probing; never writes.
- Draft test with no token → 400 (can't probe without a credential).
- Repos endpoint returns archived flag so the UI can exclude archived by default.
- Bad credentials → clean {ok:false, error, hint}, not a thrown 500.

### Testing
- Saved + draft test with a mocked provider (success + auth-failure); missing-token
  draft rejection; repos-listing shape test incl. an archived repo.
```

---

## GC1.7 — Sync-now API (per-provider async trigger + status)

```
Epic: #192 (GC1 Git Connection UI)

### Endpoint (admin-gated)
- POST /api/admin/git/providers/:id/sync → trigger a GitSync for this provider,
  async; returns a status handle. Updates last_sync_at/status/error on the row.

### Acceptance criteria
- Runs the SAME GitSync path (no cloned sync logic) scoped to the one provider.
- Concurrent/duplicate triggers for the same provider are coalesced or rejected
  (no two overlapping runs writing the same snapshots).
- On completion the row's last_sync_at/status(ok|error)/error are updated; a failed
  sync records status=error + message (surfaced to the UI), not a swallowed error.
- :id not found / disabled provider → typed error.

### Testing
- Trigger → snapshots written + status ok (integration, mocked provider).
- Failing provider → status=error + message persisted.
- Overlap guard test.
```

---

## GC1.8 — UI: provider list + add/edit dynamic form (all 3 providers)

```
Epic: #192 (GC1 Git Connection UI)
Admin → Connectors → Git (new route + nav, admin-gated like Settings/Users)

### Scope
- Provider list table: type, container, masked token, enabled toggle, repo scope
  ("all" / "N selected"), last-sync (time + status badge), actions
  (Test · Sync now · Edit · Remove). Config rows marked read-only.
- Add/Edit form: provider-type selector → dynamic fields (container label per type;
  auth-method selector per provider; token field(s), with app_password's two-field
  case; GitLab url + include_subgroups). "Test connection" (draft) + "Save".

### Acceptance criteria
- Form renders the correct fields/auth-methods for each of the 3 provider types
  (both branches of the app_password two-field case covered).
- Save is the single orange primary CTA; interactive/active states indigo (color system).
- Token field is write-only: editing shows masked, blank = keep existing.
- Test connection shows the API's ok/error + hint inline before save.
- Config-source rows are visibly read-only (no edit/delete).

### Testing
- Component tests: dynamic form per provider type; app_password variant; masked/edit
  token behavior; read-only config row; test-connection success + error rendering.
```

---

## GC1.9 — UI: repo-scope editor + empty-state onboarding

```
Epic: #192 (GC1 Git Connection UI)

### Scope
- Repo scope editor (per provider): "Monitor all repositories" (default) vs "Select
  repositories" → loads /repos, checkboxes write repos_include. Archived shown but
  unchecked by default.
- Empty state: when no providers AND no snapshots, a "Connect your first git
  provider" panel (fixes the cold-start confusion from finding #3). Post-connect,
  surface the unmatched-author count with a link to developer identity management
  (cross-ref findings #1/#2).

### Acceptance criteria
- Default is monitor-all (no repos_include written) until the admin opts into selection.
- Selecting repos writes repos_include; clearing back to all removes the filter.
- Archived repos excluded by default in the picker.
- Empty state only shows when there is genuinely nothing (no providers + no snapshots).

### Testing
- Component tests: all-vs-select toggle writes the right payload; archived default;
  empty-state visibility (present when empty, absent once a provider exists).
```

---

## GC1.10 — Docs: config docs note UI as the primary path

```
Epic: #192 (GC1 Git Connection UI)

### Scope
- Update the git-connector config docs to state the dashboard is now the primary
  way to connect providers; YAML remains supported and is read-only in the UI.
- Document TOPROPE_SECRET_KEY setup (generate a base64 32-byte key; required to add
  token providers from the UI; fail-closed if unset).

### Acceptance criteria
- Docs describe: adding a provider in the UI, the secret-key requirement, the
  config-vs-UI precedence (DB wins), and monitor-all-vs-select.
- No stale claim that YAML is the only path.

### Testing
- N/A (docs) — verified by review.
```

---

## Notes / cross-references

- Identity mapping (findings #1/#2) gates multi-repo/provider attribution: a
  connected provider only yields data for developers whose git identities are
  mapped. GC1.9 surfaces the unmatched-author count; full identity-management UI is
  a separate initiative.
- Per-repo activity breakdown (finding #4) is explicitly out of scope here.
