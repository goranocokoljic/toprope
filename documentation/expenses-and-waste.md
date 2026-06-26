# Expenses & waste detection

GovProxy turns cost data into actionable savings. You import what your AI tools
cost, GovProxy ties each charge to a developer and tool, and the waste engine
flags spend that isn't earning its keep. This is the feature that pays for the
product: reclaiming one or two unused seats a month typically covers it.

## Importing expenses

Subscriptions come from CSV files exported from your expense system or a manual
sheet.

```powershell
npx govproxy expenses import .\data\expenses\q2-2026.csv
npx govproxy expenses import .\data\expenses\expensify-export.csv --profile expensify
```

### CSV format and column mapping

The default (`standard`) profile expects:

```csv
developer_email,tool,plan,monthly_cost,billing_model
ada@acme.com,copilot,business,,company_managed
ada@acme.com,claude_code,max,,company_managed
grace@acme.com,windsurf,pro,,reimbursed
alan@acme.com,cursor,pro,20,personal
```

- **`monthly_cost`** may be blank — it then falls back to
  `expenses.subscription_defaults` keyed `<tool>_<plan>` (e.g. `copilot_business`
  → $19, `claude_code_max` → $200).
- **`billing_model`** accepts `company_managed`, `reimbursed`, `personal`,
  `unknown` (plus aliases like `company`, `expensed`).
- Developers are matched by email, so register them first (or edit the CSV emails
  to match).

### Import profiles (Expensify, Concur, custom)

Real expense exports rarely match the standard columns. Named **import profiles**
map a source system's columns onto GovProxy's model. Built-in profiles include
`standard`, `expensify`, and `concur`; you can add your own under
`expenses.import_profiles`:

```yaml
expenses:
  import_profiles:
    finance_sheet:
      column_mapping:
        developer_email: "Employee Email"
        developer_name:  "Employee"        # name-variant fallback when email is absent
        tool: "Vendor"
        amount: "Charge"                   # raw amount, combined with frequency
        frequency: "Cadence"               # monthly | annual | one-time
        period: "Charge Date"              # normalized for dedup
      default_billing_model: "reimbursed"  # assumed when a row carries none
      default_frequency: "monthly"
```

Richer import handles **annual→monthly normalization**, **deduplication** across
re-imports, **billing-model inference** (an Expensify/Concur reimbursement implies
`reimbursed`, flagged as inferred), and a **name-variant fallback** when email
doesn't match.

### The unmatched-charge queue

Rows whose developer can't be matched aren't dropped — they're queued:

```powershell
npx govproxy expenses unmatched                      # review the queue
npx govproxy expenses resolve <charge-id> --dev <developer-id>   # attribute it
```

A resolved recurring charge creates/updates a subscription; a one-time charge is
recorded without one.

### Reconciliation — make total spend trustworthy

Reconciliation compares imported expense charges against the subscription
registry for a period and flags mismatches so your spend total can be trusted:

```powershell
npx govproxy expenses reconcile --period 2026-05 [--tolerance 1]
```

Result types:

- **`expense_no_subscription`** — a charge with no matching registry entry
- **`subscription_no_expense`** — a registered seat with no charge to back it
- **`cost_discrepancy`** — registry vs expense cost differ beyond tolerance

Reconciliation is tolerance-aware (small differences are rounding noise),
company-managed-exempt, annual-coverage-aware, and idempotent on re-runs. Review
open results in the dashboard's **Admin → Reconciliation** screen or via
`GET /api/admin/reconciliation`.

### Viewing subscriptions

```powershell
npx govproxy expenses show [--team frontend]
```

Shows each subscription (developer, tool, plan, cost, billing model), org/team
totals, and **duplicate-tool alerts** (e.g. a developer holding both Copilot and
Cursor).

## Waste detection

The waste engine analyzes subscriptions against usage and flags wasted spend.

```powershell
npx govproxy waste show       # run detection + list alerts grouped by type
npx govproxy waste summary    # waste grouped by team
```

### Alert types

| Type | Trigger |
|---|---|
| **Unused seat** | Active subscription with zero activity for N days (default 14, from `alerts.waste_threshold`) |
| **Underutilized** | Usage well below the team threshold/average |
| **Duplicate tool** | Subscriptions for two+ tools in the same category (e.g. Copilot + Cursor) |
| **Cost outlier** | Cost-per-PR far above the team average |
| **Plan-ROI (review)** | A plan upgrade not justified by a corresponding usage rise |

Each alert carries an estimated **monthly waste** amount; `waste show` totals them
and the dashboard projects annual savings.

### Tier-aware waste claims

Waste claims respect the data tier. For HIGH-tier (measured API) data an alert is
an assertion ("unused seat"); for MEDIUM-tier data it's framed as a
review-question rather than an accusation. Recent plan/tool changes are
transition-aware, so switching a developer's plan doesn't trigger a false unused
-seat alarm during the settling window.

### Plan-change ROI

When a subscription is upgraded (handled as revoke-old + create-new so history is
preserved), GovProxy captures a baseline and, after a settling period, compares
post-upgrade usage. If the higher tier isn't justified by a usage rise it raises a
**plan_roi** alert — framed as a review, not a verdict. Plan-ROI is re-evaluated
automatically after every `sync all` and `waste show`.

### Resolving alerts

```powershell
npx govproxy waste resolve <alert-id> --reason "reallocated to new hire"
```

Resolution is an audited workflow: alerts can be reallocated, upgraded, justified,
or dismissed, and resolved alerts don't reappear. The dashboard's **Waste
Detection** screen offers the same workflow with a visible audit trail. Detection
never duplicates an already-open alert for the same condition.

## Related

- [Configuration → expenses](./configuration.md#expenses)
- [Dashboard → Waste Detection](./dashboard.md)
- [API reference → waste & admin](./api-reference.md)
