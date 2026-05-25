import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {GitClient} from './client';
import {aggregateDailyMetrics} from './analyzer';
import type {ConnectorInterface, SyncResult} from '../types';
import type {GitConnectorConfig} from '../../config/types';

const CONNECTOR_NAME = 'git';
const SYNC_STATE_KEY = 'git_last_sync';

interface SyncStateRow {
    value: string;
}

interface DeveloperRow {
    id: string;
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
}

function getLastSyncTime(db: Database.Database): string | null {
    const row = db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(SYNC_STATE_KEY) as SyncStateRow | undefined;
    return row?.value ?? null;
}

function setLastSyncTime(db: Database.Database, time: string): void {
    db.prepare(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(SYNC_STATE_KEY, time);
}

function buildLoginToDevIdMap(db: Database.Database): Map<string, string> {
    const rows = db.prepare('SELECT id, external_ids FROM developers').all() as DeveloperRow[];
    const map = new Map<string, string>();
    for (const row of rows) {
        if (!row.external_ids) continue;
        try {
            const ext = JSON.parse(row.external_ids) as Record<string, string | undefined>;
            if (ext.github) map.set(ext.github, row.id);
        } catch {
            // malformed external_ids — skip
        }
    }
    return map;
}

function upsertSnapshot(db: Database.Database, snap: GitSnapshotRow): 'written' | 'skipped' {
    const result = db
        .prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
              prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
              code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
               commit_burst_count = excluded.commit_burst_count`,
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
        );

    return result.changes > 0 ? 'written' : 'skipped';
}

function filterRepos(
    allRepos: string[],
    include: string[] | undefined,
    exclude: string[] | undefined,
): string[] {
    let repos = allRepos;
    if (include && include.length > 0) {
        repos = repos.filter((r) => include.includes(r));
    }
    if (exclude && exclude.length > 0) {
        repos = repos.filter((r) => !exclude.includes(r));
    }
    return repos;
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
        return getLastSyncTime(db);
    }

    async sync(db: Database.Database): Promise<SyncResult> {
        const errors: string[] = [];
        let snapshotsWritten = 0;
        let snapshotsSkipped = 0;
        const now = new Date().toISOString();

        const token = this.config.api_token ?? process.env.GITHUB_TOKEN ?? '';
        const org = this.config.org ?? '';

        if (!token || !org) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: ['Missing required config: org and api_token (or GITHUB_TOKEN env)'],
                lastSyncTime: now,
            };
        }

        const client = new GitClient({org, token});
        const loginToDevId = buildLoginToDevIdMap(db);
        const since = getLastSyncTime(db) ?? undefined;
        const churnWindowHours = this.config.analysis?.churn_window_hours ?? 48;

        // Discover repos
        let allRepoNames: string[] = [];
        try {
            const repos = await client.listRepos();
            allRepoNames = repos.map((r) => r.name);
        } catch (err) {
            errors.push(
                `Failed to list repos: ${err instanceof Error ? err.message : String(err)}`,
            );
            return {connector: CONNECTOR_NAME, snapshotsWritten, snapshotsSkipped, errors, lastSyncTime: now};
        }

        // Config may specify include/exclude as a flat list of repo names or "include:X/exclude:X" prefixes.
        // Accept both plain names and "include:name" / "exclude:name" prefixes for forward compat.
        const includeRepos: string[] = [];
        const excludeRepos: string[] = [];
        for (const entry of this.config.repos ?? []) {
            if (entry.startsWith('exclude:')) {
                excludeRepos.push(entry.slice('exclude:'.length));
            } else if (entry.startsWith('include:')) {
                includeRepos.push(entry.slice('include:'.length));
            } else {
                includeRepos.push(entry);
            }
        }

        const reposToSync = filterRepos(
            allRepoNames,
            includeRepos.length > 0 ? includeRepos : undefined,
            excludeRepos.length > 0 ? excludeRepos : undefined,
        );

        let writeError = false;

        for (const repoName of reposToSync) {
            let commits: import('./client').GitCommit[] = [];
            let prs: import('./client').GitPullRequest[] = [];

            try {
                commits = await client.getCommits(repoName, since);
            } catch (err) {
                errors.push(
                    `[${repoName}] Failed to fetch commits: ${err instanceof Error ? err.message : String(err)}`,
                );
                continue;
            }

            try {
                prs = await client.getPullRequests(repoName, since);
            } catch (err) {
                errors.push(
                    `[${repoName}] Failed to fetch PRs: ${err instanceof Error ? err.message : String(err)}`,
                );
                // Continue with commits-only data
            }

            // Skip repos with zero activity — no errors, just nothing to write
            if (commits.length === 0 && prs.length === 0) continue;

            const metricsMap = aggregateDailyMetrics(commits, prs, churnWindowHours);

            const insertMany = db.transaction(() => {
                for (const [login, byDate] of metricsMap) {
                    const developerId = loginToDevId.get(login);
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
                        };

                        const outcome = upsertSnapshot(db, snap);
                        if (outcome === 'written') snapshotsWritten++;
                        else snapshotsSkipped++;
                    }
                }
            });

            try {
                insertMany();
            } catch (err) {
                writeError = true;
                errors.push(
                    `[${repoName}] Failed to write snapshots: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        if (!writeError) {
            try {
                setLastSyncTime(db, now);
            } catch (err) {
                errors.push(
                    `Failed to update sync state: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        return {connector: CONNECTOR_NAME, snapshotsWritten, snapshotsSkipped, errors, lastSyncTime: now};
    }
}
