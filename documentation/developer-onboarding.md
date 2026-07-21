# Getting developers into Toprope

Connecting a git provider is only half of setup. Sync attributes every commit to a
**developer record**, and it attributes to records that **already exist** — it does not
create them. A freshly-connected provider with an empty registry therefore imports a
repository's whole history and shows **zero developers**, because every author was
unmatched.

This chapter is how you close that gap. There are three paths, and one guarantee that
makes all three safe to run at any time.

> **The guarantee, first.** From the moment a git provider syncs, Toprope retains the
> repository's raw authorship — every author, matched or not, as per-author daily facts.
> So when you add a developer, their **already-synced history is attributed to them
> immediately**, by replaying the retained facts. You do **not** re-sync, and nothing is
> double-counted: attribution is a deterministic re-projection of data Toprope already
> holds, so running it twice writes exactly the same numbers.
>
> Practically: it does not matter whether you add someone before their first sync or six
> months after. They arrive with their history.
>
> **One limit to know.** Retention begins with the first sync on a version that has it —
> days synced by an older build were never retained, so a long-running deployment can only
> replay history from its first sync after upgrading. The way to recover older history is
> to re-fetch that window — **Admin → Git Providers → Sync older history**.
>
> The guarantee covers **editing** identities as well as creating them: adding, correcting
> or removing an identity on an existing developer re-projects their retained history in
> the same write, in both directions (see below).

---

## Path A — Add a developer manually

Use this when you know who should be in the system.

**From the dashboard** (recommended — it is the only path with no CLI access required):

**Admin → Developer identities → ＋ Add developer**. Fill in the name and team, plus any
git identities you know: GitHub / Bitbucket / GitLab username, and commit emails. On
save the dialog reports how much retained history the new developer picked up —
e.g. *"Added Jane Doe — attributed 142 day(s) of retained history."* A count of **0** is
reported honestly: it means the identities you entered matched nothing retained yet.

**From the CLI:**

```bash
npx toprope dev add \
  --name "Jane Doe" \
  --team backend \
  --email jane@company.com \
  --github jane-gh \
  --git-email jane@company.com \
  --git-email jane@personal.com
```

`--git-email` is repeatable — a developer who commits under several addresses needs each
one, or the commits under the missing address stay unattributed. Like the dialog, the
command prints the number of snapshot dates the create attributed.

Both surfaces enforce the same rule: **a git identity or git email belongs to at most one
developer.** A duplicate is refused (the dialog keeps your draft so you can correct it;
the CLI exits non-zero), because a shared identity would make commit attribution
ambiguous.

Adding identities to an **existing** developer — `toprope dev link --id <dev-id> --github
<u> …`, or the **Edit** action on the identities page — carries the same guarantee. The
edit re-projects that developer's retained history in the same write, so the new
identity's whole past attributes immediately; both surfaces report how many days they
covered. No follow-up re-fetch is needed.

Removals and corrections are covered too, and this is the direction that matters most.
Taking an identity off a developer **retracts** the history it was attributing to them,
and moving it to someone else attributes it there — so a mis-mapped identity does not
leave one person permanently holding another's commits in their dashboard and team
aggregates. Correcting the mistake is enough; there is nothing else to clean up.

---

## Path B — Discover developers from the repository

Use this when you do **not** know who should be in the system — the common case right
after connecting a provider. Toprope answers "who is committing here?" from the
authorship it has already retained, so this works for every provider (GitHub, GitLab,
Bitbucket) and includes contractors and anyone else who never appears in an org member
list.

> This is distinct from `toprope dev discover`, which reads **GitHub organization
> members**. That one needs a GitHub org and an org-scoped token, and it will happily
> create developers who never touched a repository while missing every contributor who
> is not an org member.

**From the dashboard:** **Admin → Developer identities → Unmatched authors**. Each row is
a retained git author that maps to no developer, busiest first, with their commit count
and last-seen date. **Add as developer** opens the create dialog pre-filled from that
author — their login lands on their own provider's field, so the promotion actually
resolves.

Authors that look like automation are flagged **likely bot** with the reason in a
tooltip. They are flagged, never hidden: the classifier is conservative, and you may
legitimately want to promote an account it misread.

**From the CLI:**

```bash
# 1. See who is unmatched
npx toprope dev discover-repo

# 2. Promote one, optionally overriding what was derived from the repo
npx toprope dev discover-repo --promote "github:login:jane-gh" \
  --team backend --name "Jane Doe" --email jane@company.com

# 3. Or promote everyone at once (likely bots are skipped)
npx toprope dev discover-repo --promote-all --team backend
```

| Option | Meaning |
|---|---|
| *(no options)* | List the review queue. An empty queue is not an error. |
| `--promote <raw-author-key>` | Promote one author. Requires `--team`. |
| `--promote-all` | Promote every unmatched author. Requires `--team`. |
| `--include-bots` | With `--promote-all`, do **not** skip likely-bot authors. |
| `--team <team>` | Team the promoted developer(s) land in. Required for either promote mode. |
| `--name <name>` | Display name for `--promote`; defaults to the author's display name, else login, else email. |
| `--email` / `--github` / `--bitbucket` / `--gitlab` | Override the identity derived from the author row. |

Each promotion prints its attributed-dates count, so a bulk promote shows you exactly how
much history each person recovered.

### The cold-start signpost

If your organization has **zero** developers while retained authorship exists, the
**Organization Overview** shows a panel saying so, with the unmatched-author count and a
link straight to the review queue. It is shown to admins only (the queue is admin-gated)
and disappears as soon as any developer exists.

---

## Path C — Auto-create developers during sync (opt-in, default OFF)

Toprope can create a developer record for every unmatched author it sees during a git
sync. This is **off by default and stays off unless you explicitly enable it** — a fresh
install never silently manufactures identity records for people who never agreed to be
measured.

```yaml
connectors:
  git:
    enabled: true
    provider: "github"
    org: "your-org"
    api_token: "${GIT_API_TOKEN}"

    auto_create_developers: true            # default: false
    auto_create_team: "unassigned"          # REQUIRED when the flag is true
    auto_create_exclude:                    # optional extra denylist
      - "svc-*"
      - "*@bots.company.example"
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `auto_create_developers` | boolean | `false` | Create a developer for each unmatched git author during sync. |
| `auto_create_team` | string | *(none)* | Team the auto-created developers land in. **Required** when the flag is `true`. Created if it does not exist; refused if it exists but is archived. Max 100 characters. |
| `auto_create_exclude` | list of strings | `[]` | Extra authors to never auto-create, on top of the built-in bot classifier. |

### How it fails closed

- **Off means off.** The flag must be the YAML boolean `true`. An absent key, `false`, or
  anything that is not a boolean — including a quoted `"true"` or an unexpanded
  `${ENV}` reference, both of which reach the loader as *strings* — is rejected rather
  than coerced. Guessing either way is wrong in a way that matters: coercing `"false"` to
  true creates developers nobody asked for.
- **No silent no-op.** `auto_create_developers: true` with a missing or blank
  `auto_create_team` is a **thrown configuration error at startup**, not a run that
  quietly creates nobody. A silent no-op is the worst outcome available — you would
  believe onboarding is automatic, see no developers, and have nothing to read that
  explains why. If the named team exists but is archived, the run creates nobody and
  reports a loud error.
- **Bots are excluded.** The built-in classifier skips likely-automation authors: known
  automation logins (`dependabot`, `renovate`, `github-actions`, `mergify`, `snyk`,
  `codecov`, and similar), any login ending in `[bot]` / `-bot` / `_bot`, placeholder
  logins (`unknown`, `anonymous`, `ghost`, …), authors with neither a login nor an email,
  and — for authors with **no** login — a no-reply email domain. (A no-reply address is
  *not* held against an author who has a login: that is what a human on GitHub privacy
  mode looks like, and hiding a real person is the expensive mistake.)
  `auto_create_exclude` adds your own patterns on top of this; it can only exclude more
  authors, never let a classified bot through.
- **Validated even when off.** `auto_create_exclude` is checked whether or not the flag
  is enabled, so a typo'd denylist fails on the config you are editing rather than on the
  first hands-off run months later.
- **Validated at both boundaries.** The same validator runs in the config loader (so a
  bad file fails at startup) and again in the sync write path (so a config assembled
  programmatically cannot reach the create path unvalidated).

### What it does and does not onboard

- **Only authors seen in that run.** Auto-create considers the authors the sync just
  retained, not the whole backlog. Turning the flag on does **not** retroactively onboard
  everyone who ever committed — those authors stay in the review queue until they commit
  again. To clear an existing backlog in one step, use path **B**
  (`toprope dev discover-repo --promote-all --team <team>`).
- **Only provider-verified logins.** No human reviews these records, so auto-create
  onboards authors identified by a provider login and gives them **no** git commit email
  — a commit email is self-asserted by whoever made the commit, and claiming one without
  review would let a crafted commit re-point another developer's attribution. Add the
  real commit emails yourself afterwards (**Edit** on the identities page, or
  `toprope dev link`).
- **The run reports what it did.** Auto-create's summary rides along with the sync result
  as an advisory. A promotion that could *not* complete is reported as a genuine error and
  turns the provider red — a half-onboarded run never reads as a clean one.

### Pattern syntax for `auto_create_exclude`

The pattern language is deliberately **not** regular expressions. `*` — matching any run
of characters — is the only special character; everything else is literal, so
`dependabot[bot]` means exactly that string. Patterns are anchored at both ends and
matched case-insensitively: `renovate` excludes `renovate` and not `renovate-fan`; write
`renovate*` if you want the prefix.

Bounds (exceeding any of them is a configuration error): at most **200** patterns, each
at most **200** characters, with at most **2** `*` wildcards per pattern.

---

## Which path should I use?

| Situation | Path |
|---|---|
| Small team, you know everyone | **A** — add them manually, once |
| Just connected a provider, unsure who is in the codebase | **B** — discover from the repo |
| Large org, high contributor churn, you want hands-off onboarding | **C** — auto-create, with a denylist and a holding team |
| You want a human to approve every record | **A** or **B** — leave **C** off |

Paths are not exclusive. A common shape is **B** to bootstrap the roster from what the
repo already shows, then **A** for each new hire.

---

## Troubleshooting

**"I synced a repo and there are no developers."** Expected, if the registry was empty:
sync attributes to existing records. Go to **Admin → Developer identities → Unmatched
authors** (or run `toprope dev discover-repo`) and promote the authors you recognize.
Their history is attributed on promotion.

**"I added a developer but their history is missing."** Check the attributed-dates count
the create reported. If it was `0`, the identities did not match any retained author —
compare what you entered against the review queue's **Login / email** column. A commit
email you did not add is the usual cause. Add it via **Edit** on the identities page or
`toprope dev link --id <dev-id> --git-email <address>`; the edit re-projects that
address's retained history straight away and reports the number of days it attributed. If
that count is `0`, the address matched nothing retained — which usually means the activity
predates retention on this deployment, and **Admin → Git Providers → Sync older history**
over that window is what recovers it.

**"The same person shows up twice."** They commit under two identities. Do not create two
records — put both on one developer (`--git-email` is repeatable, and the GitHub /
Bitbucket / GitLab fields are independent). Toprope refuses to let two developers claim
the same identity for exactly this reason.

**"Auto-create is on but nothing was created."** Either every unmatched author was
classified as a bot or matched `auto_create_exclude`, or the configured
`auto_create_team` is archived — the latter is reported as an error on the run. A missing
team name would have failed at startup, so the process would not have got this far.

---

## See also

- [Connectors](./connectors.md) — connecting git providers and what sync collects
- [Configuration](./configuration.md) — the full `toprope.config.yaml` reference
- [CLI reference](./cli-reference.md) — every `toprope dev` command
- [Dashboard](./dashboard.md) — the admin screens
