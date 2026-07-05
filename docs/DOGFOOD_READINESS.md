# Toprope — Dogfood Readiness Checklist

**Phase 2 close-out (Task 2.12).** This is the final gate before real WMG users
see the dashboard. Each item maps to an acceptance criterion in issue #47 and is
backed by an automated integration test under `tests/integration/` unless noted
as a manual/operational check.

Run the gate at any time with:

```powershell
npm run build
npm test                                   # full suite, incl. integration
npx vitest run tests/integration           # just the 2.12 integration suite
```

---

## Acceptance criteria

### ✅ Both end-to-end role flows pass
- **Manager:** login → overview → teams → team detail → waste → logout, on one
  session cookie. — `tests/integration/manager-flow.test.ts`
- **Developer:** login → my dashboard → my tools → my activity → logout. —
  `tests/integration/developer-flow.test.ts`

### ✅ Cross-role isolation verified (security-critical)
- A developer session receives **403** on every manager/admin endpoint (read and
  write), and the leaderboard is invisible (no capability leak).
- `/api/me/*` is scoped to the session developer regardless of any `developer_id`
  passed; one developer never sees another's data or cost.
- Unauthenticated requests get **401** on every protected route; `/health` and
  login stay public. — `tests/integration/cross-role-isolation.test.ts`

### ✅ All screens render with real multi-source WMG data
- Coverage view shows all three connectors (Copilot, Claude Code, Windsurf)
  **connected** and all three git providers (Bitbucket, GitHub, GitLab) with
  developer counts.
- A developer's git activity is unified across providers. —
  `tests/integration/multi-source.test.ts`

### ✅ Time-range selector works across all charts
- Every preset (`30d`, `90d`, `year`, `lifetime`) **and** custom ranges return
  200 on every manager chart (overview/team trends) and every developer chart
  (overview, tools, timeline, activity).
- Inverted custom ranges are rejected with 400 consistently; narrowing the range
  narrows the returned series. — `tests/integration/multi-source.test.ts`

### ✅ Waste detection (incl. Plan ROI) verified against subscription data
- An idle established seat raises an `unused_seat` alert.
- A disproportionate plan upgrade (Pro→Max, flat usage) raises a `plan_roi`
  alert after the settling period.
- A manager can resolve an alert through the full request path. —
  `tests/integration/multi-source.test.ts`

### ✅ No screen exceeds the 2-second load target with real data volume
- Against ≈60 developers × 120 days of multi-tool, multi-provider history
  (>5,000 snapshots), every manager and developer screen's backing endpoints
  return in **< 2,000 ms**. — `tests/integration/performance.test.ts`

### ✅ Setup doc enables a sub-1-hour deployment
- `docs/DOGFOOD_SETUP.md` walks install → config → migrate → `doctor` → register
  developers → `sync all` → create admin → start server → smoke-test both roles,
  with a per-step time budget summing to under an hour.

### ✅ Known-issues list complete
- `docs/KNOWN_ISSUES.md` captures 9 known issues with impact + workaround. None
  block the dogfood; all are tracked for Phase 3.

---

## Operational pre-flight (run on the dogfood box)

These are environment checks, not code tests — tick them on the actual host:

- [ ] `npm run build` succeeds on the target machine.
- [ ] `npx toprope doctor` is green for every configured connector + provider.
- [ ] `npx toprope sync all` completes and `npx toprope status` shows data.
- [ ] At least one admin account exists (`toprope user create-admin`).
- [ ] Dashboard reachable at `http://<host>:8080/dashboard`; `/health` returns ok.
- [ ] If bound to a non-loopback host, `dashboard.auth.cookie_secure` is enabled
      behind HTTPS (the server logs a warning otherwise).

---

## Sign-off

| Gate | Status |
|------|--------|
| Build (`npm run build`) | ✅ green |
| Full test suite (`npm test`) | ✅ green |
| Integration suite (2.12) | ✅ 25 tests green |
| Setup doc validated | ✅ `docs/DOGFOOD_SETUP.md` |
| Known issues documented | ✅ `docs/KNOWN_ISSUES.md` |

**Phase 2 is dogfood-ready.** Proceed to WMG dogfood; track the Phase 3 items
from the known-issues list.
