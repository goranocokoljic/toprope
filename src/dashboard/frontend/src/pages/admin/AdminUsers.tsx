import {useState} from 'react';
import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
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

function CreateUserForm({onTempPassword}: {onTempPassword: (pw: string) => void}): JSX.Element {
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
                    onTempPassword(user.temp_password);
                    setEmail('');
                    setRole('developer');
                    setDeveloperId('');
                },
            },
        );
    }

    return (
        <Card title="Create user">
            <div className="flex flex-wrap items-end gap-4">
                <TextField label="Email" value={email} onChange={setEmail} placeholder="user@company.com" type="email" />
                <SelectField label="Role" value={role} onChange={setRole}>
                    <option value="developer">Developer</option>
                    <option value="admin">Admin</option>
                </SelectField>
                <SelectField label="Linked developer" value={developerId} onChange={setDeveloperId}>
                    <option value="">— none —</option>
                    {(developers.data ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                            {d.name}
                        </option>
                    ))}
                </SelectField>
                <PrimaryButton onClick={submit} disabled={create.isPending || !email.trim()}>
                    {create.isPending ? 'Creating…' : 'Create user'}
                </PrimaryButton>
                <ErrorText error={create.isError ? create.error : null} />
            </div>
        </Card>
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
 */
export function AdminUsers(): JSX.Element {
    const users = useAdminUsers();
    const [tempPassword, setTempPassword] = useState<string | null>(null);

    return (
        <div className="space-y-6">
            <PageHeader title="Users" description="Manage accounts, roles, and access." />
            {tempPassword ? (
                <TempPasswordBanner password={tempPassword} onDismiss={() => setTempPassword(null)} />
            ) : null}
            <CreateUserForm onTempPassword={setTempPassword} />
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
                        renderRow={(u) => <UserRow key={u.id} user={u} />}
                    />
                )}
            </Card>
        </div>
    );
}
