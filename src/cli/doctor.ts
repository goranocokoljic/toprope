import fs from 'fs';
import type Database from 'better-sqlite3';
import type {TopropeConfig} from '../config/types';
import {resolveConfigPathWithLegacyFallback} from '../config/compat';
import {getMigrationStatus} from '../storage/migrator';
import {resolveAllGitProviders} from '../connectors/git/providers/resolve';
import {loadServerKey} from '../connectors/git/providers/secret';
import {createGitProvider} from '../connectors/git/providers/factory';
import {INTERACTIVE_REQUEST_POLICY} from '../connectors/git/providers/http-retry';
import {GIT_CATCHUP_WINDOW_MAX_DAYS, loadGitSyncHealth} from '../connectors/git/sync';
import type {GitProvider, GitProviderConfig} from '../connectors/git/providers/types';
import {gitResetNotice, gitResetNoticeMessage} from '../connectors/git/reset-notice';
import {diffstatCacheSummary} from './git-cache';
import {trimTrailingSlash} from '../summaries/model-client';

interface CheckResult {
    label: string;
    passed: boolean;
    detail: string;
    fix?: string;
}

function pass(label: string, detail: string): CheckResult {
    return {label, passed: true, detail};
}

function fail(label: string, detail: string, fix: string): CheckResult {
    return {label, passed: false, detail, fix};
}

async function checkConfigFile(configPath: string): Promise<CheckResult> {
    // Honor the legacy govproxy.* fallback so doctor reports the file that is
    // actually loaded, not the (possibly absent) new-name default.
    const resolvedPath = resolveConfigPathWithLegacyFallback(configPath);
    if (!fs.existsSync(resolvedPath)) {
        return fail(
            'Config file',
            `Not found: ${configPath}`,
            'Create toprope.config.yaml — see docs/setup.md for a template.',
        );
    }
    return pass('Config file', `Found: ${resolvedPath}`);
}

function checkDatabase(db: Database.Database, migrationsDir: string): CheckResult {
    try {
        const statuses = getMigrationStatus(db, migrationsDir);
        const pending = statuses.filter((s) => !s.applied);
        if (pending.length > 0) {
            return fail(
                'Database migrations',
                `${pending.length} pending migration(s): ${pending.map((m) => m.name).join(', ')}`,
                'Run: toprope db migrate',
            );
        }
        return pass('Database migrations', `All ${statuses.length} migration(s) applied`);
    } catch (err) {
        return fail(
            'Database migrations',
            `Cannot read migrations: ${err instanceof Error ? err.message : String(err)}`,
            'Ensure the database is accessible and run: toprope db migrate',
        );
    }
}

async function checkGitHubToken(config: TopropeConfig): Promise<CheckResult> {
    const {copilot} = config.connectors;
    if (!copilot.enabled) {
        return pass('GitHub API token', 'Copilot connector disabled — skipped');
    }

    const token = copilot.api_token ?? process.env.GITHUB_TOKEN ?? '';
    const org = copilot.github_org ?? '';

    if (!token) {
        return fail(
            'GitHub API token',
            'No token configured',
            'Set connectors.copilot.api_token in config or export GITHUB_TOKEN=<token>',
        );
    }
    if (!org) {
        return fail(
            'GitHub org',
            'No org configured',
            'Set connectors.copilot.github_org in config',
        );
    }

    try {
        const res = await fetch('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401) {
            return fail(
                'GitHub API token',
                'Token is invalid or expired (401)',
                'Generate a new GitHub personal access token with repo and copilot scopes.',
            );
        }
        if (!res.ok) {
            return fail(
                'GitHub API token',
                `GitHub API returned ${res.status}`,
                'Check that the token has the correct scopes (repo, copilot).',
            );
        }
        return pass('GitHub API token', 'Valid and reachable');
    } catch (err) {
        return fail(
            'GitHub API token',
            `Network error: ${err instanceof Error ? err.message : String(err)}`,
            'Check your network connection and proxy settings.',
        );
    }
}

async function checkCopilotAccess(config: TopropeConfig): Promise<CheckResult> {
    const {copilot} = config.connectors;
    if (!copilot.enabled) {
        return pass('Copilot API access', 'Copilot connector disabled — skipped');
    }

    const token = copilot.api_token ?? process.env.GITHUB_TOKEN ?? '';
    const org = copilot.github_org ?? '';

    if (!token || !org) {
        return fail(
            'Copilot API access',
            'Missing token or org — cannot verify',
            'Fix GitHub API token and org first.',
        );
    }

    try {
        const res = await fetch(
            `https://api.github.com/orgs/${org}/copilot/billing/seats?per_page=1`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (res.status === 403) {
            return fail(
                'Copilot API access',
                `Token lacks Copilot admin access for org "${org}" (403)`,
                'The token needs the manage_billing:copilot scope and org admin rights.',
            );
        }
        if (res.status === 404) {
            return fail(
                'Copilot API access',
                `Org "${org}" not found or Copilot not enabled (404)`,
                'Verify the org name and that GitHub Copilot Business/Enterprise is enabled.',
            );
        }
        if (!res.ok) {
            return fail(
                'Copilot API access',
                `Copilot billing API returned ${res.status}`,
                'Check token scopes: needs manage_billing:copilot.',
            );
        }
        return pass('Copilot API access', `Org "${org}" reachable`);
    } catch (err) {
        return fail(
            'Copilot API access',
            `Network error: ${err instanceof Error ? err.message : String(err)}`,
            'Check your network connection.',
        );
    }
}

async function checkAnthropicKey(config: TopropeConfig): Promise<CheckResult> {
    const {claude_code} = config.connectors;
    if (!claude_code.enabled) {
        return pass('Anthropic API key', 'Claude Code connector disabled — skipped');
    }

    const apiKey = claude_code.api_key ?? process.env.ANTHROPIC_ADMIN_API_KEY ?? '';
    const orgId = claude_code.org_id ?? process.env.ANTHROPIC_ORG_ID ?? '';

    if (!apiKey) {
        return fail(
            'Anthropic API key',
            'No API key configured',
            'Set connectors.claude_code.api_key in config or export ANTHROPIC_ADMIN_API_KEY=<key>',
        );
    }
    if (!orgId) {
        return fail(
            'Anthropic org ID',
            'No org ID configured',
            'Set connectors.claude_code.org_id in config or export ANTHROPIC_ORG_ID=<id>',
        );
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    try {
        const res = await fetch(
            `https://api.anthropic.com/v1/organizations/${orgId}/users/usage?date_from=${yesterday}&date_to=${today}&limit=1`,
            {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'usage-access-costs-2025-01-15',
                    'content-type': 'application/json',
                },
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (res.status === 401) {
            return fail(
                'Anthropic API key',
                'Key is invalid or expired (401)',
                'Generate a new Anthropic Admin API key with analytics access.',
            );
        }
        if (res.status === 403) {
            return fail(
                'Anthropic API key',
                'Key lacks analytics access (403)',
                'The key needs the Usage Analytics permission in the Anthropic admin console.',
            );
        }
        if (!res.ok) {
            return fail(
                'Anthropic API key',
                `Anthropic API returned ${res.status}`,
                'Verify the org ID and that the key has analytics:read permission.',
            );
        }
        return pass('Anthropic API key', 'Valid with analytics access');
    } catch (err) {
        return fail(
            'Anthropic API key',
            `Network error: ${err instanceof Error ? err.message : String(err)}`,
            'Check your network connection.',
        );
    }
}

async function checkWindsurfKey(config: TopropeConfig): Promise<CheckResult> {
    const {windsurf} = config.connectors;
    if (!windsurf.enabled) {
        return pass('Windsurf service key', 'Windsurf connector disabled — skipped');
    }

    const serviceKey = windsurf.service_key ?? process.env.WINDSURF_SERVICE_KEY ?? '';

    if (!serviceKey) {
        return fail(
            'Windsurf service key',
            'No service key configured',
            'Set connectors.windsurf.service_key in config or export WINDSURF_SERVICE_KEY=<key>',
        );
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    try {
        const res = await fetch('https://server.codeium.com/api/v1/analytics/users/usage', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                service_key: serviceKey,
                start_date: yesterday,
                end_date: today,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) {
            return fail(
                'Windsurf service key',
                `Key is invalid or lacks analytics permissions (${res.status})`,
                'Generate a new Windsurf service key with analytics permissions in the Windsurf admin console.',
            );
        }
        if (!res.ok) {
            return fail(
                'Windsurf service key',
                `Windsurf API returned ${res.status}`,
                'Check the service key and that your Windsurf plan includes analytics access.',
            );
        }
        return pass('Windsurf service key', 'Valid with analytics access');
    } catch (err) {
        return fail(
            'Windsurf service key',
            `Network error: ${err instanceof Error ? err.message : String(err)}`,
            'Check your network connection.',
        );
    }
}

async function checkCursorKey(config: TopropeConfig): Promise<CheckResult> {
    const {cursor} = config.connectors;
    if (!cursor.enabled) {
        return pass('Cursor service key', 'Cursor connector disabled — skipped');
    }

    const serviceKey = cursor.service_key ?? process.env.CURSOR_SERVICE_KEY ?? '';

    if (!serviceKey) {
        return fail(
            'Cursor service key',
            'No service key configured',
            'Set connectors.cursor.service_key in config or export CURSOR_SERVICE_KEY=<key>',
        );
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    try {
        const res = await fetch('https://api.cursor.com/analytics/v1/analytics/users/usage', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                service_key: serviceKey,
                start_date: yesterday,
                end_date: today,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) {
            return fail(
                'Cursor service key',
                `Key is invalid or lacks analytics permissions (${res.status})`,
                'Generate a new Cursor service key with analytics access in the Cursor admin dashboard.',
            );
        }
        if (!res.ok) {
            return fail(
                'Cursor service key',
                `Cursor API returned ${res.status}`,
                'Check the service key and that your Cursor plan includes Analytics API access.',
            );
        }
        return pass('Cursor service key', 'Valid with analytics access');
    } catch (err) {
        return fail(
            'Cursor service key',
            `Network error: ${err instanceof Error ? err.message : String(err)}`,
            'Check your network connection.',
        );
    }
}

function gitProviderIdentifier(pc: GitProviderConfig): string {
    switch (pc.type) {
        case 'github':
            return `org "${pc.org}"`;
        case 'bitbucket':
            return `workspace "${pc.workspace}"`;
        case 'gitlab':
            return `group "${pc.group}"`;
    }
}

// Remediation copy for a failed git-provider probe. The SINGLE source of this
// text: `doctor` uses it for CLI output and the admin test-connection API (#198)
// reuses it so UI errors match CLI errors verbatim. Keyed off the HTTP status in
// the provider's thrown message when present, else a per-type setup hint.
export function gitProviderFixHint(type: GitProviderConfig['type'], message?: string): string {
    const m = message ?? '';
    if (m.includes(' 401') || m.includes('(401)')) {
        return `${type}: credentials invalid or expired — generate a new token/app password with read access.`;
    }
    // BEFORE the 403 rule, deliberately (#283 review, SO-2). GitHub signals its PRIMARY rate
    // limit with 403, not 429, and since #283 an interactive client no longer waits one out —
    // so the message that reaches here reads `GitHub API forbidden (403): … API rate limit
    // exceeded …` and the scope rule below would tell an admin their perfectly good token
    // lacks read scopes. Sending someone to rotate a working PAT because the nightly sync
    // spent the org's quota is the worst answer available.
    //
    // Matched on the provider's own wording, not a status: `Rate limit exceeded after N
    // retries` is what all three throw when a rate-limit budget is spent, and `rate limit`
    // covers GitHub's 403 body which the thrown message interpolates verbatim.
    if (/rate limit/i.test(m)) {
        return `${type}: rate limited right now, not a credential problem — wait for the limit to reset and re-run. If this is constant, a sync may be consuming the quota.`;
    }
    if (m.includes(' 403') || m.includes('(403)') || m.includes('forbidden')) {
        return `${type}: token lacks required read scopes (repositories + pull requests).`;
    }
    if (m.includes(' 404') || m.includes('(404)')) {
        return `${type}: workspace/org/group not found — check the identifier in connectors.git.providers[].`;
    }
    switch (type) {
        case 'bitbucket':
            return 'Set providers[].workspace and a valid auth block (app_password needs username + app_password; access_token/oauth need token).';
        case 'gitlab':
            return 'Set providers[].group and a token with read_api + read_repository scopes.';
        default:
            return 'Set providers[].org (or git.org) and a token with repo read access.';
    }
}

// Exact (non-glob) repo slugs configured as includes for a provider. Glob
// patterns and `exclude:` entries are skipped — only literal slugs can be
// verified to exist.
export function exactConfiguredRepos(pc: GitProviderConfig): string[] {
    const exact: string[] = [];
    for (const entry of pc.repos ?? []) {
        if (entry.startsWith('exclude:')) continue;
        const pattern = entry.startsWith('include:') ? entry.slice('include:'.length) : entry;
        if (pattern && !pattern.includes('*') && !pattern.includes('?')) exact.push(pattern);
    }
    return exact;
}

// Configured slugs that don't appear in the provider's repo list. Matches a
// slug against the full name and the last path segment so GitLab short names
// (e.g. "repo" vs "group/repo") are handled.
export function findMissingRepos(configured: string[], repoNames: string[]): string[] {
    if (configured.length === 0) return [];
    const names = new Set(repoNames);
    const shortNames = new Set(repoNames.map((n) => n.split('/').pop() ?? n));
    return configured.filter((slug) => !names.has(slug) && !shortNames.has(slug));
}

async function checkOneGitProvider(pc: GitProviderConfig): Promise<CheckResult> {
    const label = `Git: ${pc.type}`;
    let provider: GitProvider;
    try {
        // Interactive: `doctor` is a human at a terminal waiting for an answer, and BOTH calls
        // below take this client — the probe AND the repo enumeration (#283). `listRepos` used
        // to take a sync's budget, so one `503 Retry-After: 3600` from a provider parked the
        // whole command for up to ten minutes, and a 429 for up to three hours, on a check
        // whose entire value is being cheap and re-runnable.
        provider = createGitProvider(pc, {policy: INTERACTIVE_REQUEST_POLICY});
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(label, msg, gitProviderFixHint(pc.type));
    }
    try {
        await provider.checkAccess();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(label, msg, gitProviderFixHint(pc.type, msg));
    }

    // Only enumerate repos when an explicit slug list is configured — then we
    // can confirm the slugs exist (a typo'd slug otherwise syncs nothing).
    // With no list (monitor-all), the cheap checkAccess() probe is enough.
    const configured = exactConfiguredRepos(pc);
    if (configured.length === 0) {
        return pass(label, `${gitProviderIdentifier(pc)} reachable`);
    }

    let repoNames: string[];
    try {
        repoNames = (await provider.listRepos()).map((r) => r.name);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(label, msg, gitProviderFixHint(pc.type, msg));
    }

    const missing = findMissingRepos(configured, repoNames);
    if (missing.length > 0) {
        return fail(
            label,
            `${gitProviderIdentifier(pc)} reachable, but configured repo(s) not found: ${missing.join(', ')}`,
            `Check the configured repo slug(s) — they must match repositories in ${gitProviderIdentifier(pc)}.`,
        );
    }
    return pass(label, `${gitProviderIdentifier(pc)} reachable (${configured.length} configured repo(s) verified)`);
}

function noGitProvidersDiagnostic(git: TopropeConfig['connectors']['git']): CheckResult {
    // Nothing resolved from the DB or config — give a targeted setup hint based on
    // what the config partially has. (If a DB provider existed, resolve wouldn't be
    // empty, so these messages only speak to the config-file side.)
    const usingProvidersArray = Array.isArray(git.providers) && git.providers.length > 0;
    if (usingProvidersArray) {
        return fail(
            'Git providers',
            'No valid git providers configured',
            'Each connectors.git.providers[] entry needs a "type" of github, bitbucket, or gitlab.',
        );
    }
    // Legacy GitHub shorthand (git.org + git.api_token). Give targeted hints.
    const token = git.api_token ?? process.env.GITHUB_TOKEN ?? '';
    const org = git.org ?? '';
    if (!org && !token) {
        return fail(
            'Git providers',
            'No git providers configured',
            'Connect one in the UI (Admin → Connectors → Git), add connectors.git.providers[] (bitbucket/gitlab/github), or set git.org + git.api_token for the GitHub shorthand.',
        );
    }
    if (!token) {
        return fail(
            'Git providers',
            'GitHub shorthand configured but no API token',
            'Set connectors.git.api_token in config or export GITHUB_TOKEN=<token>.',
        );
    }
    if (!org) {
        return fail(
            'Git providers',
            'GitHub shorthand configured but no org',
            'Set connectors.git.org to your GitHub org login.',
        );
    }
    // org + token both present yet nothing resolved — defensive fall-through.
    return fail(
        'Git providers',
        'No valid git providers configured',
        'Each connectors.git.providers[] entry needs a "type" of github, bitbucket, or gitlab.',
    );
}

/**
 * Whether git data is actually reaching the present (#235) — the ways it can fail to.
 *
 * Returns one result PER CONDITION rather than a single verdict, because the
 * conditions are per-provider and independent. Folding them into one early-returning
 * check would mean a stall on provider A silences a 170-day lag on provider B — and
 * doctor is precisely the command an operator runs *after* seeing a stall, so that is
 * the moment it can least afford to go quiet about everything else.
 *
 * 1. **Stalled** (`fail`): the cursor has been held for `GIT_STALL_ALERT_RUNS`+
 *    consecutive runs. Distinct from the reachability probes above, and NOT
 *    redundant with them: a stalled provider is usually perfectly reachable — one
 *    repo inside it fails every run (oversized, permission drift,
 *    deleted-but-still-listed) and #231 holds the whole provider's cursor rather
 *    than leave a silent snapshot gap. `checkAccess()` passes, the org is fine, and
 *    yet no developer on ANY of that provider's repos has had a new snapshot since
 *    the streak began.
 * 2. **Lagging** (`pass`, but never the word "current"): the cursor IS advancing, but
 *    is still more than one catch-up cap-width behind. This state exists only because
 *    of the cap, and it is the one an operator is most likely to be misled by: right
 *    after excluding the repo that caused a 200-day stall, the next run completes and
 *    the streak clears — so a bare all-clear would declare victory while ~170 days of
 *    snapshots are still missing and several more runs away. It is a `pass` because a
 *    bounded catch-up is working as designed and self-resolves; it is reported because
 *    "working" and "current" are not the same claim.
 *
 * The all-clear is now a POSITIVE currency check (#248) rather than the inference it
 * used to be. It no longer reads "no stalled or lagging providers" (true only because
 * both readers came back empty, an inference with holes: a provider with an open streak
 * of 1-2 held runs is below the stall threshold and excluded from lagging, so it fell
 * through both while its data could be months old; a provider whose `listRepos` returns
 * `[]` advances its cursor forever while importing nothing). Instead it reports the
 * COUNTED `current` set — a cursor within one cap-width of now with no open streak — and
 * names whatever is not yet current, so "current" is a claim earned from the data, not
 * assumed from two absences.
 *
 * Takes the ALREADY-resolved provider set rather than re-resolving: resolution
 * decrypts each DB-connected provider's token, and this is a DB read, not a probe.
 * One {@link loadGitSyncHealth} call classifies every provider in a single pass.
 */
function checkGitStalls(
    db: Database.Database,
    providerConfigs: GitProviderConfig[],
    now: string,
): CheckResult[] {
    const label = 'Git sync progress';
    const results: CheckResult[] = [];
    const health = loadGitSyncHealth(db, providerConfigs, now);

    if (health.stalled.length > 0) {
        const detail = health.stalled
            .map((s) => `${s.type}:${s.identifier} (${s.runs} runs, since ${s.since})`)
            .join(', ');
        results.push(
            fail(
                label,
                `${health.stalled.length} provider(s) stalled — cursor held, importing nothing: ${detail}`,
                'Something fails on every run and holds the whole provider back — usually one bad repo (oversized, permission drift, deleted-but-still-listed), or the provider-level repo listing itself (a token/permission problem). Run "toprope sync all" and read the [provider] / [provider/repo] errors to see which. Fix the access, or if it is one repo you do not need, drop it via connectors.git.providers[].exclude_repos.',
            ),
        );
    }

    if (health.lagging.length > 0) {
        const detail = health.lagging
            .map((l) => `${l.type}:${l.identifier} (${l.daysBehind} days behind, at ${l.cursor})`)
            .join(', ');
        results.push(
            pass(
                label,
                `${health.lagging.length} provider(s) catching up — advancing, but not yet current: ${detail}`,
            ),
        );
    }

    if (results.length === 0) {
        const total = providerConfigs.length;
        if (health.current === total) {
            results.push(
                pass(
                    label,
                    `All ${total} provider(s) current — synced to within the last ${GIT_CATCHUP_WINDOW_MAX_DAYS} days`,
                ),
            );
        } else if (health.current === 0 && health.neverSynced === total) {
            results.push(pass(label, 'No provider has synced yet — nothing to report'));
        } else {
            // Some current, some not. With no stalled or lagging providers here, the
            // "not yet current" remainder is the never-synced ones plus any that fell
            // through every bucket: held below the stall alert, or carrying an
            // unreadable/future-dated cursor that cannot prove currency.
            const notCurrent = total - health.current;
            const held = notCurrent - health.neverSynced;
            const parts: string[] = [];
            if (health.neverSynced > 0) parts.push(`${health.neverSynced} never synced`);
            if (held > 0) {
                parts.push(
                    `${held} held below the stall alert, or with an unreadable or future-dated cursor`,
                );
            }
            results.push(
                pass(
                    label,
                    `${health.current} of ${total} provider(s) current; ${notCurrent} not yet current (${parts.join(', ')})`,
                ),
            );
        }
    }
    return results;
}

async function checkGitProviders(
    db: Database.Database,
    config: TopropeConfig,
): Promise<CheckResult[]> {
    const {git} = config.connectors;
    if (!git.enabled) {
        return [pass('Git providers', 'Git connector disabled — skipped')];
    }

    // DB-connected providers ∪ config-file providers (DB wins on overlap) — the
    // same seam the sync pipeline uses, so doctor validates UI-connected
    // providers for free.
    const providerConfigs = resolveAllGitProviders(db, loadServerKey(), git);
    if (providerConfigs.length === 0) {
        return [noGitProvidersDiagnostic(git)];
    }

    const results: CheckResult[] = [];
    for (const pc of providerConfigs) {
        results.push(await checkOneGitProvider(pc));
    }
    results.push(...checkGitStalls(db, providerConfigs, new Date().toISOString()));
    return results;
}

/**
 * Report a pending git-data reset notice (#266). Migration 043 clears the imported git data
 * and its cursors, but NOT the derived weekly/monthly/quarterly/yearly rollups — so until
 * both a resync and an `aggregate backfill` have run, `/api/aggregates` serves pre-reset
 * totals over zero snapshots. Nothing else surfaces that: `runMigrations` prints a count and
 * every other check would pass (the providers are reachable, the cursors are honestly absent).
 * This is the graduated #235 rule — a run that completes is not a claim that the data is
 * current — so the notice FAILS the doctor until an operator acknowledges it.
 */
function checkGitResetNotice(db: Database.Database): CheckResult {
    const migrationId = gitResetNotice(db);
    if (migrationId === null) {
        // The label states what was MEASURED, not a currency claim: the absence of this marker
        // means no migration is asking for a rebuild, which is NOT evidence that the rollups are
        // current (migration 042 reset git data with no marker at all). Naming it "Git data
        // currency · current" would be inferring a positive claim from a narrower check — the
        // graduated #235 rule.
        return pass('Git reset notice', 'none pending');
    }
    return fail(
        'Git reset notice',
        `migration ${migrationId} reset the imported git data — resync + rollup rebuild owed`,
        gitResetNoticeMessage(migrationId),
    );
}

/**
 * Report how large the per-commit diffstat cache has grown (#286).
 *
 * INFORMATIONAL — it always passes, and that is the right shape. There is no size at which
 * the cache is wrong: it holds an immutable memo of an idempotent remote read, it is never
 * consulted for freshness, and it can be emptied at any moment with no data loss (the cost is
 * re-fetching). So there is no threshold to fail on and no fix to prescribe. What was missing
 * was the SIGNAL: the table grows monotonically with distinct commits ever synced, is uncapped
 * per commit, and is the first place this schema persists real source-tree paths from private
 * repos — and nothing said how big it was. `toprope git cache clear` is how an operator acts
 * on what this line tells them.
 */
function checkDiffstatCache(db: Database.Database): CheckResult {
    return pass('Diffstat cache', diffstatCacheSummary(db));
}

async function checkSummaryModel(config: TopropeConfig): Promise<CheckResult> {
    const {summaries} = config;
    if (!summaries?.enabled) {
        return pass('Summary model', 'Summaries disabled — skipped');
    }

    const modelType = summaries.model?.type ?? 'ollama';
    const apiKey = summaries.model?.api_key;

    if (modelType === 'anthropic') {
        if (!apiKey) {
            return fail(
                'Summary model',
                'No API key configured for Anthropic summary model',
                'Set summaries.model.api_key in config.',
            );
        }
        const baseUrl = trimTrailingSlash(summaries.model?.endpoint ?? 'https://api.anthropic.com');
        try {
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                signal: AbortSignal.timeout(8_000),
            });
            if (res.status === 401) {
                return fail(
                    'Summary model',
                    'Anthropic key invalid (401)',
                    'Set a valid Anthropic API key under summaries.model.api_key in config.',
                );
            }
            if (!res.ok) {
                return fail(
                    'Summary model',
                    `Anthropic models endpoint returned ${res.status}`,
                    'Verify summaries.model.api_key is valid.',
                );
            }
            return pass('Summary model', `Anthropic endpoint reachable (${summaries.model?.model_name ?? 'default'})`);
        } catch (err) {
            return fail(
                'Summary model',
                `Cannot reach Anthropic API: ${err instanceof Error ? err.message : String(err)}`,
                'Check your network connection.',
            );
        }
    }

    if (modelType === 'ollama') {
        const baseUrl = trimTrailingSlash(summaries.model?.endpoint ?? 'http://localhost:11434');
        try {
            const res = await fetch(`${baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) {
                return fail(
                    'Summary model',
                    `Ollama returned ${res.status}`,
                    'Ensure Ollama is running: ollama serve',
                );
            }
            return pass('Summary model', `Ollama reachable at ${baseUrl}`);
        } catch {
            return fail(
                'Summary model',
                `Cannot reach Ollama at ${baseUrl}`,
                'Start Ollama with: ollama serve',
            );
        }
    }

    if (modelType === 'openai') {
        const baseUrl = trimTrailingSlash(summaries.model?.endpoint ?? 'https://api.openai.com');
        try {
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: apiKey ? {authorization: `Bearer ${apiKey}`} : {},
                signal: AbortSignal.timeout(8_000),
            });
            if (res.status === 401) {
                return fail(
                    'Summary model',
                    'OpenAI key invalid (401)',
                    'Set a valid key under summaries.model.api_key in config.',
                );
            }
            if (!res.ok) {
                return fail(
                    'Summary model',
                    `OpenAI endpoint returned ${res.status}`,
                    `Verify summaries.model.endpoint (${baseUrl}) and api_key.`,
                );
            }
            return pass('Summary model', `OpenAI endpoint reachable (${summaries.model?.model_name ?? 'default'})`);
        } catch (err) {
            return fail(
                'Summary model',
                `Cannot reach OpenAI endpoint at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
                'Check the endpoint URL and your network connection.',
            );
        }
    }

    return pass('Summary model', `Model type "${modelType}" — skipping reachability check`);
}

export async function runDoctor(
    db: Database.Database,
    config: TopropeConfig,
    configPath: string,
    migrationsDir: string,
): Promise<boolean> {
    console.log('');
    console.log('Toprope Doctor');
    console.log('─'.repeat(50));

    const checks: CheckResult[] = [];

    checks.push(await checkConfigFile(configPath));
    checks.push(checkDatabase(db, migrationsDir));
    checks.push(await checkGitHubToken(config));
    checks.push(await checkCopilotAccess(config));
    checks.push(await checkAnthropicKey(config));
    checks.push(await checkWindsurfKey(config));
    checks.push(await checkCursorKey(config));
    checks.push(...(await checkGitProviders(db, config)));
    checks.push(checkGitResetNotice(db));
    checks.push(checkDiffstatCache(db));
    checks.push(await checkSummaryModel(config));

    let allPassed = true;
    for (const check of checks) {
        const icon = check.passed ? '✓' : '✗';
        const line = `  ${icon}  ${check.label.padEnd(24)} ${check.detail}`;
        if (check.passed) {
            console.log(line);
        } else {
            console.error(line);
            console.error(`       Fix: ${check.fix}`);
            allPassed = false;
        }
    }

    console.log('');
    if (allPassed) {
        console.log('All checks passed. Toprope is ready.');
    } else {
        const failed = checks.filter((c) => !c.passed).length;
        console.error(`${failed} check(s) failed. Fix the issues above and re-run toprope doctor.`);
    }
    console.log('');

    return allPassed;
}
