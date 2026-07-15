import {useState} from 'react';
import {Card} from '../../components/Card';
import {FormModal} from '../../components/FormModal';
import {useModalState} from '../../components/useModalState';
import {
    useIgnoreReconciliation,
    useReconciliation,
    useResolveReconciliation,
    useRunReconciliation,
} from '../../hooks/useAdmin';
import type {
    ReconciliationResult,
    ReconciliationResultType,
    ReconciliationRunSummary,
    ReconciliationStatus,
} from '../../api/types';
import {
    ErrorText,
    PageHeader,
    PaginatedTable,
    PrimaryButton,
    SecondaryButton,
    Td,
    TextField,
    Th,
} from './adminUi';

const TYPE_LABELS: Record<ReconciliationResultType, string> = {
    expense_no_subscription: 'Expense, no subscription',
    subscription_no_expense: 'Subscription, no expense',
    cost_discrepancy: 'Cost discrepancy',
};

const STATUS_FILTERS: {value: ReconciliationStatus | 'all'; label: string}[] = [
    {value: 'open', label: 'Open'},
    {value: 'resolved', label: 'Resolved'},
    {value: 'ignored', label: 'Ignored'},
    {value: 'all', label: 'All'},
];

function money(value: number | null): string {
    return value != null ? `$${value.toFixed(2)}` : '—';
}

/**
 * The human-readable `message` from the result's details JSON (the most
 * actionable field — why it was flagged), or null when absent/unparseable.
 */
function detailMessage(details: string | null): string | null {
    if (!details) return null;
    try {
        const parsed = JSON.parse(details) as {message?: unknown};
        return typeof parsed.message === 'string' ? parsed.message : null;
    } catch {
        return null;
    }
}

/**
 * The run-parameters form, rendered as the shared dialog (#236/#243) — opened
 * from the header's "Run reconciliation" button, so the results table is the
 * page's primary content and no form renders unasked. `FormModal` owns Run /
 * Cancel / the write error and the close-guard-while-pending contract; this
 * supplies only the fields.
 *
 * `onRan` hands the run summary up to the PAGE before `onDone` closes the
 * dialog: the "Reconciled 2026-06: 1 new…" line is the outcome of the run and
 * has to stay readable next to the rows it produced, so it cannot live in a
 * dismissed dialog.
 *
 * The caller renders this only while its modal is open, so a reopen always
 * remounts clean fields (and a fresh mutation). There is no edit mode — this
 * triggers a job rather than persisting an entity.
 */
function RunReconciliationModal({
    onDone,
    onRan,
}: {
    onDone: () => void;
    onRan: (summary: ReconciliationRunSummary | null) => void;
}): JSX.Element {
    const run = useRunReconciliation();
    const [period, setPeriod] = useState('');
    const [tolerance, setTolerance] = useState('');

    const periodInvalid = period.trim() !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period.trim());
    const tolInvalid =
        tolerance.trim() !== '' && (!Number.isFinite(Number(tolerance)) || Number(tolerance) < 0);

    function submit(): void {
        // Retract the previous run's summary as this one starts: it describes a
        // run that is no longer the latest, and if this attempt fails it would
        // otherwise sit there claiming a success beside the error.
        onRan(null);
        const tol = tolerance.trim() === '' ? undefined : Number(tolerance);
        run.mutate(
            {
                period: period.trim() || undefined,
                tolerance: tol,
            },
            // Close only on success: a failed run keeps the dialog open with the
            // parameters intact, so the error can't hide behind a dismissed
            // modal. Surface the summary on the page FIRST — it must survive this
            // unmount. The hook invalidates the list, so the table refreshes
            // behind us.
            {
                onSuccess: (summary) => {
                    onRan(summary);
                    onDone();
                },
            },
        );
    }

    return (
        <FormModal
            title="Run reconciliation"
            onClose={onDone}
            onSubmit={submit}
            submitLabel="Run"
            pendingLabel="Running…"
            pending={run.isPending}
            submitDisabled={periodInvalid || tolInvalid}
            error={run.isError ? run.error : null}
            testId="run-reconciliation-modal"
        >
            <p className="mb-4 text-xs text-muted">
                Matches imported expenses against the subscription registry for a period and queues
                any mismatches in the results table. Leave the period blank to reconcile the latest
                imported period.
            </p>
            <div className="flex flex-wrap items-end gap-4">
                <TextField label="Period (YYYY-MM)" value={period} onChange={setPeriod} placeholder="2026-06" />
                <TextField
                    label="Tolerance ($)"
                    value={tolerance}
                    onChange={setTolerance}
                    placeholder="1"
                    type="number"
                />
            </div>
            {periodInvalid ? (
                <p className="mt-2 text-sm text-danger">Period must be in YYYY-MM format.</p>
            ) : null}
            {tolInvalid ? (
                <p className="mt-2 text-sm text-danger">Tolerance must be a non-negative number.</p>
            ) : null}
        </FormModal>
    );
}

function ResultActions({result}: {result: ReconciliationResult}): JSX.Element {
    const resolve = useResolveReconciliation();
    const ignore = useIgnoreReconciliation();
    const [note, setNote] = useState('');

    if (result.status !== 'open') {
        return (
            <span className="text-xs text-muted">
                {result.status}
                {result.resolution ? `: ${result.resolution}` : ''}
            </span>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <TextField label="Note" value={note} onChange={setNote} placeholder="reason / action" />
            <div className="flex items-center gap-2">
                <PrimaryButton
                    onClick={() => resolve.mutate({id: result.id, resolution: note})}
                    disabled={resolve.isPending || note.trim() === ''}
                >
                    Resolve
                </PrimaryButton>
                <SecondaryButton
                    onClick={() => ignore.mutate({id: result.id, note: note.trim() || undefined})}
                    disabled={ignore.isPending}
                >
                    Ignore
                </SecondaryButton>
            </div>
            <ErrorText error={resolve.isError ? resolve.error : ignore.isError ? ignore.error : null} />
        </div>
    );
}

/**
 * Admin → Reconciliation (Task 4.4 / #99). Run expense-vs-registry
 * reconciliation, review the resulting mismatches, and resolve (with a note) or
 * ignore each one. Resolving records the note; ignoring suppresses the condition
 * so a later re-run won't re-raise it.
 *
 * The run-parameters form lives in a `FormModal` (#243) opened from the header's
 * "Run reconciliation" button — the results table is the page's primary content.
 * The per-row resolve/ignore stays INLINE: it is a small, contextual action on
 * the row you are already reading, and a dialog per row would hide that context.
 */
export function AdminReconciliation(): JSX.Element {
    const [status, setStatus] = useState<ReconciliationStatus | 'all'>('open');
    const results = useReconciliation(status);
    const runModal = useModalState<never>();
    // Owned by the PAGE, not the modal, so the run's outcome survives the dialog
    // closing on success and stays readable beside the rows it produced.
    const [lastRun, setLastRun] = useState<ReconciliationRunSummary | null>(null);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Reconciliation"
                description="Match imported expenses against the subscription registry and resolve mismatches."
                actions={
                    <PrimaryButton onClick={runModal.openCreate} ariaHasPopup="dialog">
                        Run reconciliation
                    </PrimaryButton>
                }
            />
            {/* No form renders until the admin asks for one; closing unmounts it,
                so a reopen always starts empty (#236 criterion 3). */}
            {runModal.mode !== 'closed' ? (
                <RunReconciliationModal onDone={runModal.close} onRan={setLastRun} />
            ) : null}
            {lastRun ? (
                <p className="text-sm text-muted">
                    Reconciled {lastRun.period}: {lastRun.created} new, {lastRun.skipped} already tracked.
                </p>
            ) : null}
            <Card title="Reconciliation results">
                <div className="mb-4 flex gap-2">
                    {STATUS_FILTERS.map((f) => (
                        <button
                            key={f.value}
                            type="button"
                            onClick={() => setStatus(f.value)}
                            className={[
                                'rounded-md px-3 py-1.5 text-sm font-medium',
                                status === f.value
                                    ? 'bg-accent text-white'
                                    : 'border border-border bg-surface text-foreground',
                            ].join(' ')}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
                {results.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : results.isError ? (
                    <p className="text-sm text-danger">Failed to load: {results.error.message}</p>
                ) : (results.data ?? []).length === 0 ? (
                    <p className="text-sm text-muted">No {status === 'all' ? '' : status} results.</p>
                ) : (
                    <PaginatedTable
                        head={
                            <>
                                <Th>Period</Th>
                                <Th>Type</Th>
                                <Th>Developer</Th>
                                <Th>Tool</Th>
                                <Th>Expense</Th>
                                <Th>Registry</Th>
                                <Th>Action</Th>
                            </>
                        }
                        rows={results.data ?? []}
                        ariaLabel="Reconciliation pages"
                        storageKey="toprope.rowsPerPage.adminReconciliation"
                        renderRow={(r) => (
                            <tr key={r.id} className="border-b border-border/60 align-top">
                                <Td>{r.period}</Td>
                                <Td>
                                    {TYPE_LABELS[r.result_type]}
                                    {detailMessage(r.details) ? (
                                        <span className="mt-0.5 block text-xs text-muted">
                                            {detailMessage(r.details)}
                                        </span>
                                    ) : null}
                                </Td>
                                <Td>{r.developer_name ?? <span className="text-muted">—</span>}</Td>
                                <Td>{r.tool ?? <span className="text-muted">—</span>}</Td>
                                <Td>{money(r.expense_amount)}</Td>
                                <Td>{money(r.registry_amount)}</Td>
                                <Td>
                                    <ResultActions result={r} />
                                </Td>
                            </tr>
                        )}
                    />
                )}
            </Card>
        </div>
    );
}
