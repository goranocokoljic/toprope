import {useRef, useState} from 'react';
import {useRelatedPractices, useRecordPracticeView} from '../hooks/useRelatedPractices';
import {formatPercent} from './format';

/**
 * Contextual best-practice affordance (Task 6.2.7 / #162) — the payoff of Epic 6.2.
 *
 * Drop `<RelatedPractices metric="churn" />` next to any metric display and, when
 * there are practices to surface for it (viewer-scoped server-side via 6.2.5/6.2.6),
 * an unobtrusive "related practices" disclosure appears. Design intent:
 *
 *   * UNOBTRUSIVE: when nothing is relevant it renders NOTHING (returns null) — no
 *     empty card, no "0 practices" noise. It only appears when it can help, and starts
 *     collapsed to a single quiet line.
 *   * ENCOURAGING: the expanded heading is the server's reviewed intro copy ("here are
 *     a few practices that may help with …"), never a judgement on the number.
 *   * RECORDS A VIEW: expanding the panel reveals the surfaced practices to the
 *     developer — that IS viewing them — so each surfaced practice's view is recorded
 *     once (feeding the 6.2.4 usage signal). Re-expanding does not double-count.
 *
 * Styling uses the semantic theme tokens (text-muted, text-foreground, border-border,
 * bg-surface-raised, text-accent), so dark mode comes for free via the single class
 * swap on <html> — no raw colors here.
 */
export function RelatedPractices({metric}: {metric: string}): JSX.Element | null {
    const {data} = useRelatedPractices(metric);
    const recordView = useRecordPracticeView();
    const [expanded, setExpanded] = useState(false);
    // Practices whose view we've already recorded this mount — re-expanding the panel
    // must not log a second view for the same surfaced practice.
    const recorded = useRef<Set<string>>(new Set());

    const practices = data?.practices ?? [];
    // Unobtrusive: nothing relevant (or still loading / errored) → render nothing.
    if (practices.length === 0) {
        return null;
    }

    function open(): void {
        setExpanded(true);
        for (const practice of practices) {
            if (!recorded.current.has(practice.id)) {
                recorded.current.add(practice.id);
                // Fire-and-forget: a failed view-log must never break the read surface.
                recordView.mutate({id: practice.id, metric});
            }
        }
    }

    const count = practices.length;
    const noun = count === 1 ? 'practice' : 'practices';

    if (!expanded) {
        return (
            <div className="mt-2">
                <button
                    type="button"
                    onClick={open}
                    aria-label={`Show ${count} related ${noun} that may help`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-accent transition-colors hover:text-accent/80"
                >
                    <span aria-hidden="true">💡</span>
                    {count} related {noun} that may help
                </button>
            </div>
        );
    }

    return (
        <div className="mt-2 rounded-md border border-border bg-surface-raised p-3" data-testid="related-practices">
            <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-muted">{data?.intro}</p>
                <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    aria-label="Hide related practices"
                    className="shrink-0 text-xs text-muted transition-colors hover:text-foreground"
                >
                    Hide
                </button>
            </div>
            <ul className="mt-2 space-y-1.5">
                {practices.map((practice) => (
                    <li key={practice.id} className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                        <span>{practice.title}</span>
                        {practice.pinned ? (
                            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                                Pinned
                            </span>
                        ) : null}
                        {practice.endorsed ? (
                            <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
                                Endorsed
                            </span>
                        ) : null}
                        {practice.helpfulRatio !== null ? (
                            <span className="text-xs text-muted">
                                {formatPercent(practice.helpfulRatio)} found this helpful
                            </span>
                        ) : null}
                    </li>
                ))}
            </ul>
        </div>
    );
}
