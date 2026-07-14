import {useEffect, useState} from 'react';
import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
import {useAdminTeams, useCreateAdminTeam, useUpdateAdminTeam} from '../../hooks/useAdmin';
import type {AdminTeam} from '../../api/types';
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

function CreateTeamForm(): JSX.Element {
    const create = useCreateAdminTeam();
    const [name, setName] = useState('');
    const [department, setDepartment] = useState('');
    const [manager, setManager] = useState('');

    function submit(): void {
        create.mutate(
            {name: name.trim(), department: department.trim() || null, manager: manager.trim() || null},
            {
                onSuccess: () => {
                    setName('');
                    setDepartment('');
                    setManager('');
                },
            },
        );
    }

    return (
        <Card title="Create team">
            <div className="flex flex-wrap items-end gap-4">
                <TextField label="Name" value={name} onChange={setName} placeholder="platform" />
                <TextField label="Department" value={department} onChange={setDepartment} placeholder="engineering" />
                <TextField label="Manager" value={manager} onChange={setManager} placeholder="manager@company.com" />
                <PrimaryButton onClick={submit} disabled={create.isPending || !name.trim()}>
                    {create.isPending ? 'Creating…' : 'Create team'}
                </PrimaryButton>
                <ErrorText error={create.isError ? create.error : null} />
            </div>
        </Card>
    );
}

function TeamRow({team}: {team: AdminTeam}): JSX.Element {
    const update = useUpdateAdminTeam();
    const [department, setDepartment] = useState(team.department ?? '');
    const [manager, setManager] = useState(team.manager ?? '');

    // Re-seed local edit state when the server row changes (e.g. after a save
    // refetch) so the inputs track the source of truth.
    useEffect(() => {
        setDepartment(team.department ?? '');
        setManager(team.manager ?? '');
    }, [team.department, team.manager]);

    const dirty = department !== (team.department ?? '') || manager !== (team.manager ?? '');

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
            <Td>
                <input
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="w-36 rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                />
            </Td>
            <Td>
                <input
                    value={manager}
                    onChange={(e) => setManager(e.target.value)}
                    className="w-44 rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                />
            </Td>
            <Td>{team.developer_count}</Td>
            <Td>
                <div className="flex items-center gap-2">
                    <SecondaryButton
                        onClick={() =>
                            update.mutate({
                                name: team.name,
                                patch: {department: department.trim() || null, manager: manager.trim() || null},
                            })
                        }
                        disabled={!dirty || update.isPending}
                    >
                        Save
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
 */
export function AdminTeams(): JSX.Element {
    const teams = useAdminTeams();

    return (
        <div className="space-y-6">
            <PageHeader title="Teams" description="Create, edit, and archive teams." />
            <CreateTeamForm />
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
                        renderRow={(t) => <TeamRow key={t.name} team={t} />}
                    />
                )}
            </Card>
        </div>
    );
}
