import type Database from 'better-sqlite3';
import type {TopropeConfig} from '../config/types';
import {resolveAllGitProviders} from '../connectors/git/providers/resolve';
import {loadServerKey} from '../connectors/git/providers/secret';
import {
    GIT_CATCHUP_WINDOW_MAX_DAYS,
    latestProviderCursor,
    loadLaggingProviders,
    loadStalledProviders,
    type LaggingProvider,
    type StalledProvider,
} from '../connectors/git/sync';

interface ConnectorStatus {
    name: string;
    enabled: boolean;
    lastSync: string | null;
    devsTracked: number;
    reposTracked?: number;
}

interface StatusData {
    totalDevelopers: number;
    activeDevelopers: number;
    teamCount: number;
    connectors: ConnectorStatus[];
    /**
     * Git providers whose cursor has been held for GIT_STALL_ALERT_RUNS+ consecutive
     * runs (#235), and those advancing but still more than one catch-up cap-width
     * behind. Both empty when the git connector is disabled; the two sets are disjoint.
     *
     * Reported per PROVIDER, on their own lines, because the `Git` connector line is
     * per CONNECTOR and cannot express either state: a provider is what stalls, and
     * one line cannot say "reachable, advancing, and 170 days behind" for one of three
     * providers. (The connector line's own "last sync" is the newest per-provider
     * cursor `git_last_sync:<type>:<container>`, resolved via
     * {@link latestProviderCursor} — #246. It is a single connector-wide freshness
     * instant and still cannot express a per-provider stall or catch-up, which is why
     * those remain separate lines.)
     */
    gitStalls: StalledProvider[];
    gitLagging: LaggingProvider[];
    activeSubscriptions: number;
    totalMonthlyCost: number;
    wasteAlertCount: number;
    monthlyWaste: number;
    dataQuality: {high: number; medium: number; low: number};
}

/**
 * The stalled + lagging provider sets for the status report (#235), or empty when
 * git is off. Resolves providers ONCE, the same way `doctor` does — DB-connected ∪
 * config-file — so both commands report on the identical set.
 */
function collectGitHealth(
    db: Database.Database,
    config: TopropeConfig,
    now: string,
): {stalls: StalledProvider[]; lagging: LaggingProvider[]; lastSync: string | null} {
    const {git} = config.connectors;
    if (!git.enabled) return {stalls: [], lagging: [], lastSync: null};
    // Resolve providers ONCE for all three git-health reads — the newest cursor,
    // the stalls, and the lagging set all derive from the same resolved set.
    const providerConfigs = resolveAllGitProviders(db, loadServerKey(), git);
    return {
        stalls: loadStalledProviders(db, providerConfigs),
        lagging: loadLaggingProviders(db, providerConfigs, now),
        lastSync: latestProviderCursor(db, providerConfigs),
    };
}

function getLastSync(db: Database.Database, key: string): string | null {
    const row = db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(key) as {value: string} | undefined;
    return row?.value ?? null;
}

function formatTimeAgo(isoTime: string | null): string {
    if (!isoTime) return 'never';
    const diff = Date.now() - new Date(isoTime).getTime();
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (hours >= 24) return `${Math.floor(hours / 24)}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}

function collectStatus(db: Database.Database, config: TopropeConfig): StatusData {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const gitHealth = collectGitHealth(db, config, new Date().toISOString());

    const totalDevs = (
        db.prepare('SELECT COUNT(*) as cnt FROM developers').get() as {cnt: number}
    ).cnt;

    const activeDevs = (
        db
            .prepare(
                'SELECT COUNT(DISTINCT developer_id) as cnt FROM tool_snapshots WHERE is_active = 1 AND date >= ?',
            )
            .get(cutoffDate) as {cnt: number}
    ).cnt;

    const teamCount = (
        db.prepare('SELECT COUNT(*) as cnt FROM teams').get() as {cnt: number}
    ).cnt;

    const devsPerTool = db
        .prepare(
            'SELECT tool, COUNT(DISTINCT developer_id) as cnt FROM tool_snapshots WHERE is_active = 1 AND date >= ? GROUP BY tool',
        )
        .all(cutoffDate) as {tool: string; cnt: number}[];

    const devsPerToolMap = new Map(devsPerTool.map((r) => [r.tool, r.cnt]));

    const gitRepoCount = config.connectors.git.repos?.length ?? 0;

    const connectors: ConnectorStatus[] = [
        {
            name: 'Copilot',
            enabled: config.connectors.copilot.enabled,
            lastSync: getLastSync(db, 'copilot_last_sync'),
            devsTracked: devsPerToolMap.get('copilot') ?? 0,
        },
        {
            name: 'Claude Code',
            enabled: config.connectors.claude_code.enabled,
            lastSync: getLastSync(db, 'claude_code_last_sync'),
            devsTracked: devsPerToolMap.get('claude_code') ?? 0,
        },
        {
            name: 'Windsurf',
            enabled: config.connectors.windsurf.enabled,
            lastSync: getLastSync(db, 'windsurf_last_sync'),
            devsTracked: devsPerToolMap.get('windsurf') ?? 0,
        },
        {
            name: 'Cursor',
            enabled: config.connectors.cursor.enabled,
            lastSync: getLastSync(db, 'cursor_last_sync'),
            devsTracked: devsPerToolMap.get('cursor') ?? 0,
        },
        {
            name: 'Git',
            enabled: config.connectors.git.enabled,
            lastSync: gitHealth.lastSync,
            devsTracked: 0,
            reposTracked: gitRepoCount,
        },
    ];

    const subRow = db
        .prepare(
            'SELECT COUNT(*) as cnt, COALESCE(SUM(monthly_cost), 0) as total FROM subscriptions WHERE seat_revoked_at IS NULL',
        )
        .get() as {cnt: number; total: number};

    const wasteRow = db
        .prepare(
            'SELECT COUNT(*) as cnt, COALESCE(SUM(monthly_waste), 0) as total FROM waste_alerts WHERE resolved_at IS NULL',
        )
        .get() as {cnt: number; total: number};

    const qualityRows = db
        .prepare(
            "SELECT data_quality, COUNT(DISTINCT developer_id) as cnt FROM tool_snapshots WHERE date >= ? GROUP BY data_quality",
        )
        .all(cutoffDate) as {data_quality: string; cnt: number}[];

    const quality = {high: 0, medium: 0, low: 0};
    for (const row of qualityRows) {
        if (row.data_quality === 'high') quality.high = row.cnt;
        else if (row.data_quality === 'medium') quality.medium = row.cnt;
        else if (row.data_quality === 'low') quality.low = row.cnt;
    }

    return {
        totalDevelopers: totalDevs,
        activeDevelopers: activeDevs,
        teamCount,
        connectors,
        gitStalls: gitHealth.stalls,
        gitLagging: gitHealth.lagging,
        activeSubscriptions: subRow.cnt,
        totalMonthlyCost: subRow.total,
        wasteAlertCount: wasteRow.cnt,
        monthlyWaste: wasteRow.total,
        dataQuality: quality,
    };
}

export function printStatus(db: Database.Database, config: TopropeConfig): void {
    const data = collectStatus(db, config);
    const LINE = '─'.repeat(50);

    console.log('');
    console.log('Toprope Status');
    console.log(LINE);

    const label = (l: string, v: string): void => {
        console.log(`${l.padEnd(20)}${v}`);
    };

    label('Developers:', `${data.totalDevelopers} registered (${data.activeDevelopers} active)`);
    label('Teams:', String(data.teamCount));

    console.log('Connectors:');
    for (const c of data.connectors) {
        if (!c.enabled) {
            console.log(`  ${c.name.padEnd(14)}disabled`);
            continue;
        }
        const syncInfo = formatTimeAgo(c.lastSync);
        const tracked =
            c.reposTracked !== undefined
                ? `${c.reposTracked} repos`
                : `${c.devsTracked} devs tracked`;
        const status = c.lastSync ? `✓ connected` : `○ not synced`;
        const detail = c.lastSync ? ` (last sync: ${syncInfo}, ${tracked})` : '';
        console.log(`  ${c.name.padEnd(14)}${status}${detail}`);
    }

    // Printed under the connector block rather than folded into the Git line: both
    // states are per-PROVIDER, and the Git line is per-CONNECTOR (see StatusData.gitStalls).
    const pad = ''.padEnd(14);
    for (const s of data.gitStalls) {
        console.log(
            `  ${pad}⚠ ${s.type}:${s.identifier} stalled — cursor held for ${s.runs} consecutive runs since ${formatTimeAgo(s.since)}; importing nothing`,
        );
    }
    // Advancing but behind: reported separately and NOT as a warning, because a
    // bounded catch-up is working as designed. Saying nothing here is what would
    // mislead — "no stall" would read as "data is current" when it is months old.
    for (const l of data.gitLagging) {
        console.log(
            `  ${pad}⋯ ${l.type}:${l.identifier} catching up — ${l.daysBehind} days behind; advancing up to ${GIT_CATCHUP_WINDOW_MAX_DAYS} days per run`,
        );
    }
    if (data.gitStalls.length > 0) {
        console.log(`  ${pad}  Run "toprope doctor" for the fix.`);
    }

    const cost = `$${data.totalMonthlyCost.toFixed(0)}/mo`;
    label('Subscriptions:', `${data.activeSubscriptions} active (${cost})`);

    if (data.wasteAlertCount > 0) {
        const waste = `$${data.monthlyWaste.toFixed(0)}/mo potential savings`;
        label('Waste detected:', `${data.wasteAlertCount} alerts (${waste})`);
    } else {
        label('Waste detected:', 'none');
    }

    const {high, medium, low} = data.dataQuality;
    label('Data coverage:', `HIGH: ${high} devs | MEDIUM: ${medium} devs | LOW: ${low} devs`);

    console.log('');
}
