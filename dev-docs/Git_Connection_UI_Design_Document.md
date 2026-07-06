# Toprope — Git Connection UI: Design Document

**Status:** DRAFT — for discussion. Nothing here is built. Once we lock the
decisions in §11, we cut the companion task tracker (`Git_Connection_UI_Task_Tracker.md`)
in the same epic/subtask format as the Phase trackers.

**Author:** Goran · **Started:** 2026-07-06 · Related finding: #3 (no UI to connect git repos)

---

## 1. Problem & goal

Today git repositories can **only** be connected by hand-editing the YAML config
(`connectors.git.providers[]`) and running `toprope sync git`. A UI-driven admin
has no way to onboard git data at all. The dashboard's only provider-facing
surface (`GET /api/teams/:team/providers`) is read-only and merely *derives*
provider names from snapshots that already exist.

**Goal:** an admin can connect, test, edit, and remove git providers (GitHub,
Bitbucket, GitLab — including self-hosted GitLab) entirely from the dashboard,
choose which repositories are analyzed, and trigger/observe syncs — without
touching a config file or the CLI.

### Non-goals (this iteration)
- Per-developer OAuth / "sign in with GitHub" flows. Admin supplies an org/PAT
  token, as today.
- Webhooks / real-time push. Sync stays pull-based (manual + scheduled).
- Changing the analysis model (snapshots, attribution, churn) — untouched.
- Replacing the YAML config path. Config-file providers remain valid (§8).

---

## 2. Current state (what we build on)

| Concern | Today | Reference |
|---|---|---|
| Provider config shape | `GitProviderConfig` union (github/bitbucket/gitlab) | `connectors/git/providers/types.ts` |
| Provider validation | `validateGitHub/Bitbucket/GitLab` in factory | `connectors/git/providers/factory.ts` |
| Config resolution | `resolveGitProviderConfigs(GitConnectorConfig)` | `connectors/git/providers/config.ts` |
| Sync entry | `new GitSync(config.connectors.git)` → resolves providers → fans out over repos | `connectors/git/sync.ts`, `cli.ts`, `scheduler/scheduler.ts` |
| Connectivity probe | `provider.checkAccess()` (cheap auth/reachability check) | `providers/types.ts`, `cli/doctor.ts` |
| Repo listing | `provider.listRepos()` (non-archived repos in the container) | `sync.ts` |
| Read-only provider view | `GET /api/teams/:team/providers` (derived from snapshots) | `dashboard/api/providers.ts` |
| Secret encryption precedent | AES-256-GCM (client-side, blind server) | `capture/encryption.ts` |

**The single integration seam:** everything (sync, scheduler, doctor) funnels
through `resolveGitProviderConfigs`. If DB-stored providers are merged in there,
the entire pipeline picks them up with no other changes.

---

## 3. Provider model (what the forms must capture)

Each provider has a **container** (the thing we enumerate repos from), an **auth
block** (provider-specific, one or more methods), and optional **repo filters**.

### GitHub
- Container: `org` (login)
- Auth: `token` — a PAT/GitHub App token with repo read access
- Filters: `repos[]` (include; supports `include:`/`exclude:` prefixes), `exclude_repos[]`

### Bitbucket
- Container: `workspace`
- Auth (one of):
  - `app_password` → `username` + `app_password`
  - `access_token` → `token`
  - `oauth` → `token`
- Filters: `repos[]`, `exclude_repos[]`

### GitLab
- Container: `group`
- Optional: `url` (self-hosted base URL; http/https), `include_subgroups` (bool)
- Auth (one of): `personal_access_token` / `oauth` / `job_token` — each just `token`
  (scopes: `read_api` + `read_repository`)
- Filters: `repos[]`

> The UI form is **provider-driven**: pick a provider type → the form renders the
> right container label + auth-method selector + fields. Auth-method is an enum
> per provider; the token field(s) depend on the chosen method (Bitbucket
> app_password is the only two-field case).

---

## 4. Architecture overview

```
Admin UI (Connectors → Git)
   │  CRUD + test + list-repos + sync-now  (admin-gated REST)
   ▼
/api/admin/git/providers…                     ← new API module
   │  writes
   ▼
git_providers table (DB)  ── token encrypted at rest (server key)
   │  read + decrypt
   ▼
resolveGitProviderConfigs()  ← MERGES db providers + config-file providers
   │
   ▼
GitSync (unchanged)  → fan out repos → snapshots
```

Four moving parts: **(a)** a DB table, **(b)** server-side secret encryption,
**(c)** a new admin API, **(d)** a new admin UI page. Plus one small change to
the resolver so sync sees DB providers.

---

## 5. Persistence — `git_providers` table

New migration. One row per connected provider.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `type` | TEXT NOT NULL | `github` \| `bitbucket` \| `gitlab` (validated, fail-closed) |
| `container` | TEXT NOT NULL | org / workspace / group |
| `url` | TEXT | GitLab self-hosted base URL (nullable) |
| `include_subgroups` | INTEGER | GitLab only (0/1) |
| `auth_method` | TEXT NOT NULL | provider-specific enum (e.g. `token`, `app_password`) |
| `auth_username` | TEXT | Bitbucket app_password only |
| `token_ciphertext` | BLOB NOT NULL | encrypted secret (§6) |
| `token_meta` | TEXT NOT NULL | JSON: algo/iv/auth_tag/key_id |
| `token_last4` | TEXT | last 4 chars, for masked display |
| `repos_include` | TEXT | JSON array (nullable = monitor all) |
| `repos_exclude` | TEXT | JSON array (nullable) |
| `enabled` | INTEGER NOT NULL | soft on/off without deleting |
| `created_at` / `updated_at` | TEXT | UTC ISO |
| `created_by` | TEXT | user id (audit; FK to users) |
| `last_sync_at` | TEXT | mirror/derive from `sync_state` |
| `last_sync_status` | TEXT | `ok` \| `error` \| `never` |
| `last_sync_error` | TEXT | last error summary (nullable) |

A row decodes losslessly back into the exact `GitProviderConfig` union the
factory already validates. **Reuse the factory's `validate*` functions** on
write — do not re-implement provider validation (review-rule: reuse the canonical
helper).

---

## 6. Secret handling (the security core)

Provider tokens are **server-decryptable secrets** (unlike capture, where the
server is blind). Design:

- **Algorithm:** AES-256-GCM (same primitive as `capture/encryption.ts`, but a
  new server-side module — do not overload the blind-server client module).
- **Key source:** a server master key from env (e.g. `TOPROPE_SECRET_KEY`,
  32 bytes / base64). **Fail-closed:** if no key is configured, the API refuses to
  store a token and returns a clear error (no plaintext-at-rest fallback).
- **At rest:** only `token_ciphertext` + `token_meta` (iv, auth_tag, key_id) are
  stored. Never plaintext.
- **In transit / API:** a token is **write-only**. It is accepted on create/update
  and **never returned** by any GET. Responses show `token_last4` + a masked
  string only. Editing a provider without re-entering the token keeps the stored
  one; entering a new token replaces it.
- **Key rotation:** `key_id` in meta lets multiple keys coexist; rotation is a
  later concern (documented, not built now).

> Open decision (§11): confirm the env var name + whether we also support a
> key file path, and behavior when the key is missing (fail-closed vs read-only).

---

## 7. API surface (new module: `dashboard/api/admin/git-providers.ts`)

All routes **admin-only** (`isAdmin` guard; mirror `admin/developers.ts`).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/admin/git/providers` | List providers (masked tokens, sync status). Includes read-only config-file providers, flagged `source: "config"`. |
| `POST` | `/api/admin/git/providers` | Create. Validate via factory `validate*`. Encrypt token. Fail-closed on bad type/missing key. |
| `PATCH` | `/api/admin/git/providers/:id` | Edit container/filters/auth/enabled. Token optional (keep if omitted). Config-source rows are 409/forbidden (read-only). |
| `DELETE` | `/api/admin/git/providers/:id` | Remove a DB provider (not config ones). |
| `POST` | `/api/admin/git/providers/:id/test` | Reuse `provider.checkAccess()` → `{ok}` or typed error + fix hint (reuse doctor's `gitProviderFixHint`). |
| `POST` | `/api/admin/git/providers/test` | Test a **draft** (unsaved) provider from the submitted body — lets the admin verify before saving. |
| `GET` | `/api/admin/git/providers/:id/repos` | `provider.listRepos()` → repo picker (name, archived, default branch). |
| `POST` | `/api/admin/git/providers/:id/sync` | Trigger a sync now for this provider (async; returns a job/status handle). |

Notes:
- **Test-before-save** (`POST …/test` with body) is the nicest UX: the admin
  pastes a token, clicks Test, sees green, then Save. It also validates the token
  without ever persisting a bad one.
- Reuse `gitProviderFixHint()` from `doctor.ts` so UI errors match CLI errors
  (one source of truth for remediation copy).

---

## 8. Backward compatibility with config-file providers

Config `connectors.git.providers[]` (and the legacy `git.org` + `api_token`
shorthand) **stay fully valid**. Approach:

- `resolveGitProviderConfigs` is extended to return **DB providers ∪ config
  providers** (or a new `resolveAllGitProviders(db, config)` that the sync sites
  call). De-dupe by `(type, container)` — if the same org is in both, DB wins
  (the UI is the newer source of truth) and we log the shadowing.
- Config providers appear in the UI list as **read-only** (`source: "config"`,
  greyed, "managed in config file"). They can be tested and synced but not
  edited/deleted from the UI. This avoids the app trying to rewrite a
  possibly-mounted/read-only YAML file.

---

## 9. UI (Admin → Connectors → Git)

New admin page (route + nav gated to admins, like Settings/Users). Sections:

1. **Connected providers** — table: provider icon+type, container, masked token,
   enabled toggle, repo scope ("all" or "N selected"), last sync (time + status
   badge), actions (Test · Sync now · Edit · Remove). Config rows are marked
   read-only.
2. **Add provider** — provider-type selector → dynamic form (§3): container field,
   auth-method selector, token field(s), optional GitLab url/subgroups. Buttons:
   **Test connection** (draft test) and **Save**. Save is the single primary
   (orange) CTA on the form.
3. **Repo scope editor** (after a provider exists) — "Monitor all repositories"
   (default) or "Select repositories": loads `…/repos`, checkboxes write the
   `repos_include` list. Archived repos shown but excluded by default.
4. **Empty state** — when no providers AND no snapshots: a clear "Connect your
   first git provider" panel (this also fixes the current empty-dropdown /
   cold-start confusion). Ties into finding #3.

Follows the color system: indigo for interactive/active, one orange primary CTA
per form, warm neutrals, Inter.

---

## 10. Interaction with existing flows

- **Sync (`toprope sync git`, scheduler):** unchanged code path; picks up DB
  providers via the resolver. A UI "Sync now" calls the same `GitSync`.
- **Doctor (`toprope doctor`):** already iterates resolved providers → now also
  validates UI-connected ones for free.
- **Identity mapping caveat (finding #1/#2):** connecting a provider only produces
  data for developers whose git identities are mapped; unmatched authors still
  drop to "unmatched". The empty state / post-connect screen should surface the
  unmatched-author count and link to developer identity management. (Cross-ref,
  not built here.)

---

## 11. Decisions — LOCKED (2026-07-06)

1. **Persistence:** ✅ DB-backed `git_providers` table, merged at the resolver.
2. **Secret key:** ✅ **fail-closed** — `TOPROPE_SECRET_KEY` (base64, 32 bytes);
   if unset, adding token providers is refused with a clear setup message. No
   plaintext-at-rest fallback.
3. **Repo scope default:** ✅ **monitor-all by default**; per-repo selection is opt-in.
4. **Sync-now:** ✅ **included in v1** — per-provider async trigger + status.
5. **Config-file providers:** ✅ read-only in UI + DB-wins de-dupe.
6. **Scope of v1:** ✅ **all three providers** (GitHub + Bitbucket + GitLab incl.
   self-hosted) via the provider-driven dynamic form.

---

## 12. Rough shape of the tracker (preview — not the tracker itself)

Likely one epic with dependency-ordered children:

- **Schema first** — `git_providers` migration + row⇄config codec (reusing factory validation)
- **Secret module** — server-side AES-256-GCM encrypt/decrypt + key loading (fail-closed)
- **Resolver merge** — DB ∪ config in `resolveGitProviderConfigs`, de-dupe, tests
- **CRUD API** — list/create/patch/delete (masked tokens, admin-gated)
- **Test + repos API** — `checkAccess` probe (saved + draft), `listRepos` picker
- **Sync-now API** — per-provider trigger + status surfacing
- **UI: provider list + add/edit form** — provider-driven dynamic form
- **UI: repo scope editor + empty state** — cold-start onboarding
- **Docs** — update config docs to note UI is now the primary path

Exact leaf numbering + acceptance criteria land in the tracker once §11 is locked.
