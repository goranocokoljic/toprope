import type {PRReviewPeriodUnit} from '../api/types';

/**
 * Weekly/monthly segmented toggle for the coaching surfaces (Task 5.3). Token-
 * driven so it flips correctly in dark mode; the active option carries the
 * accent fill.
 */
export function PeriodUnitToggle({
    value,
    onChange,
}: {
    value: PRReviewPeriodUnit;
    onChange: (unit: PRReviewPeriodUnit) => void;
}): JSX.Element {
    const options: Array<{key: PRReviewPeriodUnit; label: string}> = [
        {key: 'monthly', label: 'Monthly'},
        {key: 'weekly', label: 'Weekly'},
    ];
    return (
        <div
            role="group"
            aria-label="Period unit"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface p-0.5"
        >
            {options.map((opt) => {
                const active = opt.key === value;
                return (
                    <button
                        key={opt.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(opt.key)}
                        className={[
                            'rounded px-3 py-1 text-sm font-medium transition-colors',
                            active
                                ? 'bg-accent-soft text-accent'
                                : 'text-muted hover:text-foreground',
                        ].join(' ')}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}
