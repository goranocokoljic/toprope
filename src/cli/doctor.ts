import fs from 'fs';
import type Database from 'better-sqlite3';
import type {GovProxyConfig} from '../config/types';
import {getMigrationStatus} from '../storage/migrator';
import {resolveGitProviderConfigs} from '../connectors/git/providers/config';
import {createGitProvider} from '../connectors/git/providers/factory';
import type {GitProvider, GitProviderConfig} from '../connectors/git/providers/types';

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
    if (!fs.existsSync(configPath)) {
        return fail(
            'Config file',
            `Not found: ${configPath}`,
            'Create govproxy.config.yaml — see docs/setup.md for a template.',
        );
    }
    return pass('Config file', `Found: ${configPath}`);
}

function checkDatabase(db: Database.Database, migrationsDir: string): CheckResult {
    try {
        const statuses = getMigrationStatus(db, migrationsDir);
        const pending = statuses.filter((s) => !s.applied);
        if (pending.length > 0) {
            return fail(
                'Database migrations',
                `${pending.length} pending migration(s): ${pending.map((m) => m.name).join(', ')}`,
                'Run: govproxy db migrate',
            );
        }
        return pass('Database migrations', `All ${statuses.length} migration(s) applied`);
    } catch (err) {
        return fail(
            'Database migrations',
            `Cannot read migrations: ${err instanceof Error ? err.message : String(err)}`,
            'Ensure the database is accessible and run: govproxy db migrate',
        );
    }
}

async function checkGitHubToken(config: GovProxyConfig): Promise<CheckResult> {
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

async function checkCopilotAccess(config: GovProxyConfig): Promise<CheckResult> {
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

async function checkAnthropicKey(config: GovProxyConfig): Promise<CheckResult> {
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

async function checkWindsurfKey(config: GovProxyConfig): Promise<CheckResult> {
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

function gitProviderFixHint(type: GitProviderConfig['type'], message?: string): string {
    const m = message ?? '';
    if (m.includes(' 401') || m.includes('(401)')) {
        return `${type}: credentials invalid or expired — generate a new token/app password with read access.`;
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
        provider = createGitProvider(pc);
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

async function checkGitProviders(config: GovProxyConfig): Promise<CheckResult[]> {
    const {git} = config.connectors;
    if (!git.enabled) {
        return [pass('Git providers', 'Git connector disabled — skipped')];
    }

    const usingProvidersArray = Array.isArray(git.providers) && git.providers.length > 0;
    if (!usingProvidersArray) {
        // Legacy GitHub shorthand (git.org + git.api_token). Give targeted hints.
        const token = git.api_token ?? process.env.GITHUB_TOKEN ?? '';
        const org = git.org ?? '';
        if (!org && !token) {
            return [
                fail(
                    'Git providers',
                    'No git providers configured',
                    'Add connectors.git.providers[] (bitbucket/gitlab/github), or set git.org + git.api_token for the GitHub shorthand.',
                ),
            ];
        }
        if (!token) {
            return [
                fail(
                    'Git providers',
                    'GitHub shorthand configured but no API token',
                    'Set connectors.git.api_token in config or export GITHUB_TOKEN=<token>.',
                ),
            ];
        }
        if (!org) {
            return [
                fail(
                    'Git providers',
                    'GitHub shorthand configured but no org',
                    'Set connectors.git.org to your GitHub org login.',
                ),
            ];
        }
    }

    const providerConfigs = resolveGitProviderConfigs(git);
    if (providerConfigs.length === 0) {
        return [
            fail(
                'Git providers',
                'No valid git providers configured',
                'Each connectors.git.providers[] entry needs a "type" of github, bitbucket, or gitlab.',
            ),
        ];
    }

    const results: CheckResult[] = [];
    for (const pc of providerConfigs) {
        results.push(await checkOneGitProvider(pc));
    }
    return results;
}

async function checkSummaryModel(config: GovProxyConfig): Promise<CheckResult> {
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
        try {
            const res = await fetch('https://api.anthropic.com/v1/models', {
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

/** Strip a single trailing slash so endpoint + path joins don't double up. */
function trimTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

export async function runDoctor(
    db: Database.Database,
    config: GovProxyConfig,
    configPath: string,
    migrationsDir: string,
): Promise<boolean> {
    console.log('');
    console.log('GovProxy Doctor');
    console.log('─'.repeat(50));

    const checks: CheckResult[] = [];

    checks.push(await checkConfigFile(configPath));
    checks.push(checkDatabase(db, migrationsDir));
    checks.push(await checkGitHubToken(config));
    checks.push(await checkCopilotAccess(config));
    checks.push(await checkAnthropicKey(config));
    checks.push(await checkWindsurfKey(config));
    checks.push(...(await checkGitProviders(config)));
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
        console.log('All checks passed. GovProxy is ready.');
    } else {
        const failed = checks.filter((c) => !c.passed).length;
        console.error(`${failed} check(s) failed. Fix the issues above and re-run govproxy doctor.`);
    }
    console.log('');

    return allPassed;
}
