import type {ReactNode} from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
    tone?: BadgeTone;
    children: ReactNode;
    title?: string;
    className?: string;
}

// Token-driven tone styles: a tinted background + matching text, so badges read
// correctly in both themes (the tokens flip under .dark).
const TONE_CLASSES: Record<BadgeTone, string> = {
    neutral: 'bg-surface-raised text-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
};

/** Small status pill used for tags, tiers, and counts across the dashboard. */
export function Badge({tone = 'neutral', children, title, className}: BadgeProps): JSX.Element {
    return (
        <span
            title={title}
            className={[
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                TONE_CLASSES[tone],
                className ?? '',
            ].join(' ')}
        >
            {children}
        </span>
    );
}
