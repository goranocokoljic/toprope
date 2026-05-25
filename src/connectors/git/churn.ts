import type {GitCommit} from './client';

export interface ChurnResult {
    churn_rate: number;
    total_lines_changed: number;
    lines_rechurned: number;
}

export function calculateChurnRate(
    commits: GitCommit[],
    windowHours = 48,
): ChurnResult {
    const windowMs = windowHours * 60 * 60 * 1_000;

    // Sort commits by date ascending
    const sorted = [...commits].sort(
        (a, b) => new Date(a.author_date).getTime() - new Date(b.author_date).getTime(),
    );

    let totalLinesChanged = 0;
    let linesRechurned = 0;

    // Track last-touched timestamp per file
    const fileLastTouched = new Map<string, number>();

    for (const commit of sorted) {
        const commitTime = new Date(commit.author_date).getTime();

        for (const file of commit.files) {
            const linesChanged = file.additions + file.deletions;
            totalLinesChanged += linesChanged;

            const lastTouched = fileLastTouched.get(file.filename);
            if (lastTouched !== undefined && commitTime - lastTouched <= windowMs) {
                linesRechurned += linesChanged;
            }

            fileLastTouched.set(file.filename, commitTime);
        }
    }

    const churnRate = totalLinesChanged > 0 ? linesRechurned / totalLinesChanged : 0;

    return {
        churn_rate: churnRate,
        total_lines_changed: totalLinesChanged,
        lines_rechurned: linesRechurned,
    };
}
