# Installation

GovProxy is self-hosted. You can run it directly with Node.js or in Docker. This
chapter gets a server running; [Getting started](./getting-started.md) walks
through populating it with data.

## Prerequisites

- **Node.js 22+** (the Docker image is built on `node:22-alpine`).
- **npm** (ships with Node).
- A C/C++ toolchain for native modules — `better-sqlite3` and `argon2` compile on
  install. On Windows this means the "Desktop development with C++" workload (or
  `windows-build-tools`); on Debian/Ubuntu, `build-essential` and `python3`.
- **Git provider / tool API credentials** for whatever you want to connect — see
  [Connectors](./connectors.md). None are required to start the server.
- **(Optional) Ollama** if you want local AI-generated summaries. See
  [Aggregation & AI summaries](./aggregation-and-summaries.md).

## Install from source

```powershell
git clone <your-fork-or-repo-url> govproxy
cd govproxy
npm install
npm run build        # compiles TypeScript to dist/ and builds the dashboard
```

> **TLS note (some corporate networks):** if `npm install` fails TLS
> verification behind a proxy, install the failing package with
> `npm install <pkg> --strict-ssl=false` for that one command.

`npm run build` does three things: builds the React dashboard, compiles the
server/CLI TypeScript to `dist/`, and copies the SQL migrations and the built
dashboard assets into `dist/`. You need it before using the `npx govproxy` CLI or
running the production server.

## Running the server

### Development

```powershell
npm run dev
```

This runs the Fastify server (via `tsx`, no build step) **and** the Vite
dashboard dev server concurrently. The API listens on
**http://localhost:8080**; `GET /health` returns `{"status":"ok"}`. This is the
recommended way to run locally while configuring and testing — it mounts the full
API, the dashboard, and the background scheduler.

To point the dev server at an alternate config file:

```powershell
$env:GOVPROXY_CONFIG = "govproxy.github-only.config.yaml"; npm run dev
```

### Production

```powershell
npm run build
node dist/server.js
```

`dist/server.js` is the package's main entry point. It loads
`govproxy.config.yaml` (or the file named by `GOVPROXY_CONFIG`), runs migrations,
mounts the full API and dashboard, and starts the scheduler.

> **Known limitation:** the `govproxy start` CLI subcommand currently mounts only
> `/health`, not the full API. Use `node dist/server.js` (production) or
> `npm run dev` (development) to serve `/api/*` and the dashboard. This is tracked
> in [Operations & troubleshooting](./operations-and-troubleshooting.md#gotchas).

## Running with Docker

A `Dockerfile` and `docker-compose.yml` ship in the repository root. The image is
a two-stage build (build → slim runtime) that exposes port 8080 and persists the
SQLite database under `/app/data`.

```powershell
docker compose up --build
```

Mount a volume for `data/` so your database and imported expenses survive
container restarts, and supply secrets as environment variables (see
[Configuration](./configuration.md#secrets-and-environment-variables)). Review the
shipped `CMD` against the production-entry note above if the container serves only
`/health`.

## The CLI

After `npm run build`, the CLI is available as:

```powershell
npx govproxy <command>
```

Or run it from source without building:

```powershell
npx tsx src/cli.ts <command>
```

Every command accepts `-c, --config <path>` to select a config file (default:
`govproxy.config.yaml` in the current directory). See the full
[CLI reference](./cli-reference.md).

## Verifying the install

```powershell
npx govproxy db migrate     # create ./data/govproxy.db and apply all migrations
npx govproxy doctor         # validate config, database, and connector credentials
```

`doctor` reports each check with a `Fix:` hint on failure. Get it green before
syncing real data. With no connectors configured it will still validate the
config file and database.

## Next steps

- [Configuration](./configuration.md) — set up `govproxy.config.yaml`
- [Getting started](./getting-started.md) — register teams/developers and pull your first data
