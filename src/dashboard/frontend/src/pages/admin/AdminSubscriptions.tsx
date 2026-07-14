import {useState} from 'react';
import {Card} from '../../components/Card';
import {
    useAdminDevelopers,
    useAdminSubscriptions,
    useAssignAdminSubscription,
    useEndAdminSubscription,
} from '../../hooks/useAdmin';
import {
    ErrorText,
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

function AssignForm(): JSX.Element {
    const developers = useAdminDevelopers();
    const assign = useAssignAdminSubscription();
    const [developerId, setDeveloperId] = useState('');
    const [tool, setTool] = useState('copilot');
    const [plan, setPlan] = useState('');
    const [cost, setCost] = useState('');

    function submit(): void {
        const monthlyCost = cost.trim() === '' ? null : Number(cost);
        assign.mutate(
            {
                developer_id: developerId,
                tool,
                plan: plan.trim() || null,
                monthly_cost: monthlyCost,
            },
            {
                onSuccess: () => {
                    setPlan('');
                    setCost('');
                },
            },
        );
    }

    const costInvalid = cost.trim() !== '' && (!Number.isFinite(Number(cost)) || Number(cost) < 0);

    return (
        <Card title="Assign or change subscription">
            <p className="mb-4 text-xs text-muted">
                Assigning a tool a developer already has, with a different plan or cost, records a
                lifecycle change (the old seat is revoked and a new one opened) rather than
                overwriting history.
            </p>
            <div className="flex flex-wrap items-end gap-4">
                <SelectField label="Developer" value={developerId} onChange={setDeveloperId}>
                    <option value="">Select…</option>
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
                <PrimaryButton onClick={submit} disabled={assign.isPending || !developerId || costInvalid}>
                    {assign.isPending ? 'Saving…' : 'Assign'}
                </PrimaryButton>
                <ErrorText error={assign.isError ? assign.error : null} />
            </div>
            {costInvalid ? (
                <p className="mt-2 text-sm text-danger">Monthly cost must be a non-negative number.</p>
            ) : null}
        </Card>
    );
}

/**
 * Admin → Subscriptions (Task 2.13). Assign or change a developer's tool
 * subscription (lifecycle-aware via the backend), and end an active seat. Ending
 * revokes the seat but keeps the row so cost-over-time history is preserved.
 */
export function AdminSubscriptions(): JSX.Element {
    const subs = useAdminSubscriptions();
    const end = useEndAdminSubscription();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Subscriptions"
                description="Assign, change, and end AI tool subscriptions per developer."
            />
            <AssignForm />
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
