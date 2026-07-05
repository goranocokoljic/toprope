# Operations & troubleshooting

Running Toprope day to day: the scheduler, the sync pipeline, health checks, and
the gotchas worth knowing before they bite you.

## Running the server

| Mode | Command | What runs |
|---|---|---|
| Development | `npm run dev` | Fastify server (via tsx) + Vite dashboard, full API + scheduler |
| Production | `npm run build` then `node dist/server.js` | Full API + dashboard + scheduler from compiled output |
| Container | `docker compose up --build` | The same, in Docker |

`dist/server.js` is the package main entry. On startup it loads the config, runs
migrations, prunes expired sessions, mounts every route, serves the built
dashboard at `/dashboard`, and starts the background schedulers.

## What the scheduler does

When the server runs against a persistent database, several cron-driven jobs start
(all times UTC, configurable):

1. **Connector syncs** — each connector on its `sync_time` (only when a
   `connectors` block is configured). Order in a full run: Copilot → Claude Code →
   Windsurf → Cursor → Git.
2. **Aggregation rollups** — weekly/monthly/quarterly/yearly on their period
   boundaries (04:00+ UTC), deliberately after syncs so each rollup folds a
   freshly-populated daily table. These run whenever the DB persists, **even with
   no connectors** (git-only / expense-only deployments still get trends).
3. **Summary auto-generation** — weekly + monthly fire just after the matching
   aggregation job (gated on `summaries` config). Quarterly/yearly are on-demand
   only.
4. **Anomaly scan** — after the weekly aggregation; notable/high anomalies can
   notify Slack (gated).
5. **Survey sweep** — daily, when `surveys.enabled` (detection + dispatch +
   stranded-retry).
6. **Slack daily prompt** — optional end-of-day self-report nudge, when enabled
   with channels.

Each job isolates its errors so one failure doesn't cascade. All are stopped
cleanly on server shutdown.

## Sync pipeline behavior

- **Idempotent:** re-running a sync updates the day's rows, never duplicates.
- **Incremental:** per-connector sync state means only new data since the last
  successful run is processed.
- **Error-isolated:** if Copilot fails, Git still runs. `sync all` exits non-zero
  if any connector reported errors, but partial data is still saved.
- **Plan-ROI:** evaluated automatically after `sync all` and `waste show`.

Run a full manual sync any time:

```powershell
npx toprope sync all
```

## Health & diagnostics

```powershell
curl http://localhost:8080/health     # -> {"status":"ok"}
npx toprope doctor                    # config + DB + live credential checks
npx toprope status                    # unified operational summary
```

`doctor` is your first stop for any "it's not pulling data" problem — it checks
config validity, migration state, and the live reachability of every enabled
connector's credentials, with a `Fix:` hint per failure.

## Backups & data

- The entire dataset is the SQLite file at `storage.sqlite_path` (default
  `./data/toprope.db`). Back it up by copying the file (ideally while the server
  is stopped, or using SQLite's backup API).
- Imported expense CSVs live under `expenses.import_path`.
- Snapshots are append-only; aggregates are immutable once computed — so restoring
  a backup restores a coherent point-in-time state. Re-running `aggregate
  backfill` rebuilds aggregates from daily snapshots if needed.
- Raw daily data is retained `aggregation.daily_retention_days` (default 90);
  aggregates are kept indefinitely.

## Security checklist for a real deployment

- Set `dashboard.auth.cookie_secure: true` and serve over HTTPS (directly or
  behind a TLS-terminating proxy).
- Create accounts with `toprope user create-admin`; rotate the generated
  temporary password on first login.
- Keep all tokens in environment variables, never in the committed YAML.
- Bind `server.host` to loopback if the dashboard is only reached via a local
  proxy; otherwise ensure `cookie_secure` is on (the server warns if not).
- The AI-summary model defaults to local (Ollama) — keep it local unless you've
  consciously accepted sending aggregate numbers to a cloud model.

## Gotchas

These are the sharp edges most likely to trip up a first deployment:

- **Use `npm run dev` or `node dist/server.js`, not `toprope start`.** The
  `start` CLI subcommand currently mounts only `/health`; the full `/api/*` routes
  and scheduler come from the server entry point.
- **`GITHUB_TOKEN` is not a fallback for the connectors.** Because the YAML sets
  `api_token: "${GITHUB_API_TOKEN}"`, an unset variable expands to an *empty
  string* (not undefined), so the `?? process.env.GITHUB_TOKEN` fallback won't
  fire. Export `GITHUB_API_TOKEN` / `GIT_API_TOKEN` explicitly. (`dev discover` is
  the exception — it reads `GITHUB_TOKEN` or `--token`.)
- **`doctor` fails on an empty `git.repos: []`** even though `sync git` treats
  empty as "all org repos." List at least one repo for a green check.
- **Edit the plain-string IDs in the YAML** — `claude_code.org_id`,
  `*.github_org`, and `git.org` are not env placeholders and ship with dummy
  values.
- **Environment variables are per-session** on Windows PowerShell. Re-export them
  (or use a script) in each new terminal before running `doctor`/`sync`/`dev`.
- **Backfill oldest-first, without gaps.** Deltas aren't cascaded, so running a
  later range before an earlier adjacent one leaves the boundary delta uncompared.

## Where things live

| Concern | Location |
|---|---|
| Config | `toprope.config.yaml` (or `$TOPROPE_CONFIG`) |
| Database | `storage.sqlite_path` (default `./data/toprope.db`) |
| Migrations | `src/storage/migrations/` (copied to `dist/` on build) |
| Server entry | `src/server.ts` → `dist/server.js` |
| CLI entry | `bin/index.js` → `dist/cli.js` |
| Dashboard build | `src/dashboard/frontend/` → served at `/dashboard` |

## Related

- [Installation](./installation.md)
- [Configuration](./configuration.md)
- [Connectors](./connectors.md)
