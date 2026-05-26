import fs from 'fs';
import type Database from 'better-sqlite3';
import type {GovProxyConfig} from '../config/types';
import {getMigrationStatus} from '../storage/migrator';

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

async function checkGitRepos(config: GovProxyConfig): Promise<CheckResult> {
    const {git} = config.connectors;
    if (!git.enabled) {
        return pass('Git repos', 'Git connector disabled — skipped');
    }

    const repos = git.repos ?? [];
    if (repos.length === 0) {
        return fail(
            'Git repos',
            'No repos configured',
            'Add repos under connectors.git.repos in config (e.g. ["owner/repo"]).',
        );
    }

    const token = git.api_token ?? process.env.GITHUB_TOKEN ?? '';
    if (!token) {
        return fail(
            'Git repos',
            'No API token configured for git connector',
            'Set connectors.git.api_token in config or export GITHUB_TOKEN=<token>',
        );
    }

    const checked = repos.slice(0, 5);
    const unreachable: string[] = [];
    for (const repo of checked) {
        try {
            const res = await fetch(`https://api.github.com/repos/${repo}`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) {
                unreachable.push(`${repo} (${res.status})`);
            }
        } catch {
            unreachable.push(`${repo} (network error)`);
        }
    }

    if (unreachable.length > 0) {
        return fail(
            'Git repos',
            `${unreachable.length} repo(s) unreachable: ${unreachable.join(', ')}`,
            'Verify repo names and that the token has repo read access.',
        );
    }
    const suffix = repos.length > checked.length ? ` (first ${checked.length} checked)` : '';
    return pass('Git repos', `${repos.length} repo(s) configured and reachable${suffix}`);
}

async function checkSummaryModel(config: GovProxyConfig): Promise<CheckResult> {
    const {summaries} = config;
    if (!summaries?.enabled) {
        return pass('Summary model', 'Summaries disabled — skipped');
    }

    const modelType = summaries.model?.type ?? 'anthropic';
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
        const baseUrl = 'http://localhost:11434';
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

    return pass('Summary model', `Model type "${modelType}" — skipping reachability check`);
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
    checks.push(await checkGitRepos(config));
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
