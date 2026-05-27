import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {aggregateDailyMetrics} from './analyzer.js';
import {toAnalysisCommit, toAnalysisPR, toAnalysisReviewComment} from './analysis-types.js';
import type {AnalysisCommit, AnalysisPR, AnalysisReviewComment} from './analysis-types.js';
import {createGitProvider} from './providers/factory.js';
import {resolveGitProviderConfigs} from './providers/config.js';
import type {GitProviderConfig, GitProviderType, GitCommit, GitFileDiff, GitPR} from './providers/types.js';
import type {ConnectorInterface, SyncResult} from '../types.js';
import type {GitConnectorConfig} from '../../config/types.js';

const CONNECTOR_NAME = 'git';

function syncStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_last_sync:${providerType}:${identifier}`;
}

interface SyncStateRow {
    value: string;
}

interface DeveloperRow {
    id: string;
    email: string | null;
    external_ids: string | null;
}

interface GitSnapshotRow {
    developer_id: string;
    date: string;
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    prs_opened: number;
    prs_merged: number;
    review_comments_given: number;
    avg_time_to_merge_hours: number | null;
    code_churn_rate: number;
    ai_signature_score: number;
    avg_commit_size: number;
    commit_burst_count: number;
    data_source: string;
}

function getProviderLastSyncTime(db: Database.Database, key: string): string | null {
    const row = db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(key) as SyncStateRow | undefined;
    return row?.value ?? null;
}

function setProviderLastSyncTime(db: Database.Database, key: string, time: string): void {
    db.prepare(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, time);
}

// Build a map from identifier → developer_id, covering:
//   - email (from developers.email)
//   - github:<login>, bitbucket:<login>, gitlab:<login> (from external_ids JSON)
function buildDevLookupMap(db: Database.Database): Map<string, string> {
    const rows = db.prepare('SELECT id, email, external_ids FROM developers').all() as DeveloperRow[];
    const map = new Map<string, string>();

    for (const row of rows) {
        if (row.email) {
            map.set(`email:${row.email.toLowerCase()}`, row.id);
        }
        if (!row.external_ids) continue;
        try {
            const ext = JSON.parse(row.external_ids) as Record<string, string | undefined>;
            for (const [key, value] of Object.entries(ext)) {
                if (!value) continue;
                // git_emails holds a comma-separated list of additional commit
                // emails; register each as an email-lookup rather than a username.
                if (key === 'git_emails') {
                    for (const raw of value.split(',')) {
                        const email = raw.trim().toLowerCase();
                        if (email) map.set(`email:${email}`, row.id);
                    }
                    continue;
                }
                map.set(`${key}:${value}`, row.id);
            }
        } catch {
            // malformed external_ids — skip
        }
    }

    return map;
}

function resolveDeveloperId(
    lookup: Map<string, string>,
    providerType: GitProviderType,
    login: string | null,
    email: string | null,
): string | null {
    if (login) {
        const byLogin = lookup.get(`${providerType}:${login}`);
        if (byLogin) return byLogin;
    }
    if (email) {
        const byEmail = lookup.get(`email:${email.toLowerCase()}`);
        if (byEmail) return byEmail;
    }
    return null;
}

// Merge two snapshots for the same (developer_id, date) from different providers.
// Additive for counts; weighted average for rates and scores.
function mergeSnapshots(a: GitSnapshotRow, b: GitSnapshotRow): GitSnapshotRow {
    const totalCommits = a.commits + b.commits;
    const totalPrs = a.prs_merged + b.prs_merged;

    let avgTTM: number | null = null;
    if (a.avg_time_to_merge_hours !== null && b.avg_time_to_merge_hours !== null && totalPrs > 0) {
        avgTTM = (a.avg_time_to_merge_hours * a.prs_merged + b.avg_time_to_merge_hours * b.prs_merged) / totalPrs;
    } else {
        avgTTM = a.avg_time_to_merge_hours ?? b.avg_time_to_merge_hours;
    }

    const avgCommitSize = totalCommits > 0
        ? (a.avg_commit_size * a.commits + b.avg_commit_size * b.commits) / totalCommits
        : 0;

    const avgAiScore = totalCommits > 0
        ? (a.ai_signature_score * a.commits + b.ai_signature_score * b.commits) / totalCommits
        : 0;

    // Cross-provider churn cannot be recomputed without the full commit set; simple average is an approximation.
    const avgChurn = (a.code_churn_rate + b.code_churn_rate) / 2;

    return {
        developer_id: a.developer_id,
        date: a.date,
        commits: totalCommits,
        lines_added: a.lines_added + b.lines_added,
        lines_removed: a.lines_removed + b.lines_removed,
        files_changed: a.files_changed + b.files_changed,
        prs_opened: a.prs_opened + b.prs_opened,
        prs_merged: totalPrs,
        review_comments_given: a.review_comments_given + b.review_comments_given,
        avg_time_to_merge_hours: avgTTM,
        code_churn_rate: avgChurn,
        ai_signature_score: avgAiScore,
        avg_commit_size: avgCommitSize,
        commit_burst_count: a.commit_burst_count + b.commit_burst_count,
        data_source: a.data_source === b.data_source ? a.data_source : 'multi',
    };
}

function upsertSnapshot(db: Database.Database, snap: GitSnapshotRow): 'written' | 'skipped' {
    const result = db
        .prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
              prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
              code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(developer_id, date) DO UPDATE SET
               commits = excluded.commits,
               lines_added = excluded.lines_added,
               lines_removed = excluded.lines_removed,
               files_changed = excluded.files_changed,
               prs_opened = excluded.prs_opened,
               prs_merged = excluded.prs_merged,
               review_comments_given = excluded.review_comments_given,
               avg_time_to_merge_hours = excluded.avg_time_to_merge_hours,
               code_churn_rate = excluded.code_churn_rate,
               ai_signature_score = excluded.ai_signature_score,
               avg_commit_size = excluded.avg_commit_size,
               commit_burst_count = excluded.commit_burst_count,
               data_source = excluded.data_source`,
        )
        .run(
            randomUUID(),
            snap.developer_id,
            snap.date,
            snap.commits,
            snap.lines_added,
            snap.lines_removed,
            snap.files_changed,
            snap.prs_opened,
            snap.prs_merged,
            snap.review_comments_given,
            snap.avg_time_to_merge_hours,
            snap.code_churn_rate,
            snap.ai_signature_score,
            snap.avg_commit_size,
            snap.commit_burst_count,
            snap.data_source,
        );

    return result.changes > 0 ? 'written' : 'skipped';
}

function providerIdentifier(config: GitProviderConfig): string {
    switch (config.type) {
        case 'github': return config.org;
        case 'bitbucket': return config.workspace;
        case 'gitlab': return config.group;
    }
}

function applyRepoFilter(
    repos: string[],
    include: string[] | undefined,
    exclude: string[] | undefined,
): string[] {
    let filtered = repos;
    if (include && include.length > 0) {
        filtered = filtered.filter((r) => include.includes(r));
    }
    if (exclude && exclude.length > 0) {
        filtered = filtered.filter((r) => !exclude.includes(r));
    }
    return filtered;
}

function parseRepoFilters(rawRepos: string[] | undefined): {include: string[]; exclude: string[]} {
    const include: string[] = [];
    const exclude: string[] = [];
    for (const entry of rawRepos ?? []) {
        if (entry.startsWith('exclude:')) {
            exclude.push(entry.slice('exclude:'.length));
        } else if (entry.startsWith('include:')) {
            include.push(entry.slice('include:'.length));
        } else {
            include.push(entry);
        }
    }
    return {include, exclude};
}

interface ProviderFetchResult {
    commits: AnalysisCommit[];
    prs: AnalysisPR[];
    reviewComments: AnalysisReviewComment[];
    errors: string[];
    stateKey: string;
}

async function fetchProviderData(
    providerConfig: GitProviderConfig,
    now: string,
    db: Database.Database,
): Promise<ProviderFetchResult> {
    const errors: string[] = [];
    const allCommits: AnalysisCommit[] = [];
    const allPRs: AnalysisPR[] = [];
    const allReviewComments: AnalysisReviewComment[] = [];

    const provider = createGitProvider(providerConfig);
    const providerType = provider.name;
    const identifier = providerIdentifier(providerConfig);
    const stateKey = syncStateKey(providerType, identifier);
    const since = getProviderLastSyncTime(db, stateKey) ?? '';

    const rawRepos = 'repos' in providerConfig ? providerConfig.repos : undefined;
    const excludeRepos =
        providerConfig.type === 'github' || providerConfig.type === 'bitbucket'
            ? providerConfig.exclude_repos
            : undefined;
    const {include: includeRepos, exclude: excludeFromList} = parseRepoFilters(rawRepos);
    const allExclude = [...excludeFromList, ...(excludeRepos ?? [])];

    let repoNames: string[] = [];
    try {
        const repos = await provider.listRepos();
        repoNames = repos.filter((r) => !r.isArchived).map((r) => r.name);
    } catch (err) {
        errors.push(
            `[${providerType}] Failed to list repos: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {commits: allCommits, prs: allPRs, reviewComments: allReviewComments, errors, stateKey};
    }

    const reposToSync = applyRepoFilter(
        repoNames,
        includeRepos.length > 0 ? includeRepos : undefined,
        allExclude.length > 0 ? allExclude : undefined,
    );

    for (const repoName of reposToSync) {
        let rawCommits: GitCommit[] = [];
        try {
            rawCommits = await provider.getCommits(repoName, since, now);
        } catch (err) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch commits: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
        }

        for (const rawCommit of rawCommits) {
            let diffs: GitFileDiff[] = [];
            try {
                diffs = await provider.getCommitDiff(repoName, rawCommit.sha);
            } catch {
                // Diff fetch failed — use empty diffs; commit still counts
            }
            // Namespace file paths by repo to prevent false churn collisions
            const namespacedDiffs = diffs.map((d) => ({...d, path: `${repoName}/${d.path}`}));
            allCommits.push(toAnalysisCommit(rawCommit, namespacedDiffs));
        }

        let rawPRs: GitPR[] = [];
        try {
            rawPRs = await provider.getPullRequests(repoName, 'all', since);
        } catch (err) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch PRs: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        for (const pr of rawPRs) {
            allPRs.push(toAnalysisPR(pr));
            try {
                const comments = await provider.getReviewComments(repoName, pr.id);
                for (const c of comments) {
                    allReviewComments.push(toAnalysisReviewComment(c));
                }
            } catch {
                // Review comment fetch failed — skip for this PR
            }
        }
    }

    return {commits: allCommits, prs: allPRs, reviewComments: allReviewComments, errors, stateKey};
}

export class GitSync implements ConnectorInterface {
    private readonly config: GitConnectorConfig;

    constructor(config: GitConnectorConfig) {
        this.config = config;
    }

    getName(): string {
        return CONNECTOR_NAME;
    }

    getLastSyncTime(db: Database.Database): string | null {
        const providers = this.getProviderConfigs();
        let latest: string | null = null;
        for (const pc of providers) {
            const key = syncStateKey(pc.type, providerIdentifier(pc));
            const row = db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(key) as SyncStateRow | undefined;
            const t = row?.value ?? null;
            if (t && (!latest || t > latest)) latest = t;
        }
        return latest;
    }

    async sync(db: Database.Database, providerFilter?: string): Promise<SyncResult> {
        const errors: string[] = [];
        let snapshotsWritten = 0;
        let snapshotsSkipped = 0;
        const now = new Date().toISOString();
        const allUnmatched = new Set<string>();

        const providerConfigs = this.getProviderConfigs().filter(
            (pc) => !providerFilter || pc.type === providerFilter,
        );

        if (providerConfigs.length === 0) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: providerFilter
                    ? [`No provider of type '${providerFilter}' configured`]
                    : ['No git providers configured'],
                lastSyncTime: now,
            };
        }

        const devLookup = buildDevLookupMap(db);
        const churnWindowHours = this.config.analysis?.churn_window_hours ?? 48;

        // Fetch data from all providers separately (for per-provider sync state),
        // then merge before analysis so multi-provider contributions to the same
        // (developer_id, date) are accumulated rather than overwritten.
        const fetchResults: Array<{result: ProviderFetchResult; providerType: GitProviderType}> = [];

        for (const pc of providerConfigs) {
            const result = await fetchProviderData(pc, now, db);
            errors.push(...result.errors);
            fetchResults.push({result, providerType: pc.type});
        }

        // Accumulate snapshots from all providers into a single map keyed by
        // "developer_id:date" so same-day multi-provider data is merged.
        const globalSnapshots = new Map<string, GitSnapshotRow>();

        for (const {result, providerType} of fetchResults) {
            const {commits, prs, reviewComments, stateKey} = result;

            if (commits.length === 0 && prs.length === 0 && reviewComments.length === 0) {
                setProviderLastSyncTime(db, stateKey, now);
                continue;
            }

            const metricsMap = aggregateDailyMetrics(commits, prs, churnWindowHours, reviewComments);

            // Check for unmatched authors
            for (const commit of commits) {
                const devId = resolveDeveloperId(devLookup, providerType, commit.authorLogin, commit.authorEmail);
                if (!devId) {
                    const label = commit.authorLogin ?? commit.authorEmail ?? 'unknown';
                    allUnmatched.add(`${providerType}:${label}`);
                }
            }

            for (const [login, byDate] of metricsMap) {
                const emailForLogin = commits.find((c) => c.authorLogin === login)?.authorEmail ?? null;
                const developerId = resolveDeveloperId(devLookup, providerType, login, emailForLogin);
                if (!developerId) continue;

                for (const [, metrics] of byDate) {
                    const snap: GitSnapshotRow = {
                        developer_id: developerId,
                        date: metrics.date,
                        commits: metrics.commits,
                        lines_added: metrics.lines_added,
                        lines_removed: metrics.lines_removed,
                        files_changed: metrics.files_changed,
                        prs_opened: metrics.prs_opened,
                        prs_merged: metrics.prs_merged,
                        review_comments_given: metrics.review_comments_given,
                        avg_time_to_merge_hours: metrics.avg_time_to_merge_hours,
                        code_churn_rate: metrics.code_churn_rate,
                        ai_signature_score: metrics.ai_signature_score,
                        avg_commit_size: metrics.avg_commit_size,
                        commit_burst_count: metrics.commit_burst_count,
                        data_source: providerType,
                    };

                    const key = `${developerId}:${metrics.date}`;
                    const existing = globalSnapshots.get(key);
                    globalSnapshots.set(key, existing ? mergeSnapshots(existing, snap) : snap);
                }
            }

            setProviderLastSyncTime(db, stateKey, now);
        }

        // Upsert all merged snapshots in a single transaction
        const insertMany = db.transaction(() => {
            for (const snap of globalSnapshots.values()) {
                const outcome = upsertSnapshot(db, snap);
                if (outcome === 'written') snapshotsWritten++;
                else snapshotsSkipped++;
            }
        });

        try {
            insertMany();
        } catch (err) {
            errors.push(
                `Failed to write snapshots: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (allUnmatched.size > 0) {
            errors.push(
                `Unmatched authors (no developer record found): ${[...allUnmatched].join(', ')}`,
            );
        }

        return {connector: CONNECTOR_NAME, snapshotsWritten, snapshotsSkipped, errors, lastSyncTime: now};
    }

    private getProviderConfigs(): GitProviderConfig[] {
        return resolveGitProviderConfigs(this.config);
    }
}
