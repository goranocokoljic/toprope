import {useState} from 'react';
import {Card} from '../../components/Card';
import {FormModal} from '../../components/FormModal';
import {useModalState} from '../../components/useModalState';
import {
    useAdminDevelopers,
    useAdminSubscriptions,
    useAssignAdminSubscription,
    useEndAdminSubscription,
} from '../../hooks/useAdmin';
import type {AdminSubscription} from '../../api/types';
import {
    optionsGate,
    PageHeader,
    PaginatedTable,
    PrimaryButton,
    SecondaryButton,
    SelectField,
    Td,
    TextField,
    Th,
} from './adminUi';

const TOOLS = ['copilot', 'claude_code', 'windsurf', 'cursor', 'codeium'];

/**
 * The assign/change-subscription form, rendered as the shared create/edit dialog
 * (#236/#240) — opened from the header's "＋ Assign subscription" button, so the
 * subscriptions table is the page's primary content and no form renders unasked.
 * `FormModal` owns Save / Cancel / the write error and the
 * close-guard-while-pending contract; this supplies only the fields.
 *
 * The caller renders this only while its modal is open, so a reopen always
 * remounts clean fields (and a fresh mutation). There is no edit mode: a change
 * IS an assign (the backend revokes the old seat and opens a new one), and the
 * per-row "End" stays inline as a single action rather than a form.
 */
function AssignSubscriptionModal({onDone}: {onDone: () => void}): JSX.Element {
    const developers = useAdminDevelopers();
    const assign = useAssignAdminSubscription();
    const [developerId, setDeveloperId] = useState('');
    const [tool, setTool] = useState('copilot');
    const [plan, setPlan] = useState('');
    const [cost, setCost] = useState('');
    const developerGate = optionsGate(developers, {
        loading: 'Loading developers…',
        failed: 'Couldn’t load developers',
    });

    function submit(): void {
        const monthlyCost = cost.trim() === '' ? null : Number(cost);
        assign.mutate(
            {
                developer_id: developerId,
                tool,
                plan: plan.trim() || null,
                monthly_cost: monthlyCost,
            },
            // Close only on success: a failed write keeps the dialog open with the
            // draft intact, so the error can't hide behind a dismissed modal. The
            // hook invalidates the list, so the table refreshes behind us.
            {onSuccess: onDone},
        );
    }

    const costInvalid = cost.trim() !== '' && (!Number.isFinite(Number(cost)) || Number(cost) < 0);

    return (
        <FormModal
            title="Assign or change subscription"
            onClose={onDone}
            onSubmit={submit}
            submitLabel="Assign"
            pending={assign.isPending}
            submitDisabled={!developerId || costInvalid}
            error={assign.isError ? assign.error : null}
            testId="assign-subscription-modal"
        >
            <p className="mb-4 text-xs text-muted">
                Assigning a tool a developer already has, with a different plan or cost, records a
                lifecycle change (the old seat is revoked and a new one opened) rather than
                overwriting history.
            </p>
            <div className="flex flex-wrap items-end gap-4">
                {/* The developer list now loads when the dialog opens rather than
                    with the page, so on a cold cache the options arrive after the
                    first open. Gate the control until then: an enabled select
                    offering only "Select…" reads as "there are no developers". */}
                <SelectField
                    label="Developer"
                    value={developerId}
                    onChange={setDeveloperId}
                    disabled={developerGate.disabled}
                >
                    <option value="">{developerGate.label ?? 'Select…'}</option>
                    {(developers.data ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                            {d.name}
                        </option>
                    ))}
                </SelectField>
                <SelectField label="Tool" value={tool} onChange={setTool}>
                    {TOOLS.map((t) => (
                        <option key={t} value={t}>
                            {t}
                        </option>
                    ))}
                </SelectField>
                <TextField label="Plan" value={plan} onChange={setPlan} placeholder="business" />
                <TextField label="Monthly cost ($)" value={cost} onChange={setCost} placeholder="19" type="number" />
            </div>
            {costInvalid ? (
                <p className="mt-2 text-sm text-danger">Monthly cost must be a non-negative number.</p>
            ) : null}
        </FormModal>
    );
}

/**
 * Admin → Subscriptions (Task 2.13). Assign or change a developer's tool
 * subscription (lifecycle-aware via the backend), and end an active seat. Ending
 * revokes the seat but keeps the row so cost-over-time history is preserved.
 *
 * The assign form lives in a `FormModal` (#240) opened from the header's
 * "＋ Assign subscription" button — the subscriptions table is the page's primary
 * content. The per-row "End" stays inline: a single action, not a form.
 */
export function AdminSubscriptions(): JSX.Element {
    const subs = useAdminSubscriptions();
    const end = useEndAdminSubscription();
    const assignModal = useModalState<AdminSubscription>();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Subscriptions"
                description="Assign, change, and end AI tool subscriptions per developer."
                actions={
                    <PrimaryButton onClick={assignModal.openCreate} ariaHasPopup="dialog">
                        ＋ Assign subscription
                    </PrimaryButton>
                }
            />
            {/* No form renders until the admin asks for one; closing unmounts it,
                so a reopen always starts empty (#236 criterion 3). */}
            {assignModal.mode !== 'closed' ? <AssignSubscriptionModal onDone={assignModal.close} /> : null}
            <Card title="Active subscriptions">
                {subs.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : subs.isError ? (
                    <p className="text-sm text-danger">Failed to load: {subs.error.message}</p>
                ) : (
                    <PaginatedTable
                        head={
                            <>
                                <Th>Developer</Th>
                                <Th>Tool</Th>
                                <Th>Plan</Th>
                                <Th>Monthly cost</Th>
                                <Th>Actions</Th>
                            </>
                        }
                        rows={subs.data ?? []}
                        ariaLabel="Subscription pages"
                        storageKey="toprope.rowsPerPage.adminSubscriptions"
                        renderRow={(s) => (
                            <tr key={s.id} className="border-b border-border/60">
                                <Td>{s.developer_name}</Td>
                                <Td>{s.tool}</Td>
                                <Td>{s.plan ?? <span className="text-muted">—</span>}</Td>
                                <Td>{s.monthly_cost != null ? `$${s.monthly_cost}` : '—'}</Td>
                                <Td>
                                    <SecondaryButton onClick={() => end.mutate(s.id)} disabled={end.isPending}>
                                        End
                                    </SecondaryButton>
                                </Td>
                            </tr>
                        )}
                    />
                )}
            </Card>
        </div>
    );
}
