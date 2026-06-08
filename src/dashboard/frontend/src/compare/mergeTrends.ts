import type {CompareTeam} from '../api/types';
import type {ChartDatum, ChartSeries} from '../charts/TrendChart';

export interface MergedTrend {
    data: ChartDatum[];
    series: ChartSeries[];
}

/**
 * Series keys are namespaced so a team name can never shadow the x-axis field
 * ('date') or any other reserved datum key — a team literally named "date" would
 * otherwise overwrite the axis value. Team names are free-text, so the prefix is
 * the safe boundary. The legend still shows the bare team name via `label`.
 */
const SERIES_KEY_PREFIX = 'team:';

/**
 * Merge each compared team's active-developer trend into one overlaid dataset:
 * a row per calendar date in the union of all teams' dates, with one keyed
 * series per team. A date a team has no snapshot for fills 0 — under the daily-
 * snapshot model an absent date means no active developers that day, so 0 is the
 * honest value and keeps the overlaid lines continuous and comparable.
 *
 * Series carry no explicit color, so <TrendChart> assigns each its themed
 * categorical color by index (consistent light/dark). `xKey` is always 'date'.
 */
export function mergeCompareTrends(teams: CompareTeam[]): MergedTrend {
    const dates = new Set<string>();
    for (const team of teams) {
        for (const point of team.trend) {
            dates.add(point.date);
        }
    }
    const sortedDates = [...dates].sort();

    const byTeam = teams.map((team) => new Map(team.trend.map((p) => [p.date, p.active_developers])));

    const data: ChartDatum[] = sortedDates.map((date) => {
        const row: ChartDatum = {date};
        teams.forEach((team, i) => {
            row[`${SERIES_KEY_PREFIX}${team.name}`] = byTeam[i].get(date) ?? 0;
        });
        return row;
    });

    const series: ChartSeries[] = teams.map((team) => ({
        key: `${SERIES_KEY_PREFIX}${team.name}`,
        label: team.name,
    }));

    return {data, series};
}
