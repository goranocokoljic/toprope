import {CoverageBadge} from './CoverageBadge';
import {confidenceTier} from './coverage';

/**
 * Partial-coverage state: a scope where some members have a full data history
 * and others are thin or absent. Showing only an aggregate here would launder
 * thin data into a confident-looking average; instead we display per-member
 * confidence honestly and lead with the caveat ("4 of 12 still thin") so the
 * gap is impossible to miss. Thin members are listed first for the same reason.
 *
 * Privacy: this lists named scopes. Per the platform's privacy model (managers
 * see team aggregates, not individuals), callers must only pass non-PII labels
 * (teams) in a manager context; per-developer names belong to a developer's own
 * self-view, never a manager-facing screen.
 *
 * Part of the shared data-state library. Its first consumer is the Team Detail
 * screen (task 2.6), which has the per-scope day-counts this needs; it ships
 * here with the rest of the family so that screen reuses it.
 */

export interface CoverageScope {
    /** Display name (developer, team, …). */
    name: string;
    /** Real days of data collected for this scope. */
    dataDays: number;
    /** Window span, for the "N of M days" framing on each row. */
    spanDays?: number;
}

export interface PartialCoverageProps {
    scopes: CoverageScope[];
    /** Plural noun for the rows; defaults to 'developers'. */
    unit?: string;
    className?: string;
}

export function PartialCoverage({scopes, unit = 'developers', className}: PartialCoverageProps): JSX.Element {
    const full = scopes.filter((s) => confidenceTier(s.dataDays).level === 'high').length;
    const thin = scopes.length - full;

    // Thin first: the honest caveat should be the first thing read, not buried
    // under the rows that already look healthy.
    const ordered = [...scopes].sort((a, b) => a.dataDays - b.dataDays);

    return (
        <div className={className} data-testid="partial-coverage">
            <p className="text-sm text-muted">
                <span className="font-medium text-foreground">
                    {full} of {scopes.length}
                </span>{' '}
                {unit} have a full-confidence history
                {thin > 0 ? (
                    <>
                        {' '}
                        — <span className="font-medium text-foreground">{thin}</span> still building
                    </>
                ) : null}
                .
            </p>
            <ul className="mt-3 divide-y divide-border rounded-card border border-border">
                {ordered.map((s) => (
                    <li key={s.name} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="truncate text-sm text-foreground">{s.name}</span>
                        <CoverageBadge dataDays={s.dataDays} spanDays={s.spanDays} />
                    </li>
                ))}
            </ul>
        </div>
    );
}
