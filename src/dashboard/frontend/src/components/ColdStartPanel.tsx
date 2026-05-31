import {StatePanel} from './StatePanel';
import {SIGNIFICANCE_DAYS} from './dataState';

/**
 * Cold-start state: connectors are wired up but not enough data has been
 * collected for the numbers to mean anything yet. This is what a brand-new
 * install (and any customer's first weeks) sees instead of hollow, broken-
 * looking empty charts. It is honest about *why* it's empty — collection is in
 * progress — and shows what's connected, when meaningful data will appear, and
 * what setup is still outstanding. The "Collecting" pulse and accent tone keep
 * it visually distinct from the calm, settled <EmptyState>.
 */

export interface ConnectorStatus {
    name: string;
    connected: boolean;
}

export interface SetupChecklistItem {
    label: string;
    done: boolean;
}

export interface ColdStartPanelProps {
    /** What scope is collecting, e.g. "your team" or "your account". */
    scopeLabel?: string;
    /** Connectors and whether each is wired up. */
    connectors?: ConnectorStatus[];
    /** Setup-completeness checklist. */
    checklist?: SetupChecklistItem[];
    /** Days of real data collected so far; drives the "in about N days" copy. */
    collectedDays?: number;
    /** Days needed before trends are meaningful. Defaults to SIGNIFICANCE_DAYS. */
    significanceDays?: number;
}

/** Honest, specific copy about when the data will be worth reading. */
function timingMessage(collectedDays: number | undefined, significanceDays: number): string {
    if (collectedDays === undefined) {
        return 'Once a connector is syncing, meaningful trends appear after about ' +
            `${significanceDays} days of data.`;
    }
    const collected = Math.max(0, Math.floor(collectedDays));
    const remaining = Math.max(0, significanceDays - collected);
    // This panel is the cold-start treatment, so we never claim the data is
    // "ready" here — once the window is satisfied the scope routes away from
    // cold-start entirely. At/over the window we just say it's still firming up.
    if (remaining === 0) {
        return `${collected} days collected — still building confidence as more data lands.`;
    }
    return (
        `${collected} of ${significanceDays} days collected — ` +
        `meaningful trends appear in about ${remaining} more ${remaining === 1 ? 'day' : 'days'}.`
    );
}

function ConnectorChips({connectors}: {connectors: ConnectorStatus[]}): JSX.Element {
    return (
        <div className="flex flex-wrap gap-2" data-testid="cold-start-connectors">
            {connectors.map((c) => (
                <span
                    key={c.name}
                    className={[
                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                        c.connected ? 'bg-success/10 text-success' : 'bg-surface-raised text-muted',
                    ].join(' ')}
                >
                    <span
                        aria-hidden
                        className={`h-1.5 w-1.5 rounded-full ${c.connected ? 'bg-success' : 'bg-muted'}`}
                    />
                    {c.name}
                    <span className="sr-only">{c.connected ? ' connected' : ' not connected'}</span>
                </span>
            ))}
        </div>
    );
}

function Checklist({items}: {items: SetupChecklistItem[]}): JSX.Element {
    return (
        <ul className="space-y-2" data-testid="cold-start-checklist">
            {items.map((item) => (
                <li key={item.label} className="flex items-center gap-2 text-sm">
                    <span
                        aria-hidden
                        className={[
                            'flex h-4 w-4 items-center justify-center rounded-full border text-[10px]',
                            item.done
                                ? 'border-success bg-success/10 text-success'
                                : 'border-border text-transparent',
                        ].join(' ')}
                    >
                        ✓
                    </span>
                    <span className={item.done ? 'text-muted line-through' : 'text-foreground'}>{item.label}</span>
                    <span className="sr-only">{item.done ? ' done' : ' outstanding'}</span>
                </li>
            ))}
        </ul>
    );
}

export function ColdStartPanel({
    scopeLabel,
    connectors,
    checklist,
    collectedDays,
    significanceDays = SIGNIFICANCE_DAYS,
}: ColdStartPanelProps): JSX.Element {
    // Nothing actually collecting yet → don't claim we're "collecting"; the
    // honest message is "get set up". Collection is underway once a connector is
    // wired or we've already banked some days.
    const collecting = (connectors ?? []).some((c) => c.connected) || (collectedDays ?? 0) > 0;
    const title = collecting
        ? scopeLabel
            ? `Collecting data for ${scopeLabel}`
            : 'Collecting your data'
        : 'Connect a tool to get started';
    return (
        <StatePanel
            tone="accent"
            testId="cold-start"
            icon={
                <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
                </span>
            }
            title={title}
            description={timingMessage(collectedDays, significanceDays)}
        >
            <div className="space-y-5">
                {connectors && connectors.length > 0 ? (
                    <div>
                        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Connectors</p>
                        <ConnectorChips connectors={connectors} />
                    </div>
                ) : null}
                {checklist && checklist.length > 0 ? (
                    <div>
                        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Setup</p>
                        <Checklist items={checklist} />
                    </div>
                ) : null}
            </div>
        </StatePanel>
    );
}
