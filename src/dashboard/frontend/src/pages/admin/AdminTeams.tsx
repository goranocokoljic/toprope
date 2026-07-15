import {useState} from 'react';
import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
import {FormModal} from '../../components/FormModal';
import {useModalState} from '../../components/useModalState';
import {useAdminTeams, useCreateAdminTeam, useUpdateAdminTeam} from '../../hooks/useAdmin';
import type {AdminTeam} from '../../api/types';
import {PageHeader, PaginatedTable, PrimaryButton, SecondaryButton, Td, TextField, Th} from './adminUi';

/**
 * The create/edit team form, rendered as the shared create/edit dialog
 * (#236/#241). This is the one screen in the epic that migrated BOTH forms: the
 * "Create team" card that used to sit above the table, and the editable
 * department / manager inputs that used to live inside every row.
 *
 * `editing` pre-fills the fields from a row; `null` is the create form. The
 * caller renders this only while its modal is open and keys it on
 * `editing?.name ?? 'new'`, so create ⇄ edit ⇄ another row remounts clean fields.
 *
 * `name` is the team's identifier (the PATCH addresses the team by it), so it is
 * a create-only field — editing a team changes department / manager, exactly the
 * patch the inline row inputs sent. `FormModal` owns Save / Cancel / the write
 * error and the close-guard-while-pending contract.
 */
function TeamFormModal({editing, onDone}: {editing: AdminTeam | null; onDone: () => void}): JSX.Element {
    const create = useCreateAdminTeam();
    const update = useUpdateAdminTeam();
    const [name, setName] = useState('');
    const [department, setDepartment] = useState(editing?.department ?? '');
    const [manager, setManager] = useState(editing?.manager ?? '');

    const isEdit = editing !== null;
    // `isEdit` picks the path, so exactly one of the two mutations is ever in
    // play — select it once rather than testing both at each use.
    const write = isEdit ? update : create;

    // Preserved from the inline row form: Save stays inert until something
    // actually changed, so a no-op PATCH is never sent.
    const dirty =
        isEdit &&
        (department !== (editing.department ?? '') || manager !== (editing.manager ?? ''));

    function submit(): void {
        const patch = {
            department: department.trim() || null,
            manager: manager.trim() || null,
        };
        // Close only on success: a failed write keeps the dialog open with the
        // draft intact, so the error can't hide behind a dismissed modal. Both
        // hooks invalidate the list, so the table refreshes behind us.
        if (editing) {
            update.mutate({name: editing.name, patch}, {onSuccess: onDone});
        } else {
            create.mutate({name: name.trim(), ...patch}, {onSuccess: onDone});
        }
    }

    return (
        <FormModal
            title={isEdit ? `Edit team — ${editing.name}` : 'Create team'}
            onClose={onDone}
            onSubmit={submit}
            submitLabel={isEdit ? 'Save changes' : 'Create team'}
            pendingLabel={isEdit ? 'Saving…' : 'Creating…'}
            pending={write.isPending}
            submitDisabled={isEdit ? !dirty : !name.trim()}
            error={write.isError ? write.error : null}
            testId="team-modal"
        >
            <div className="flex flex-wrap items-end gap-4">
                {/* The name IS the team's key — it addresses the PATCH, so it is
                    set once at create and not editable after. */}
                {isEdit ? null : (
                    <TextField label="Name" value={name} onChange={setName} placeholder="platform" />
                )}
                <TextField
                    label="Department"
                    value={department}
                    onChange={setDepartment}
                    placeholder="engineering"
                />
                <TextField
                    label="Manager"
                    value={manager}
                    onChange={setManager}
                    placeholder="manager@company.com"
                />
            </div>
        </FormModal>
    );
}

/**
 * One team row. Department and manager are plain text since #241 — editing them
 * happens in the row's "Edit" dialog, not in inputs embedded in the table.
 * Archive / restore stay inline: each is a single action, not a form.
 */
function TeamRow({team, onEdit}: {team: AdminTeam; onEdit: (t: AdminTeam) => void}): JSX.Element {
    const update = useUpdateAdminTeam();

    return (
        <tr className="border-b border-border/60">
            <Td>
                <span className="font-medium">{team.name}</span>
                {team.archived_at ? (
                    <Badge tone="neutral" className="ml-2">
                        Archived
                    </Badge>
                ) : null}
            </Td>
            <Td>{team.department ?? <span className="text-muted">—</span>}</Td>
            <Td>{team.manager ?? <span className="text-muted">—</span>}</Td>
            <Td>{team.developer_count}</Td>
            <Td>
                <div className="flex items-center gap-2">
                    <SecondaryButton onClick={() => onEdit(team)} ariaHasPopup="dialog">
                        Edit
                    </SecondaryButton>
                    {team.archived_at ? (
                        <SecondaryButton
                            onClick={() => update.mutate({name: team.name, patch: {archived: false}})}
                            disabled={update.isPending}
                        >
                            Restore
                        </SecondaryButton>
                    ) : (
                        <SecondaryButton
                            onClick={() => update.mutate({name: team.name, patch: {archived: true}})}
                            disabled={update.isPending}
                        >
                            Archive
                        </SecondaryButton>
                    )}
                </div>
            </Td>
        </tr>
    );
}

/**
 * Admin → Teams (Task 2.13). Create teams, edit department/manager, and
 * archive/restore. Archived teams are retained (never deleted) so historical
 * data that references them by name stays intact. Moving developers between
 * teams lives on the Identities screen.
 *
 * Both forms live in a `FormModal` (#241) — create opens from the header's
 * "＋ New team" button, edit from a row's "Edit" — so the teams table is the
 * page's primary content and no form renders unasked.
 */
export function AdminTeams(): JSX.Element {
    const teams = useAdminTeams();
    const formModal = useModalState<AdminTeam>();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Teams"
                description="Create, edit, and archive teams."
                actions={
                    <PrimaryButton onClick={formModal.openCreate} ariaHasPopup="dialog">
                        ＋ New team
                    </PrimaryButton>
                }
            />
            {/* No form renders until the admin asks for one. Keyed on the team's
                name (its identifier — teams have no id) so create ⇄ edit ⇄
                another row always remounts clean fields (#236 criterion 3). */}
            {formModal.mode !== 'closed' ? (
                <TeamFormModal
                    key={formModal.editing?.name ?? 'new'}
                    editing={formModal.editing}
                    onDone={formModal.close}
                />
            ) : null}
            <Card title="All teams">
                {teams.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : teams.isError ? (
                    <p className="text-sm text-danger">Failed to load: {teams.error.message}</p>
                ) : (
                    <PaginatedTable
                        head={
                            <>
                                <Th>Name</Th>
                                <Th>Department</Th>
                                <Th>Manager</Th>
                                <Th>Developers</Th>
                                <Th>Actions</Th>
                            </>
                        }
                        rows={teams.data ?? []}
                        ariaLabel="Team pages"
                        storageKey="toprope.rowsPerPage.adminTeams"
                        renderRow={(t) => <TeamRow key={t.name} team={t} onEdit={formModal.openEdit} />}
                    />
                )}
            </Card>
        </div>
    );
}
