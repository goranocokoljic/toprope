import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {generateCoachingSignalsForPeriod} from '../../../src/coaching/available/generator';
import type {
    CoachingMetricContext,
    CoachingSignalType,
} from '../../../src/coaching/available/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const NOW = new Date('2026-05-20T12:00:00.000Z');

let db: Database.Database;
beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    addTeam(db, 'eng');
});
afterEach(() => db.close());

function seedDev(name: string): string {
    return addDeveloper(db, name, 'eng', `${name}@example.com`, name).id;
}

interface GitSeed {
    devId: string;
    date: string;
    commits?: number;
    churn?: number | null;
}
function seedGit(s: GitSeed): void {
    db.prepare(
        `INSERT INTO git_snapshots
         (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
          prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
          code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count)
         VALUES (?, ?, ?, ?, 100, 20, 3, 0, 0, 0, NULL, ?, 0.5, 40, 0)`,
    ).run(randomUUID(), s.devId, s.date, s.commits ?? 3, s.churn ?? null);
}

interface ToolSeed {
    devId: string;
    date: string;
    acceptance?: number | null;
    quality?: string;
}
function seedTool(s: ToolSeed): void {
    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active,
          interaction_count, acceptance_count, acceptance_rate)
         VALUES (?, ?, ?, 'copilot', 'api', ?, 1, 20, 10, ?)`,
    ).run(randomUUID(), s.devId, s.date, s.quality ?? 'high', s.acceptance ?? null);
}

interface SignalRow {
    signal_type: CoachingSignalType;
    basis: string;
    observation: string;
    metric_context: string | null;
}
function signalsFor(devId: string, period: string): Map<CoachingSignalType, SignalRow> {
    const rows = db
        .prepare(
            `SELECT signal_type, basis, observation, metric_context
             FROM coaching_signals WHERE developer_id = ? AND period = ?`,
        )
        .all(devId, period) as SignalRow[];
    return new Map(rows.map((r) => [r.signal_type, r]));
}
function ctx(row: SignalRow): CoachingMetricContext {
    return JSON.parse(row.metric_context as string) as CoachingMetricContext;
}

/** A git-only developer: elevated churn in May vs a low baseline, no tool data. */
function seedGitOnlyDev(): string {
    const id = seedDev('git-dev');
    // Baseline months Jan–Apr: low churn.
    for (const m of ['01', '02', '03', '04']) {
        seedGit({devId: id, date: `2026-${m}-10`, churn: 0.2});
        seedGit({devId: id, date: `2026-${m}-17`, churn: 0.2});
    }
    // May: elevated churn across 3 active days.
    seedGit({devId: id, date: '2026-05-05', churn: 0.6});
    seedGit({devId: id, date: '2026-05-06', churn: 0.6});
    seedGit({devId: id, date: '2026-05-07', churn: 0.6});
    return id;
}

/** A measured developer: high-tier tool data with a rising acceptance trend. */
function seedToolDev(): string {
    const id = seedDev('tool-dev');
    // Baseline tool acceptance (Apr) + git churn baseline.
    seedTool({devId: id, date: '2026-04-10', acceptance: 0.6});
    seedTool({devId: id, date: '2026-04-17', acceptance: 0.6});
    seedGit({devId: id, date: '2026-04-10', churn: 0.3});
    // May: higher acceptance + steady churn.
    seedTool({devId: id, date: '2026-05-05', acceptance: 0.75});
    seedTool({devId: id, date: '2026-05-06', acceptance: 0.75});
    seedGit({devId: id, date: '2026-05-05', churn: 0.3});
    seedGit({devId: id, date: '2026-05-06', churn: 0.3});
    return id;
}

describe('generateCoachingSignalsForPeriod', () => {
    it('generates churn reflection from the developer\'s own trajectory (git_estimate)', () => {
        const id = seedGitOnlyDev();
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        const signals = signalsFor(id, '2026-05');
        const churn = signals.get('churn_reflection');
        expect(churn).toBeDefined();
        expect(churn!.basis).toBe('git_estimate');
        expect(ctx(churn!).category).toBe('elevated');
    });

    it('does NOT fabricate an acceptance trend for a git-only developer', () => {
        const id = seedGitOnlyDev();
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        expect(signalsFor(id, '2026-05').has('acceptance_trend')).toBe(false);
    });

    it('generates a measured acceptance trend when tool data exists', () => {
        const id = seedToolDev();
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        const acc = signalsFor(id, '2026-05').get('acceptance_trend');
        expect(acc).toBeDefined();
        expect(acc!.basis).toBe('measured');
        expect(ctx(acc!).category).toBe('rising');
    });

    it('generates journey coaching with a tier-aware basis', () => {
        const gitId = seedGitOnlyDev();
        const toolId = seedToolDev();
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        // Git-only journey is an estimate; measured-tier journey is measured.
        expect(signalsFor(gitId, '2026-05').get('journey_coaching')!.basis).toBe('git_estimate');
        expect(signalsFor(toolId, '2026-05').get('journey_coaching')!.basis).toBe('measured');
    });

    it('generates a tier-aware personal insight', () => {
        const gitId = seedGitOnlyDev();
        const toolId = seedToolDev();
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        expect(signalsFor(gitId, '2026-05').get('personal_insight')!.basis).toBe('git_estimate');
        expect(signalsFor(toolId, '2026-05').get('personal_insight')!.basis).toBe('measured');
    });

    it('writes nothing for a developer with no activity in the period', () => {
        const idle = seedDev('idle-dev');
        seedGitOnlyDev();
        const result = generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        expect(signalsFor(idle, '2026-05').size).toBe(0);
        // Only the active developer was considered.
        expect(result.developers).toBe(1);
    });

    it('is idempotent — re-running replaces the period\'s signals, not appends', () => {
        seedGitOnlyDev();
        const first = generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        const second = generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        expect(second.signalsWritten).toBe(first.signalsWritten);
        const total = (
            db.prepare('SELECT COUNT(*) AS n FROM coaching_signals').get() as {n: number}
        ).n;
        expect(total).toBe(first.signalsWritten);
    });

    it('keeps a historically git-only period git_estimate after tools connect later', () => {
        // A developer who was git-only in May but connects a tool in June must NOT
        // have May relabeled `measured` on the next trailing recompute — the basis
        // describes the period's own data, not today's account state.
        const id = seedGitOnlyDev();
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        const before = signalsFor(id, '2026-05');
        expect(before.get('journey_coaching')!.basis).toBe('git_estimate');
        expect(before.get('personal_insight')!.basis).toBe('git_estimate');

        // June: a high-quality tool connects.
        seedTool({devId: id, date: '2026-06-05', acceptance: 0.7});
        seedTool({devId: id, date: '2026-06-06', acceptance: 0.7});

        // Recompute May (as the scheduler's trailing window does) with a later clock.
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', new Date('2026-06-20T12:00:00.000Z'));
        const after = signalsFor(id, '2026-05');
        expect(after.get('journey_coaching')!.basis).toBe('git_estimate');
        expect(after.get('personal_insight')!.basis).toBe('git_estimate');
    });

    it('retracts a developer\'s signals when their activity leaves the period', () => {
        const id = seedGitOnlyDev();
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        expect(signalsFor(id, '2026-05').size).toBeGreaterThan(0);
        // Remove the May activity, then recompute the period.
        db.prepare("DELETE FROM git_snapshots WHERE developer_id = ? AND date >= '2026-05-01'").run(id);
        generateCoachingSignalsForPeriod(db, 'monthly', '2026-05', NOW);
        expect(signalsFor(id, '2026-05').size).toBe(0);
    });
});
