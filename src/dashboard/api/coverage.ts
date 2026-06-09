import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {isAdmin, forbidden} from './guards';

const CONNECTORS = ['copilot', 'claude_code', 'windsurf', 'cursor'] as const;
const GIT_PROVIDERS = ['github', 'bitbucket', 'gitlab'] as const;
const GIT_CONNECTOR = 'git';

export interface DataQualityCoverage {
    high: number;
    medium: number;
    low: number;
    none: number;
}

/**
 * Map a developer's best-signal rank (0–3) to its tier label. Shared so every
 * surface that classifies a developer (the coverage snapshot, the team-compare
 * tier) reads the same boundaries. high=API(3), medium=git(2), low=expense(1),
 * none(0).
 */
export function rankToTier(rank: number): keyof DataQualityCoverage {
    if (rank >= 3) return 'high';
    if (rank === 2) return 'medium';
    if (rank === 1) return 'low';
    return 'none';
}

/**
 * Each registered developer's BEST available signal as a rank (0–3): API tool
 * data = 3 (from tool_snapshots.data_quality), git activity = 2, an expense-only
 * subscription = 1, nothing = 0. git_snapshots carry no per-row quality column,
 * so any git activity is the medium tier per the data-quality model.
 *
 * The single home for "how strong is a developer's data" — both the org coverage
 * snapshot and the per-team comparison tier (compare.ts) fold this map, so the
 * data-quality model can't drift between them.
 */
export function developerDataRanks(db: Database.Database): Map<string, number> {
    const developers = db.prepare('SELECT id FROM developers').all() as {id: string}[];

    const toolRows = db
        .prepare(
            `SELECT developer_id,
                    MAX(CASE data_quality
                            WHEN 'high' THEN 3
                            WHEN 'medium' THEN 2
                            WHEN 'low' THEN 1
                            ELSE 0 END) AS rank
             FROM tool_snapshots
             GROUP BY developer_id`,
        )
        .all() as {developer_id: string; rank: number}[];
    const toolRank = new Map(toolRows.map((r) => [r.developer_id, r.rank]));

    const gitDevs = new Set(
        (db.prepare('SELECT DISTINCT developer_id FROM git_snapshots').all() as {
            developer_id: string;
        }[]).map((r) => r.developer_id),
    );

    const expenseDevs = new Set(
        (
            db
                .prepare(
                    `SELECT DISTINCT developer_id FROM subscriptions
                     WHERE developer_id IS NOT NULL AND seat_revoked_at IS NULL`,
                )
                .all() as {developer_id: string}[]
        ).map((r) => r.developer_id),
    );

    const ranks = new Map<string, number>();
    for (const dev of developers) {
        ranks.set(
            dev.id,
            Math.max(toolRank.get(dev.id) ?? 0, gitDevs.has(dev.id) ? 2 : 0, expenseDevs.has(dev.id) ? 1 : 0),
        );
    }
    return ranks;
}

/**
 * One developer's BEST available signal as a rank (0–3), using the SAME boundaries
 * as {@link developerDataRanks} — tool API quality, then git activity (2), then a
 * live expense-only seat (1), else 0. The single-developer counterpart for callers
 * that need just one id (e.g. the adoption-journey tier) without folding the whole
 * org map, so the data-quality model stays in one place and can't drift.
 */
export function developerDataRank(db: Database.Database, developerId: string): number {
    const toolRank =
        (
            db
                .prepare(
                    `SELECT MAX(CASE data_quality
                                    WHEN 'high' THEN 3
                                    WHEN 'medium' THEN 2
                                    WHEN 'low' THEN 1
                                    ELSE 0 END) AS rank
                     FROM tool_snapshots
                     WHERE developer_id = ?`,
                )
                .get(developerId) as {rank: number | null}
        ).rank ?? 0;

    const hasGit =
        db.prepare('SELECT 1 FROM git_snapshots WHERE developer_id = ? LIMIT 1').get(developerId) !==
        undefined;
    const hasExpense =
        db
            .prepare(
                `SELECT 1 FROM subscriptions
                 WHERE developer_id = ? AND seat_revoked_at IS NULL LIMIT 1`,
            )
            .get(developerId) !== undefined;

    return Math.max(toolRank, hasGit ? 2 : 0, hasExpense ? 1 : 0);
}

/**
 * Org-wide per-developer data-quality counts: each developer bucketed by their
 * best available signal (see {@link developerDataRanks}).
 */
function computeDataQuality(db: Database.Database): DataQualityCoverage {
    const counts: DataQualityCoverage = {high: 0, medium: 0, low: 0, none: 0};
    for (const rank of developerDataRanks(db).values()) {
        counts[rankToTier(rank)] += 1;
    }
    return counts;
}

interface ConnectorStatus {
    connector: string;
    connected: boolean;
    status: string | null;
    last_sync: string | null;
}

function latestSync(
    db: Database.Database,
    connector: string,
): {status: string; started_at: string; finished_at: string | null} | undefined {
    return db
        .prepare(
            `SELECT status, started_at, finished_at
             FROM sync_logs
             WHERE connector = ?
             ORDER BY started_at DESC, rowid DESC
             LIMIT 1`,
        )
        .get(connector) as
        | {status: string; started_at: string; finished_at: string | null}
        | undefined;
}

export function computeConnectors(db: Database.Database): ConnectorStatus[] {
    return CONNECTORS.map((connector) => {
        const row = latestSync(db, connector);
        return {
            connector,
            connected: row !== undefined,
            status: row?.status ?? null,
            last_sync: row ? row.finished_at ?? row.started_at : null,
        };
    });
}

interface GitProviderCoverage {
    provider: string;
    connected: boolean;
    developer_count: number;
    last_sync: string | null;
}

/**
 * Git provider coverage is derived from git_snapshots.data_source (the provider
 * tag written per snapshot). The Phase-1 schema does not track repositories, so
 * coverage is reported as the number of developers with git activity per
 * provider. Last sync comes from the shared 'git' connector's sync log.
 */
export function computeGitProviders(db: Database.Database): GitProviderCoverage[] {
    const rows = db
        .prepare(
            `SELECT data_source AS provider, COUNT(DISTINCT developer_id) AS developer_count
             FROM git_snapshots
             GROUP BY data_source`,
        )
        .all() as {provider: string; developer_count: number}[];
    const byProvider = new Map(rows.map((r) => [r.provider, r.developer_count]));

    const gitSync = latestSync(db, GIT_CONNECTOR);
    const lastSync = gitSync ? gitSync.finished_at ?? gitSync.started_at : null;

    // Report the three known providers, plus any additional data_source values
    // actually present (e.g. a generic 'git' fallback).
    const providers = new Set<string>([...GIT_PROVIDERS, ...byProvider.keys()]);
    return [...providers]
        .sort()
        .filter((p) => p)
        .map((provider) => {
            const developerCount = byProvider.get(provider) ?? 0;
            return {
                provider,
                connected: developerCount > 0,
                developer_count: developerCount,
                last_sync: developerCount > 0 ? lastSync : null,
            };
        });
}

export function registerCoverageRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/coverage', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        return {
            data: {
                data_quality: computeDataQuality(db),
                connectors: computeConnectors(db),
                git_providers: computeGitProviders(db),
            },
        };
    });
}
