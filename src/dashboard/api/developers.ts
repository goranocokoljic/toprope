import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';

interface ToolSnapshotRow {
    id: string;
    date: string;
    tool: string;
    data_source: string;
    data_quality: string;
    is_active: number;
    interaction_count: number | null;
    acceptance_count: number | null;
    acceptance_rate: number | null;
    features_used: string | null;
    models_used: string | null;
    estimated_cost: number | null;
    tokens_consumed: number | null;
}

interface GitSnapshotRow {
    id: string;
    date: string;
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    prs_opened: number;
    prs_merged: number;
    ai_signature_score: number | null;
    code_churn_rate: number | null;
}

interface SubscriptionRow {
    id: string;
    tool: string;
    plan: string | null;
    billing_model: string;
    monthly_cost: number | null;
    seat_assigned_at: string | null;
    seat_revoked_at: string | null;
    data_source: string;
}

interface DeveloperDetail {
    id: string;
    name: string;
    email: string | null;
    team: string;
    tool_snapshots: ToolSnapshotRow[];
    git_snapshots: GitSnapshotRow[];
    subscriptions: SubscriptionRow[];
    activity_summary: {
        active_tools: string[];
        active_days_30d: number;
        total_interactions_30d: number;
        total_commits_30d: number;
    };
}

interface TimelinePoint {
    date: string;
    tool_activity: {
        is_active: boolean;
        interaction_count: number;
        tools: string[];
    };
    git_activity: {
        commits: number;
        lines_added: number;
        lines_removed: number;
        ai_signature_score: number | null;
    };
}

export function registerDeveloperRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Params: {id: string}}>('/api/developers/:id', async (request, reply) => {
        const {id} = request.params;

        const dev = db
            .prepare('SELECT id, name, email, team FROM developers WHERE id = ?')
            .get(id) as {id: string; name: string; email: string | null; team: string} | undefined;

        if (!dev) {
            return reply.status(404).send({error: 'Not Found', message: `Developer '${id}' not found`});
        }

        const toolSnapshots = db
            .prepare(
                `SELECT id, date, tool, data_source, data_quality, is_active,
                        interaction_count, acceptance_count, acceptance_rate,
                        features_used, models_used, estimated_cost, tokens_consumed
                 FROM tool_snapshots
                 WHERE developer_id = ?
                 ORDER BY date DESC, tool
                 LIMIT 365`,
            )
            .all(id) as ToolSnapshotRow[];

        const gitSnapshots = db
            .prepare(
                `SELECT id, date, commits, lines_added, lines_removed, files_changed,
                        prs_opened, prs_merged, ai_signature_score, code_churn_rate
                 FROM git_snapshots
                 WHERE developer_id = ?
                 ORDER BY date DESC
                 LIMIT 365`,
            )
            .all(id) as GitSnapshotRow[];

        const subscriptions = db
            .prepare(
                `SELECT id, tool, plan, billing_model, monthly_cost,
                        seat_assigned_at, seat_revoked_at, data_source
                 FROM subscriptions
                 WHERE developer_id = ?
                 ORDER BY tool`,
            )
            .all(id) as SubscriptionRow[];

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffDate = cutoff.toISOString().slice(0, 10);

        const activeTools = db
            .prepare(
                `SELECT DISTINCT tool FROM tool_snapshots
                 WHERE developer_id = ? AND is_active = 1 AND date >= ?
                 ORDER BY tool`,
            )
            .all(id, cutoffDate) as {tool: string}[];

        const activityRow = db
            .prepare(
                `SELECT
                   COUNT(DISTINCT date) as active_days,
                   COALESCE(SUM(interaction_count), 0) as total_interactions
                 FROM tool_snapshots
                 WHERE developer_id = ? AND is_active = 1 AND date >= ?`,
            )
            .get(id, cutoffDate) as {active_days: number; total_interactions: number};

        const commitsRow = db
            .prepare(
                `SELECT COALESCE(SUM(commits), 0) as total_commits
                 FROM git_snapshots
                 WHERE developer_id = ? AND date >= ?`,
            )
            .get(id, cutoffDate) as {total_commits: number};

        const detail: DeveloperDetail = {
            id: dev.id,
            name: dev.name,
            email: dev.email,
            team: dev.team,
            tool_snapshots: toolSnapshots,
            git_snapshots: gitSnapshots,
            subscriptions,
            activity_summary: {
                active_tools: activeTools.map((t) => t.tool),
                active_days_30d: activityRow.active_days,
                total_interactions_30d: activityRow.total_interactions,
                total_commits_30d: commitsRow.total_commits,
            },
        };

        return {data: detail};
    });

    app.get<{Params: {id: string}}>('/api/developers/:id/timeline', async (request, reply) => {
        const {id} = request.params;

        const dev = db
            .prepare('SELECT id FROM developers WHERE id = ?')
            .get(id) as {id: string} | undefined;

        if (!dev) {
            return reply.status(404).send({error: 'Not Found', message: `Developer '${id}' not found`});
        }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const cutoffDate = cutoff.toISOString().slice(0, 10);

        const toolRows = db
            .prepare(
                `SELECT date,
                        MAX(is_active) as is_active,
                        COALESCE(SUM(interaction_count), 0) as interaction_count,
                        GROUP_CONCAT(DISTINCT CASE WHEN is_active = 1 THEN tool END) as tools
                 FROM tool_snapshots
                 WHERE developer_id = ? AND date >= ?
                 GROUP BY date
                 ORDER BY date`,
            )
            .all(id, cutoffDate) as {
            date: string;
            is_active: number;
            interaction_count: number;
            tools: string | null;
        }[];

        const gitRows = db
            .prepare(
                `SELECT date, commits, lines_added, lines_removed, ai_signature_score
                 FROM git_snapshots
                 WHERE developer_id = ? AND date >= ?
                 ORDER BY date`,
            )
            .all(id, cutoffDate) as {
            date: string;
            commits: number;
            lines_added: number;
            lines_removed: number;
            ai_signature_score: number | null;
        }[];

        const gitByDate = new Map(gitRows.map((r) => [r.date, r]));
        const toolByDate = new Map(toolRows.map((r) => [r.date, r]));

        const allDates = new Set([...toolByDate.keys(), ...gitByDate.keys()]);
        const sortedDates = Array.from(allDates).sort();

        const timeline: TimelinePoint[] = sortedDates.map((date) => {
            const t = toolByDate.get(date);
            const g = gitByDate.get(date);

            return {
                date,
                tool_activity: {
                    is_active: (t?.is_active ?? 0) === 1,
                    interaction_count: t?.interaction_count ?? 0,
                    tools: t?.tools ? t.tools.split(',').filter(Boolean) : [],
                },
                git_activity: {
                    commits: g?.commits ?? 0,
                    lines_added: g?.lines_added ?? 0,
                    lines_removed: g?.lines_removed ?? 0,
                    ai_signature_score: g?.ai_signature_score ?? null,
                },
            };
        });

        return {data: timeline};
    });
}
