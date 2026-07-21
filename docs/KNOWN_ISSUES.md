# Toprope — Known Issues (Phase 2 Dogfood)

Compiled at the close of Phase 2 (Task 2.12) as the gate before WMG dogfooding.
Each entry notes impact and the workaround so dogfood users aren't surprised.
None of these block the dogfood; they are tracked for Phase 3.

---

## Deployment / operations

### K-1. `toprope start` serves only `/health`, not the dashboard
**Impact:** medium. The `toprope start` CLI command calls the health-only
`buildServer`, so it does **not** mount the API or the dashboard SPA. A manager
who runs it will get a 404 at `/dashboard`.
**Workaround:** start the dashboard with `node dist/server.js` (after
`npm run build`) or `npm run dev`. Both use the full `buildServerWithDb`
entrypoint. The setup guide documents this.
**Fix (Phase 3):** point the CLI `start` command at `buildServerWithDb`, or
remove it in favor of the documented entrypoint.

### K-2. No first-run config scaffold
**Impact:** low. There is no `toprope init` to generate `toprope.config.yaml`;
managers copy a sample by hand.
**Workaround:** copy `toprope.bitbucket.config.yaml` /
`toprope.github-only.config.yaml` to `toprope.config.yaml` and edit. Covered in
the setup guide.

### K-3. Frontend bundle ships as a single large chunk
**Impact:** low (cosmetic build warning). The dashboard JS bundle is ~750 kB
(gzip ~210 kB) and Vite warns about chunk size on every build.
**Workaround:** none needed for a LAN dogfood. Acceptable first-load size.
**Fix (Phase 3):** route-level code-splitting / `manualChunks`.

---

## Data & connectors

### K-4. Data quality starts LOW until identities are mapped
**Impact:** medium (expected by design). A developer whose git-email or tool
identity isn't mapped is tracked at LOW/MEDIUM quality, and their commits may be
unattributed.
**Workaround:** map identities (`dev add --git-email/--copilot/...` or the Admin
identity-mapping UI). Unmatched git authors are retained and listed by
`dev discover-repo` / **Admin → Developer identities → Unmatched authors**;
promoting one attributes its retained history immediately, with no re-sync. Adding an
identity to an *existing* developer does **not** back-fill — a later sync attributes only
the window it re-fetches, so recovering older history needs **Admin → Git Providers →
Sync older history**.

### K-5. Cold-start: charts look sparse on day one
**Impact:** low (expected by design). With only a few days of history, time-series
views are short.
**Workaround:** the range selector defaults to the smallest preset that fits
available history and each chart shows a coverage badge ("N days of data"). The
window widens automatically as history accumulates.

### K-6. Bitbucket/GitHub include-list uses exact repo slugs (no globs)
**Impact:** low. The `repos:` include list matches exact slugs; only
`exclude_repos:` supports glob patterns.
**Workaround:** leave `repos: []` to monitor all readable repos and prune with
`exclude_repos`, or list exact slugs.

---

## Dashboard behaviour

### K-7. Plan ROI alerts only appear after the settling period
**Impact:** low (by design). A plan upgrade is evaluated once, after the
configured settling period (default 30 days) has elapsed, so a very recent
upgrade won't raise a `plan_roi` alert yet.
**Workaround:** none — this is intentional to avoid flagging on noise. The
threshold and settling period are configurable in Settings.

### K-8. Developer narrative insights are not in Phase 2
**Impact:** none for dogfood (deferred by design). The developer view shows data
and trends but no rule-based/AI narrative; that lands in Phase 3.

### K-9. Single non-admin role
**Impact:** low. Phase 2 has exactly two roles — `admin` (sees all manager
screens) and `developer` (own data only). There is no dedicated "manager"
role scoped to a single team; any admin sees every team.
**Workaround:** grant admin to the people who need manager screens. The role
seam exists in the code for a future per-team manager role.

---

## Verification status

The end-to-end role flows, cross-role isolation, multi-source rendering,
time-range coverage, waste/Plan ROI, and the <2s performance target are all
covered by automated integration tests in `tests/integration/`. See
`docs/DOGFOOD_READINESS.md` for the signed-off checklist.
