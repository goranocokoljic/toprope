# Toprope — Testing Findings & Punch List

> Living log of inconsistencies, bugs, and missing features found during hands-on
> testing of the platform. Capture fast, triage together, then develop.
>
> **Workflow:** dump a finding → we triage (severity + type + effort) → group into
> work items → run through the dev-cycle skill → check off here.

**Owner:** Goran · **Started:** 2026-07-06 · **Status:** open

---

## How to use this doc

1. When you hit something, add a row to **Inbox** below. One line is fine —
   even just "waste page shows $0 when there's clearly waste". Don't polish it.
2. We triage together: assign **Type**, **Severity**, **Area**, rough **Effort**,
   and promote it out of the Inbox into **Triaged**.
3. Triaged items get grouped into GitHub issues / dev-cycle runs.
4. Move to **Done** with the PR/issue link when shipped.

**Type:** `bug` (works wrong) · `missing` (no feature) · `ux` (confusing/awkward)
· `data` (wrong/inconsistent data) · `perf` · `docs`

**Severity:** `P0` blocker · `P1` major · `P2` minor · `P3` nice-to-have

---

## Inbox (raw, untriaged)

Add findings here as you test. Newest at the top. Keep it low-friction.

| # | What you saw | Where (page/command/API) | Type? | Notes |
|---|--------------|--------------------------|-------|-------|
| 7 | Currency handling — USD assumed everywhere, `currency` column silently ignored on import | `subscriptions.monthly_cost` (no currency col), `expenses/importer.ts` (drops `currency`), frontend `format.ts` (hardcoded USD), CLI `$` | data/bug | **DECISION (2026-07-06): C — accept USD-only for now, no code change.** Assumption: all expense inputs are USD. **Residual risk stays:** importer ignores the CSV `currency` column (present in Concur/Expensify fixtures), so any non-USD row would sum into USD totals at 1:1 silently → wrong waste/ROI/spend. Cheap guard available anytime if wanted without full multi-currency: read `currency` on import and fail-closed (flag/reject non-USD rows) — the ~1 safety piece of option A. Full options for later: (A) explicit `display_currency` + fail-closed import; (B) full multi-currency + FX [epic]. |
| 6 | Settings page is dense/unfriendly — needs redesign | Settings page (`Settings.tsx`) | ux | **OWN EPIC — design discussion required before build.** Current: one long scroll, ~25 global fields + anomaly config + per-team, bare label+input rows, no descriptions/help text, no search/tabs. Redesign scope TBD: IA, progressive disclosure, inline help, tabbed nav, search. Do NOT build until designed. |
| ~~5~~ | ✅ DONE — real Toprope SVG logo now in Header + Login, theme-aware; favicon added | `Header.tsx`, `Login.tsx`, `index.html`, new `components/Logo.tsx` + `src/assets/toprope*.svg` + `public/favicon.svg` | ux | Shipped this session. Light/dark lockups swap via `dark:` class; favicon uses the orange mark. Build + typecheck + tests green. |
| 4 | No per-repo breakdown of a developer's activity in the dashboard | git_snapshots / dashboard | missing | Multi-repo IS handled, but daily git_snapshots are keyed `(developer_id, date)` with repo collapsed out — only `pr_records` retain `repo`. Can't see "dev X: 60% repo A / 40% repo B". Only build if we actually want per-repo attribution surfaced. Design call. |
| 3 | No way to connect git repos/providers from the interface — config-file only | Git connector (`connectors.git` in YAML); dashboard has only read-only `GET /api/teams/:team/providers` | missing | **DESIGNED + TRACKED + ISSUES CREATED (2026-07-06):** `Git_Connection_UI_Design_Document.md` + `Git_Connection_UI_Task_Tracker.md`. GitHub: Epic **#192**, children **#193–#202** (native sub-issues, labels `enhancement`+`epic-gc1`). Ready to build via dev-cycle. Repos are connected by editing YAML + `toprope sync git`; the epic adds a DB-backed admin UI (all 3 providers, encrypted tokens, test/sync-now) merged at the existing resolver seam. Related risk: multi-repo attribution depends on complete identity mapping (see #2/#1). |
| 2 | "Linked developer" dropdown on the create-user form is always empty; no way to populate it | Admin → Users → Create user (`GET /api/admin/developers`) | missing/bug | Root cause: developer registry is only fillable via CLI (`toprope dev add` / `dev discover`) or git sync. **No dashboard path to add a developer** — admin API only lists/edits. On a fresh install the dropdown can never be filled from the UI. Fix candidates: (a) add "Create developer" to Admin → Developers/Identities + POST endpoint, and/or (b) empty-state hint on the dropdown telling the admin to run discover/sync first. |
| 1 | "Linked developer" box on new-user form is confusing — unclear what assigning a developer to a user means | Admin → Users → Create user | ux/docs | Meaning: links a login *account* to a tracked *developer* registry record; drives the privacy model (a developer-role user sees only their own linked developer's individual metrics). Fix: inline help text / tooltip explaining user-vs-developer, e.g. "Link this account to the tracked developer whose private data they may view. Leave blank for admins." |

---

## Triaged (ready to develop)

| # | Finding | Type | Sev | Area | Effort | Issue | Status |
|---|---------|------|-----|------|--------|-------|--------|
| | | | | | | | |

---

## Done

| # | Finding | Fixed in | Date |
|---|---------|----------|------|
| 5 | Real Toprope SVG logo in Header + Login (theme-aware) + favicon | `Logo.tsx`, `Header.tsx`, `Login.tsx`, `index.html`, `src/assets/`, `public/favicon.svg` | 2026-07-06 |
| — | Visual redesign: Inter font everywhere (Space Grotesk removed); Toprope Color System applied (warm `ink-*` neutrals, indigo `#5B5BD6` interactive, orange `#F0561D` primary CTA on obvious action buttons, semantic tiers) — light + dark | `index.css`, `tailwind.config.js`, `main.tsx`, + `bg-primary` on ~12 CTA buttons | 2026-07-06 |

---

## Notes / open questions

- _(anything that needs a decision before it can be triaged)_
