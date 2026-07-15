import {useState} from 'react';
import {Card} from '../../components/Card';
import {FormModal} from '../../components/FormModal';
import {useModalState} from '../../components/useModalState';
import {
    useAdminDevelopers,
    useAdminTeams,
    useMoveAdminDeveloper,
    useUpdateAdminDeveloperIdentities,
} from '../../hooks/useAdmin';
import type {AdminDeveloper} from '../../api/types';
import {
    ErrorText,
    optionsGate,
    PageHeader,
    PaginatedTable,
    SecondaryButton,
    SelectField,
    Td,
    TextField,
    Th,
} from './adminUi';

interface IdentityDraft {
    github: string;
    copilot: string;
    claude: string;
    windsurf: string;
    cursor: string;
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
        cursor: ext.cursor ?? '',
        bitbucket: ext.bitbucket ?? '',
        gitlab: ext.gitlab ?? '',
        gitEmails: ext.git_emails ?? '',
    };
}

/** How many of a developer's identity fields are actually linked. */
function linkedCount(dev: AdminDeveloper): number {
    return Object.values(draftFor(dev)).filter((v) => v.trim() !== '').length;
}

/**
 * The identity editor, rendered as the shared create/edit dialog (#236/#242).
 * It used to be a card revealed below a "Select a developer" box — always half
 * of the page, empty until something was picked.
 *
 * `dev` is the row snapshot `useModalState` captured when Edit was clicked, so
 * the fields seed once from it; the caller renders this only while its modal is
 * open and keys it on the developer's id, so switching rows remounts clean
 * fields rather than re-seeding through an effect.
 *
 * Both of the card's writes are preserved as distinct actions, because they are
 * distinct requests: `FormModal`'s Save PATCHes the identity map, and the team
 * section's own "Move developer" PATCHes the team. `pending` covers BOTH, so no
 * close affordance works while either is in flight.
 */
function IdentityFormModal({dev, onDone}: {dev: AdminDeveloper; onDone: () => void}): JSX.Element {
    const teams = useAdminTeams();
    const save = useUpdateAdminDeveloperIdentities();
    const move = useMoveAdminDeveloper();
    const [draft, setDraft] = useState<IdentityDraft>(() => draftFor(dev));
    const [team, setTeam] = useState(dev.team);

    function onSave(): void {
        save.mutate(
            {
                id: dev.id,
                identities: {
                    github: draft.github,
                    copilot: draft.copilot,
                    claude: draft.claude,
                    windsurf: draft.windsurf,
                    cursor: draft.cursor,
                    bitbucket: draft.bitbucket,
                    gitlab: draft.gitlab,
                    // Split the comma/whitespace-separated list into individual emails;
                    // the backend dedupes and lowercases. An empty box clears the set.
                    git_emails: draft.gitEmails
                        .split(/[,\s]+/)
                        .map((e) => e.trim())
                        .filter(Boolean),
                },
            },
            // Close only on success: a failed write keeps the dialog open with the
            // draft intact, so the error can't hide behind a dismissed modal.
            {onSuccess: onDone},
        );
    }

    // An archived team is not a move target, but the developer's current team
    // stays listed even if archived — otherwise the select would render their
    // own team as no selection at all.
    const activeTeams = (teams.data ?? []).filter((t) => !t.archived_at || t.name === dev.team);
    const teamGate = optionsGate(teams, {
        loading: 'Loading teams…',
        failed: 'Couldn’t load teams',
    });

    function set<K extends keyof IdentityDraft>(key: K, value: string): void {
        setDraft((d) => ({...d, [key]: value}));
    }

    // Either write closes the dialog on success, so a dismiss mid-flight must be
    // inert for both — not just for Save's.
    const pending = save.isPending || move.isPending;

    return (
        <FormModal
            title={`Identities — ${dev.name}`}
            onClose={onDone}
            onSubmit={onSave}
            submitLabel="Save identities"
            // `pending` is true for EITHER write, but only Save's own write may
            // claim "Saving…" — an in-flight move leaves Save disabled under its
            // normal label rather than lying about what is running.
            pendingLabel={save.isPending ? 'Saving…' : 'Save identities'}
            pending={pending}
            error={save.isError ? save.error : null}
            testId="identity-modal"
        >
            <div className="space-y-5">
                <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        Tool identities
                    </p>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <TextField label="Copilot username" value={draft.copilot} onChange={(v) => set('copilot', v)} />
                        <TextField label="Claude Code email" value={draft.claude} onChange={(v) => set('claude', v)} />
                        <TextField label="Windsurf email" value={draft.windsurf} onChange={(v) => set('windsurf', v)} />
                        <TextField label="Cursor email" value={draft.cursor} onChange={(v) => set('cursor', v)} />
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

                {/* The team move is its own request, not part of the identity
                    PATCH, so it keeps its own control and its own error — exactly
                    as the card had it. */}
                <div className="border-t border-border pt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Team</p>
                    <div className="flex items-end gap-3">
                        <SelectField label="Team" value={team} onChange={setTeam} disabled={teamGate.disabled}>
                            {/* Until the roster resolves, the placeholder carries the
                                developer's CURRENT team as its value: an enabled empty
                                select would read as "this developer has no team", and a
                                blank value would mis-seed the Move below. Only when the
                                list is genuinely empty — a failed REFETCH keeps the
                                cached teams, and the placeholder would then duplicate
                                the real option's value. */}
                            {teamGate.disabled && activeTeams.length === 0 ? (
                                <option value={dev.team}>{teamGate.label}</option>
                            ) : null}
                            {activeTeams.map((t) => (
                                <option key={t.name} value={t.name}>
                                    {t.name}
                                </option>
                            ))}
                        </SelectField>
                        <SecondaryButton
                            onClick={() => move.mutate({id: dev.id, team}, {onSuccess: onDone})}
                            disabled={team === dev.team || pending}
                        >
                            {move.isPending ? 'Moving…' : 'Move developer'}
                        </SecondaryButton>
                        {move.isError ? <ErrorText error={move.error} /> : null}
                    </div>
                </div>
            </div>
        </FormModal>
    );
}

/** One developer row. Editing happens in the row's dialog, never in the table. */
function DeveloperRow({dev, onEdit}: {dev: AdminDeveloper; onEdit: (d: AdminDeveloper) => void}): JSX.Element {
    const linked = linkedCount(dev);
    return (
        <tr className="border-b border-border/60">
            <Td>
                <span className="font-medium">{dev.name}</span>
            </Td>
            <Td>{dev.email ?? <span className="text-muted">—</span>}</Td>
            <Td>{dev.team}</Td>
            <Td>{linked > 0 ? `${linked} linked` : <span className="text-muted">None</span>}</Td>
            <Td>
                <SecondaryButton onClick={() => onEdit(dev)} ariaHasPopup="dialog">
                    Edit
                </SecondaryButton>
            </Td>
        </tr>
    );
}

/**
 * Admin → Identities (Task 2.13). Edit a developer's tool + git identity
 * mapping (external_ids and git-email mapping from Phase 1) and move them
 * between teams. The backend rejects a git-attribution identity already mapped
 * to another developer, so commit attribution stays unambiguous.
 *
 * The editor lives in a `FormModal` opened by a row's "Edit" (#242), so the
 * developers table is the page's primary content — it replaced a "Select a
 * developer" box whose only job was to reveal an editor card below it. There is
 * no "＋ New": developers arrive from discovery/registration, not from here.
 */
export function AdminIdentities(): JSX.Element {
    const developers = useAdminDevelopers();
    const formModal = useModalState<AdminDeveloper>();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Developer identities"
                description="Link tool and git identities, and move developers between teams."
            />
            {/* No editor renders until the admin asks for one. Keyed on the
                developer's id so switching rows always remounts clean fields
                (#236 criterion 3).

                This is the one screen that gates on `editing` rather than
                `mode !== 'closed'` like its five siblings: it is EDIT-ONLY (a
                developer arrives from discovery, never from a "＋ New" button),
                and `editing` is what narrows the non-null `dev` prop below. The
                consequence is deliberate: wiring an `openCreate()` here would
                open nothing. If this screen ever grows a create mode, switch the
                gate to `mode` rather than adding a null-check to the editor. */}
            {formModal.editing ? (
                <IdentityFormModal
                    key={formModal.editing.id}
                    dev={formModal.editing}
                    onDone={formModal.close}
                />
            ) : null}
            <Card title="Developers">
                {developers.isPending ? (
                    <p className="text-sm text-muted">Loading…</p>
                ) : developers.isError ? (
                    <p className="text-sm text-danger">Failed to load: {developers.error.message}</p>
                ) : (
                    <PaginatedTable
                        head={
                            <>
                                <Th>Name</Th>
                                <Th>Email</Th>
                                <Th>Team</Th>
                                <Th>Identities</Th>
                                <Th>Actions</Th>
                            </>
                        }
                        rows={developers.data ?? []}
                        ariaLabel="Developer pages"
                        storageKey="toprope.rowsPerPage.adminIdentities"
                        renderRow={(d) => <DeveloperRow key={d.id} dev={d} onEdit={formModal.openEdit} />}
                    />
                )}
            </Card>
        </div>
    );
}
