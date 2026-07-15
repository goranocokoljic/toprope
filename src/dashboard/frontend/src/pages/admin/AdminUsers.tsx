import {useState} from 'react';
import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
import {FormModal} from '../../components/FormModal';
import {useModalState} from '../../components/useModalState';
import {
    useAdminDevelopers,
    useAdminUsers,
    useCreateAdminUser,
    useResetAdminUserPassword,
    useUpdateAdminUser,
} from '../../hooks/useAdmin';
import type {AdminUser} from '../../api/types';
import {
    ErrorText,
    PageHeader,
    PaginatedTable,
    PrimaryButton,
    SecondaryButton,
    SelectField,
    Td,
    TempPasswordBanner,
    TextField,
    Th,
} from './adminUi';

/**
 * The create-user form, rendered as the shared create/edit dialog (#236/#239) —
 * opened from the header's "＋ New user" button, so no form renders until the
 * admin asks for one. `FormModal` owns Save / Cancel / the write error and the
 * close-guard-while-pending contract; this supplies only the fields.
 *
 * `onTempPassword` hands the server's one-time password up to the PAGE before
 * `onDone` closes the dialog. The reveal must OUTLIVE this modal: it is shown
 * exactly once and has to stay readable/copyable, so it cannot live in a
 * dismissed dialog. The page owns that state and renders the banner beside the
 * table.
 *
 * The caller renders this only while its modal is open, so a reopen always
 * remounts clean fields (and a fresh mutation) — there is no edit mode here to
 * key against: per-row role / deactivate / reset-password stay inline, being
 * single actions rather than a form.
 */
function CreateUserModal({
    onDone,
    onTempPassword,
}: {
    onDone: () => void;
    onTempPassword: (pw: string) => void;
}): JSX.Element {
    const developers = useAdminDevelopers();
    const create = useCreateAdminUser();
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('developer');
    const [developerId, setDeveloperId] = useState('');

    function submit(): void {
        create.mutate(
            {email: email.trim(), role, developer_id: developerId || null},
            {
                onSuccess: (user) => {
                    // Surface the password on the page FIRST, then close: the
                    // reveal is one-time and must survive this unmount.
                    onTempPassword(user.temp_password);
                    onDone();
                },
            },
        );
    }

    return (
        <FormModal
            title="Create user"
            onClose={onDone}
            onSubmit={submit}
            submitLabel="Create user"
            pendingLabel="Creating…"
            pending={create.isPending}
            submitDisabled={!email.trim()}
            error={create.isError ? create.error : null}
            testId="create-user-modal"
        >
            <div className="flex flex-wrap items-end gap-4">
                <TextField label="Email" value={email} onChange={setEmail} placeholder="user@company.com" type="email" />
                <SelectField label="Role" value={role} onChange={setRole}>
                    <option value="developer">Developer</option>
                    <option value="admin">Admin</option>
                </SelectField>
                {/* The developer list now loads when the dialog opens rather than
                    with the page, so on a cold cache the options arrive after the
                    first open. Gate the control until then: an enabled select
                    offering only "— none —" reads as "there are no developers"
                    and invites an unintended unlinked create. */}
                <SelectField
                    label="Linked developer"
                    value={developerId}
                    onChange={setDeveloperId}
                    disabled={developers.isPending}
                >
                    <option value="">{developers.isPending ? 'Loading developers…' : '— none —'}</option>
                    {(developers.data ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                            {d.name}
                        </option>
                    ))}
                </SelectField>
            </div>
        </FormModal>
    );
}

function UserRow({user}: {user: AdminUser}): JSX.Element {
    const update = useUpdateAdminUser();
    const reset = useResetAdminUserPassword();
    const [resetPassword, setResetPassword] = useState<string | null>(null);

    return (
        <>
            <tr className="border-b border-border/60">
                <Td>{user.email}</Td>
                <Td>
                    <SelectField
                        label=""
                        value={user.role}
                        onChange={(role) => update.mutate({id: user.id, patch: {role}})}
                    >
                        <option value="developer">Developer</option>
                        <option value="admin">Admin</option>
                    </SelectField>
                </Td>
                <Td>{user.developer_name ?? <span className="text-muted">—</span>}</Td>
                <Td>
                    {user.active ? (
                        <Badge tone="success">Active</Badge>
                    ) : (
                        <Badge tone="danger">Deactivated</Badge>
                    )}
                    {user.must_change_password ? (
                        <Badge tone="warning" className="ml-1">
                            Must reset
                        </Badge>
                    ) : null}
                </Td>
                <Td>
                    <div className="flex items-center gap-2">
                        <SecondaryButton
                            onClick={() =>
                                reset.mutate(user.id, {onSuccess: (r) => setResetPassword(r.temp_password)})
                            }
                            disabled={reset.isPending}
                        >
                            Reset password
                        </SecondaryButton>
                        {user.active ? (
                            <SecondaryButton
                                onClick={() => update.mutate({id: user.id, patch: {active: false}})}
                                disabled={update.isPending}
                            >
                                Deactivate
                            </SecondaryButton>
                        ) : (
                            <SecondaryButton
                                onClick={() => update.mutate({id: user.id, patch: {active: true}})}
                                disabled={update.isPending}
                            >
                                Reactivate
                            </SecondaryButton>
                        )}
                    </div>
                    {update.isError ? (
                        <div className="mt-1">
                            <ErrorText error={update.error} />
                        </div>
                    ) : null}
                </Td>
            </tr>
            {resetPassword ? (
                <tr>
                    <td colSpan={5} className="px-3 pb-3">
                        <TempPasswordBanner password={resetPassword} onDismiss={() => setResetPassword(null)} />
                    </td>
                </tr>
            ) : null}
        </>
    );
}

/**
 * Admin → Users (Task 2.13). Create accounts (with a one-time temp password),
 * change role, link to a developer record, reset passwords, and
 * deactivate/reactivate. Reached only by admins (route + API both gate it).
 *
 * The create form lives in a `FormModal` (#239) opened from the header's
 * "＋ New user" button — the users table is the page's primary content, and
 * nothing renders over it unasked. Per-row controls stay inline: they are single
 * actions, not a form.
 */
export function AdminUsers(): JSX.Element {
    const users = useAdminUsers();
    const createModal = useModalState<AdminUser>();
    // The one-time temp password from the last create. Held by the PAGE, not the
    // modal, so the reveal survives the dialog closing on success — it is shown
    // once and must stay copyable.
    const [tempPassword, setTempPassword] = useState<string | null>(null);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Users"
                description="Manage accounts, roles, and access."
                actions={
                    <PrimaryButton onClick={createModal.openCreate} ariaHasPopup="dialog">
                        ＋ New user
                    </PrimaryButton>
                }
            />
            {tempPassword ? (
                <TempPasswordBanner password={tempPassword} onDismiss={() => setTempPassword(null)} />
            ) : null}
            {/* No form renders until the admin asks for one; closing unmounts it,
                so a reopen always starts empty (#236 criterion 3). */}
            {createModal.mode !== 'closed' ? (
                <CreateUserModal onDone={createModal.close} onTempPassword={setTempPassword} />
            ) : null}
            <Card title="All users">
                {users.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : users.isError ? (
                    <p className="text-sm text-danger">Failed to load: {users.error.message}</p>
                ) : (
                    <PaginatedTable
                        head={
                            <>
                                <Th>Email</Th>
                                <Th>Role</Th>
                                <Th>Developer</Th>
                                <Th>Status</Th>
                                <Th>Actions</Th>
                            </>
                        }
                        rows={users.data ?? []}
                        ariaLabel="User pages"
                        storageKey="toprope.rowsPerPage.adminUsers"
                        renderRow={(u) => <UserRow key={u.id} user={u} />}
                    />
                )}
            </Card>
        </div>
    );
}
