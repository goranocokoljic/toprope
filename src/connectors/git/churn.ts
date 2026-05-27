import type {AnalysisCommit} from './analysis-types.js';

export interface ChurnResult {
    churn_rate: number;
    total_lines_changed: number;
    lines_rechurned: number;
}

export function calculateChurnRate(
    commits: AnalysisCommit[],
    windowHours = 48,
): ChurnResult {
    const windowMs = windowHours * 60 * 60 * 1_000;

    const sorted = [...commits].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    let totalLinesChanged = 0;
    let linesRechurned = 0;

    const fileLastTouched = new Map<string, number>();

    for (const commit of sorted) {
        const commitTime = new Date(commit.date).getTime();

        for (const file of commit.fileDiffs) {
            const linesChanged = file.additions + file.deletions;
            totalLinesChanged += linesChanged;

            const lastTouched = fileLastTouched.get(file.path);
            if (lastTouched !== undefined && commitTime - lastTouched <= windowMs) {
                linesRechurned += linesChanged;
            }

            fileLastTouched.set(file.path, commitTime);
        }
    }

    const churnRate = totalLinesChanged > 0 ? linesRechurned / totalLinesChanged : 0;

    return {
        churn_rate: churnRate,
        total_lines_changed: totalLinesChanged,
        lines_rechurned: linesRechurned,
    };
}

// Per-day churn rate that honors a window spanning multiple days. Files touched
// on an earlier day still count as re-churned when a later commit lands within
// the window, with the re-churn attributed to the day of the later commit.
export function calculateDailyChurnRates(
    commits: AnalysisCommit[],
    windowHours = 48,
): Map<string, number> {
    const windowMs = windowHours * 60 * 60 * 1_000;

    const sorted = [...commits].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const fileLastTouched = new Map<string, number>();
    const totalByDate = new Map<string, number>();
    const rechurnedByDate = new Map<string, number>();

    for (const commit of sorted) {
        const commitTime = new Date(commit.date).getTime();
        const date = commit.date.slice(0, 10);

        for (const file of commit.fileDiffs) {
            const linesChanged = file.additions + file.deletions;
            totalByDate.set(date, (totalByDate.get(date) ?? 0) + linesChanged);

            const lastTouched = fileLastTouched.get(file.path);
            if (lastTouched !== undefined && commitTime - lastTouched <= windowMs) {
                rechurnedByDate.set(date, (rechurnedByDate.get(date) ?? 0) + linesChanged);
            }

            fileLastTouched.set(file.path, commitTime);
        }
    }

    const rates = new Map<string, number>();
    for (const [date, total] of totalByDate) {
        const rechurned = rechurnedByDate.get(date) ?? 0;
        rates.set(date, total > 0 ? rechurned / total : 0);
    }
    return rates;
}
