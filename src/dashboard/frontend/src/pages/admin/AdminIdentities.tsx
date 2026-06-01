import {useEffect, useMemo, useState} from 'react';
import {Card} from '../../components/Card';
import {
    useAdminDevelopers,
    useAdminTeams,
    useMoveAdminDeveloper,
    useUpdateAdminDeveloperIdentities,
} from '../../hooks/useAdmin';
import type {AdminDeveloper} from '../../api/types';
import {
    ErrorText,
    PageHeader,
    PrimaryButton,
    SecondaryButton,
    SelectField,
    TextField,
} from './adminUi';

interface IdentityDraft {
    github: string;
    copilot: string;
    claude: string;
    windsurf: string;
    bitbucket: string;
    gitlab: string;
    gitEmails: string;
}

function draftFor(dev: AdminDeveloper): IdentityDraft {
    const ext = dev.external_ids;
    return {
        github: ext.github ?? '',
        copilot: ext.copilot ?? '',
        claude: ext.claude ?? '',
        windsurf: ext.windsurf ?? '',
        bitbucket: ext.bitbucket ?? '',
        gitlab: ext.gitlab ?? '',
        gitEmails: ext.git_emails ?? '',
    };
}

function IdentityEditor({dev}: {dev: AdminDeveloper}): JSX.Element {
    const teams = useAdminTeams();
    const save = useUpdateAdminDeveloperIdentities();
    const move = useMoveAdminDeveloper();
    const [draft, setDraft] = useState<IdentityDraft>(() => draftFor(dev));
    const [team, setTeam] = useState(dev.team);

    // Re-seed when the selected developer (or its server data) changes.
    useEffect(() => {
        setDraft(draftFor(dev));
        setTeam(dev.team);
    }, [dev]);

    function onSave(): void {
        save.mutate({
            id: dev.id,
            identities: {
                github: draft.github,
                copilot: draft.copilot,
                claude: draft.claude,
                windsurf: draft.windsurf,
                bitbucket: draft.bitbucket,
                gitlab: draft.gitlab,
                // Split the comma/whitespace-separated list into individual emails;
                // the backend dedupes and lowercases. An empty box clears the set.
                git_emails: draft.gitEmails
                    .split(/[,\s]+/)
                    .map((e) => e.trim())
                    .filter(Boolean),
            },
        });
    }

    const activeTeams = (teams.data ?? []).filter((t) => !t.archived_at || t.name === dev.team);

    function set<K extends keyof IdentityDraft>(key: K, value: string): void {
        setDraft((d) => ({...d, [key]: value}));
    }

    return (
        <Card title={`Identities — ${dev.name}`}>
            <div className="space-y-5">
                <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        Tool identities
                    </p>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <TextField label="Copilot username" value={draft.copilot} onChange={(v) => set('copilot', v)} />
                        <TextField label="Claude Code email" value={draft.claude} onChange={(v) => set('claude', v)} />
                        <TextField label="Windsurf email" value={draft.windsurf} onChange={(v) => set('windsurf', v)} />
                    </div>
                </div>
                <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        Git identities
                    </p>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <TextField label="GitHub username" value={draft.github} onChange={(v) => set('github', v)} />
                        <TextField label="Bitbucket username" value={draft.bitbucket} onChange={(v) => set('bitbucket', v)} />
                        <TextField label="GitLab username" value={draft.gitlab} onChange={(v) => set('gitlab', v)} />
                    </div>
                    <div className="mt-4">
                        <TextField
                            label="Git commit emails (comma-separated)"
                            value={draft.gitEmails}
                            onChange={(v) => set('gitEmails', v)}
                            placeholder="jane@work.com, jane@personal.com"
                        />
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <PrimaryButton onClick={onSave} disabled={save.isPending}>
                        {save.isPending ? 'Saving…' : 'Save identities'}
                    </PrimaryButton>
                    {save.isError ? <ErrorText error={save.error} /> : null}
                    {save.isSuccess ? <span className="text-sm text-muted">Saved.</span> : null}
                </div>

                <div className="border-t border-border pt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Team</p>
                    <div className="flex items-end gap-3">
                        <SelectField label="Team" value={team} onChange={setTeam}>
                            {activeTeams.map((t) => (
                                <option key={t.name} value={t.name}>
                                    {t.name}
                                </option>
                            ))}
                        </SelectField>
                        <SecondaryButton
                            onClick={() => move.mutate({id: dev.id, team})}
                            disabled={team === dev.team || move.isPending}
                        >
                            Move developer
                        </SecondaryButton>
                        {move.isError ? <ErrorText error={move.error} /> : null}
                    </div>
                </div>
            </div>
        </Card>
    );
}

/**
 * Admin → Identities (Task 2.13). Edit a developer's tool + git identity
 * mapping (external_ids and git-email mapping from Phase 1) and move them
 * between teams. The backend rejects a git-attribution identity already mapped
 * to another developer, so commit attribution stays unambiguous.
 */
export function AdminIdentities(): JSX.Element {
    const developers = useAdminDevelopers();
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const selected = useMemo(
        () => (developers.data ?? []).find((d) => d.id === selectedId) ?? null,
        [developers.data, selectedId],
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title="Developer identities"
                description="Link tool and git identities, and move developers between teams."
            />
            <Card title="Select a developer">
                {developers.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : developers.isError ? (
                    <p className="text-sm text-danger">Failed to load: {developers.error.message}</p>
                ) : (
                    <SelectField
                        label="Developer"
                        value={selectedId ?? ''}
                        onChange={(v) => setSelectedId(v || null)}
                    >
                        <option value="">Select a developer…</option>
                        {(developers.data ?? []).map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.name} · {d.team}
                            </option>
                        ))}
                    </SelectField>
                )}
            </Card>
            {selected ? <IdentityEditor key={selected.id} dev={selected} /> : null}
        </div>
    );
}
