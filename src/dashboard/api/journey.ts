import type Database from 'better-sqlite3';
import {rankToTier} from './coverage';
import {getMeJourney, type MeJourney} from './developer-views';

/**
 * Developer adoption-journey assembly (Task 4.11 / #106).
 *
 * Enriches the base journey (per-tool status + lifecycle milestones, built by
 * {@link getMeJourney}) into the full "growth story" the dashboard renders:
 *   - bounds        — first detected AI activity → last activity, the timeline span
 *   - trajectory    — a weekly activity series (active days, interactions, commits,
 *                     and the git AI-signature estimate) from the first active week
 *                     to the present, gaps filled with zeros so the timeline is
 *                     continuous
 *   - annotations   — the key moments on that trajectory (first active week, a
 *                     sustained ramp, a plateau)
 *   - tier          — the developer's data-quality tier, so a git-only journey is
 *                     never silently presented as measured tool usage
 *
 * This SAME payload backs both the developer's own private view (/api/me/journey)
 * and the manager's aggregate developer-detail view (/api/developers/:id/journey).
 * It carries no prompt content and nothing rankable — only the developer's own
 * activity over time — so the two surfaces differ purely in framing, never in what
 * data is exposed (the route layer enforces who may read which id).
 *
 * The pure shaping (weekly bucketing, annotation detection) lives in exported
 * helpers with no DB dependency so they are unit-testable in isolation; the DB
 * functions are thin glue that gather the inputs and call them.
 */

export interface JourneyBounds {
    /** Earliest day with detected AI activity (tool active or a commit) — YYYY-MM-DD, or null. */
    first_activity: string | null;
    /** Latest day with detected AI activity — YYYY-MM-DD, or null. */
    last_activity: string | null;
}

/** One week of the developer's activity trajectory. */
export interface JourneyTrajectoryPoint {
    /** Monday of the week (UTC) — YYYY-MM-DD. */
    week_start: string;
    /** Distinct active days in the week (tool active OR a commit landed), 0–7. */
    active_days: number;
    /** Total tool interactions over the week. */
    interactions: number;
    /** Total git commits over the week. */
    commits: number;
    /**
     * Mean git AI-signature score over the week's days that recorded one, or null.
     * At launch this is the per-developer "estimated AI signature" the journey is
     * built from before tool connectors land — see the tier label.
     */
    ai_signature_score: number | null;
}

export type JourneyAnnotationType = 'first_active_week' | 'sustained_ramp' | 'plateau';

/** A key moment annotated on the trajectory. */
export interface JourneyAnnotation {
    type: JourneyAnnotationType;
    /** Week the moment is anchored to — YYYY-MM-DD (matches a trajectory point). */
    week_start: string;
    /** Human-readable label for the moment. */
    label: string;
}

/**
 * The developer's data-quality tier, mirroring the platform model: high = tool
 * API data, medium = git analysis, low = expense-only, none = no data. A journey
 * built only from git signals reads `medium` and is labelled an estimate.
 */
export type JourneyTier = 'high' | 'medium' | 'low' | 'none';

export interface DeveloperJourney extends MeJourney {
    bounds: JourneyBounds;
    trajectory: JourneyTrajectoryPoint[];
    annotations: JourneyAnnotation[];
    tier: JourneyTier;
}

/** A single day's merged tool+git activity — the input to the weekly trajectory. */
export interface DailyActivity {
    /** YYYY-MM-DD. */
    date: string;
    interactions: number;
    commits: number;
    /** Whether the day counts as active (tool active OR a commit landed). */
    active: boolean;
    ai_signature_score: number | null;
}

const MS_PER_DAY = 86_400_000;

/** The Monday (UTC) of the ISO week containing `date`, as YYYY-MM-DD. */
export function weekStartOf(date: string): string {
    const d = new Date(`${date}T00:00:00.000Z`);
    const dow = d.getUTCDay(); // 0=Sun … 6=Sat
    const sinceMonday = (dow + 6) % 7; // Mon→0, Sun→6
    d.setUTCDate(d.getUTCDate() - sinceMonday);
    return d.toISOString().slice(0, 10);
}

/** Add `weeks` whole weeks to a YYYY-MM-DD week-start, returning YYYY-MM-DD. */
function addWeeks(weekStart: string, weeks: number): string {
    return new Date(Date.parse(`${weekStart}T00:00:00.000Z`) + weeks * 7 * MS_PER_DAY)
        .toISOString()
        .slice(0, 10);
}

/**
 * Fold daily activity into a continuous weekly series spanning [firstWeek,
 * lastWeek] inclusive. Every week in the span appears even with no activity, so
 * the rendered timeline has no gaps and a lull reads as a real dip rather than a
 * missing point. Pure: no DB, no clock — fully unit-testable.
 */
export function buildTrajectory(
    daily: DailyActivity[],
    firstWeek: string,
    lastWeek: string,
): JourneyTrajectoryPoint[] {
    interface Bucket {
        active_days: number;
        interactions: number;
        commits: number;
        ai_sum: number;
        ai_count: number;
    }
    const buckets = new Map<string, Bucket>();
    for (const day of daily) {
        const week = weekStartOf(day.date);
        let b = buckets.get(week);
        if (!b) {
            b = {active_days: 0, interactions: 0, commits: 0, ai_sum: 0, ai_count: 0};
            buckets.set(week, b);
        }
        if (day.active) {
            b.active_days += 1;
        }
        b.interactions += day.interactions;
        b.commits += day.commits;
        if (day.ai_signature_score !== null) {
            b.ai_sum += day.ai_signature_score;
            b.ai_count += 1;
        }
    }

    const points: JourneyTrajectoryPoint[] = [];
    // Walk week by week so missing weeks are emitted as zeros; the loop is bounded
    // by lastWeek and steps a fixed 7 days, so it always terminates.
    for (let week = firstWeek; week <= lastWeek; week = addWeeks(week, 1)) {
        const b = buckets.get(week);
        points.push({
            week_start: week,
            active_days: b?.active_days ?? 0,
            interactions: b?.interactions ?? 0,
            commits: b?.commits ?? 0,
            // Rounded to 4dp so the API returns a clean mean, not float noise.
            ai_signature_score:
                b && b.ai_count > 0 ? Math.round((b.ai_sum / b.ai_count) * 10_000) / 10_000 : null,
        });
    }
    return points;
}

/**
 * Detect the key moments on a weekly trajectory. Each moment is annotated at most
 * once (its first occurrence), matching the "first active week / sustained ramp /
 * plateau" narrative beats. Pure and deterministic so it is unit-testable.
 *
 * Per-week magnitude is `interactions + commits`, the same unit across weeks, so
 * a ramp/plateau is detected whether the developer is on measured tool data or
 * the git-only launch tier (where commits drive it). `active_days` gates whether
 * a week counts as active for the plateau (a flat run of zero weeks is not a
 * plateau, it's a gap).
 */
export function detectAnnotations(trajectory: JourneyTrajectoryPoint[]): JourneyAnnotation[] {
    const annotations: JourneyAnnotation[] = [];
    const magnitude = trajectory.map((p) => p.interactions + p.commits);

    const firstActiveIdx = trajectory.findIndex((p) => p.active_days > 0);
    if (firstActiveIdx < 0) {
        return annotations;
    }
    annotations.push({
        type: 'first_active_week',
        week_start: trajectory[firstActiveIdx].week_start,
        label: 'First active week',
    });

    // Sustained ramp: the first run of three consecutive weeks of strictly rising
    // activity, anchored at the week the ramp begins.
    for (let i = firstActiveIdx; i + 2 < trajectory.length; i++) {
        if (magnitude[i] < magnitude[i + 1] && magnitude[i + 1] < magnitude[i + 2]) {
            annotations.push({
                type: 'sustained_ramp',
                week_start: trajectory[i].week_start,
                label: 'Sustained ramp',
            });
            break;
        }
    }

    // Plateau: the first run of three consecutive active weeks whose activity sits
    // in a flat band (peak-to-trough within 20% of the run's mean).
    for (let i = firstActiveIdx; i + 2 < trajectory.length; i++) {
        const allActive =
            trajectory[i].active_days > 0 &&
            trajectory[i + 1].active_days > 0 &&
            trajectory[i + 2].active_days > 0;
        if (!allActive) {
            continue;
        }
        const window = [magnitude[i], magnitude[i + 1], magnitude[i + 2]];
        const max = Math.max(...window);
        const min = Math.min(...window);
        const mean = (window[0] + window[1] + window[2]) / 3;
        if (mean > 0 && max - min <= 0.2 * mean) {
            annotations.push({
                type: 'plateau',
                week_start: trajectory[i].week_start,
                label: 'Settled into a steady rhythm',
            });
            break;
        }
    }

    return annotations;
}

/**
 * The developer's data-quality tier from their BEST available signal, using the
 * same rank boundaries as the org coverage snapshot ({@link rankToTier}): tool
 * API data → high, git activity → medium, a live expense-only seat → low, nothing
 * → none. This is what labels a launch-era journey an estimate.
 */
export function developerTier(db: Database.Database, developerId: string): JourneyTier {
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

    return rankToTier(Math.max(toolRank, hasGit ? 2 : 0, hasExpense ? 1 : 0));
}

/**
 * Gather the developer's full daily activity history (no recency cutoff — the
 * journey is the whole story), merging tool and git snapshots per day. A day is
 * active if a tool was active or a commit landed, matching the active-days
 * definition used across the developer views.
 */
function getDailyActivity(db: Database.Database, developerId: string): DailyActivity[] {
    const toolRows = db
        .prepare(
            `SELECT date,
                    COALESCE(SUM(interaction_count), 0) AS interactions,
                    MAX(is_active) AS is_active
             FROM tool_snapshots
             WHERE developer_id = ?
             GROUP BY date`,
        )
        .all(developerId) as {date: string; interactions: number; is_active: number}[];

    const gitRows = db
        .prepare(
            `SELECT date, commits, ai_signature_score
             FROM git_snapshots
             WHERE developer_id = ?`,
        )
        .all(developerId) as {date: string; commits: number; ai_signature_score: number | null}[];

    const byDate = new Map<string, DailyActivity>();
    const ensure = (date: string): DailyActivity => {
        let entry = byDate.get(date);
        if (!entry) {
            entry = {date, interactions: 0, commits: 0, active: false, ai_signature_score: null};
            byDate.set(date, entry);
        }
        return entry;
    };

    for (const row of toolRows) {
        const entry = ensure(row.date);
        entry.interactions += row.interactions;
        if (row.is_active === 1) {
            entry.active = true;
        }
    }
    for (const row of gitRows) {
        const entry = ensure(row.date);
        entry.commits += row.commits;
        if (row.commits > 0) {
            entry.active = true;
        }
        // git snapshots are one row per developer per day, so a direct assign is exact.
        entry.ai_signature_score = row.ai_signature_score;
    }

    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** The later of two YYYY-MM-DD dates (lexical = chronological for this format). */
function maxDate(a: string, b: string): string {
    return a >= b ? a : b;
}

/**
 * Assemble the full developer adoption journey. `now` is injectable so the
 * trajectory's "to present" upper bound is deterministic in tests; in production
 * it defaults to the current time.
 *
 * The base tools/events come from {@link getMeJourney} unchanged, so the existing
 * journey contract is preserved; this only adds the bounds, trajectory,
 * annotations, and tier on top.
 */
export function getDeveloperJourney(
    db: Database.Database,
    developerId: string,
    now: Date = new Date(),
): DeveloperJourney {
    const base = getMeJourney(db, developerId);
    const daily = getDailyActivity(db, developerId);
    const tier = developerTier(db, developerId);

    const activeDays = daily.filter((d) => d.active);
    const firstActivity = activeDays.length > 0 ? activeDays[0].date : null;
    const lastActivity = activeDays.length > 0 ? activeDays[activeDays.length - 1].date : null;

    let trajectory: JourneyTrajectoryPoint[] = [];
    if (firstActivity && lastActivity) {
        const nowWeek = weekStartOf(now.toISOString().slice(0, 10));
        // Extend to the present so an inactive tail (a drop-off after the last
        // active day) is visible, never clamped to the last active week.
        const lastWeek = maxDate(weekStartOf(lastActivity), nowWeek);
        trajectory = buildTrajectory(daily, weekStartOf(firstActivity), lastWeek);
    }

    return {
        ...base,
        bounds: {first_activity: firstActivity, last_activity: lastActivity},
        trajectory,
        annotations: detectAnnotations(trajectory),
        tier,
    };
}
