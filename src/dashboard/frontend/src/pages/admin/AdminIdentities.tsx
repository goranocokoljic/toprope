import {useState} from 'react';
import {Badge} from '../../components/Badge';
import {Card} from '../../components/Card';
import {EmptyState} from '../../components/EmptyState';
import {FormModal} from '../../components/FormModal';
import {useModalState} from '../../components/useModalState';
import {
    useAdminDeveloperCandidates,
    useAdminDevelopers,
    useAdminTeams,
    useCreateAdminDeveloper,
    useMoveAdminDeveloper,
    useUpdateAdminDeveloperIdentities,
} from '../../hooks/useAdmin';
import type {AdminDeveloper, AuthorCandidate} from '../../api/types';
import {
    ErrorText,
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

/**
 * Split the comma/whitespace-separated git-emails box into individual emails.
 * The backend dedupes and lowercases; an empty box yields an empty list, which
 * on the identities PATCH clears the stored set.
 */
function parseGitEmails(raw: string): string[] {
    return raw
        .split(/[,\s]+/)
        .map((e) => e.trim())
        .filter(Boolean);
}

/** The git-attribution providers a candidate's login can be written to. */
const ATTRIBUTION_PROVIDERS = ['github', 'bitbucket', 'gitlab'] as const;
type AttributionProvider = (typeof ATTRIBUTION_PROVIDERS)[number];

/**
 * Narrow the candidate's `provider` at runtime. It arrives as the open string the
 * wire carries (`raw_author_daily.provider` is unconstrained TEXT), so an unknown
 * provider must fall through to "no login field to prefill" rather than being
 * asserted into a union and writing a login onto the wrong identity — which would
 * make the promotion attribute nothing at all.
 */
function attributionProvider(provider: string): AttributionProvider | null {
    return (ATTRIBUTION_PROVIDERS as readonly string[]).includes(provider)
        ? (provider as AttributionProvider)
        : null;
}

/** The identity a reader recognises a candidate by: login when there is one, else email. */
function candidateLabel(candidate: AuthorCandidate): string {
    return candidate.login ?? candidate.email ?? candidate.raw_author_key;
}

/**
 * Seed the create form from a candidate. The login goes on that candidate's OWN
 * provider field — writing a Bitbucket login into `github` would pass validation
 * and then resolve nothing, so the developer would be created with no history
 * attributed and no error to explain it.
 */
function prefillFromCandidate(candidate: AuthorCandidate): {
    name: string;
    email: string;
    gitEmails: string;
    github: string;
    bitbucket: string;
    gitlab: string;
} {
    const provider = attributionProvider(candidate.provider);
    const login = candidate.login ?? '';
    return {
        name: candidate.display_name ?? candidate.login ?? candidate.email ?? '',
        email: candidate.email ?? '',
        // Seed the candidate's OWN commit address into git_emails as well, mirroring the
        // server-side `candidateCreateInput`. The Email field is pre-filled with it and is
        // the field an admin naturally corrects — a noreply address looks like junk next to
        // a placeholder reading `jane@company.com`. If it only lived there, replacing it
        // would drop the one address the retained rows actually carry, and the promotion
        // would "succeed" while attributing nothing (the confirmation banner would say "no
        // retained history matched"). Duplicating it here is harmless: the write boundary
        // skips a git_email equal to the primary email.
        gitEmails: candidate.email ?? '',
        github: provider === 'github' ? login : '',
        bitbucket: provider === 'bitbucket' ? login : '',
        gitlab: provider === 'gitlab' ? login : '',
    };
}

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
                    git_emails: parseGitEmails(draft.gitEmails),
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

/**
 * The "Add developer" dialog (DO1.1 / #251) — the first UI path for getting a
 * developer into the system. Before it, a fresh install that connected a git
 * provider had none, and sync attributes commits only to developers that already
 * exist, so every author was silently dropped.
 *
 * Git identities are on the form (not just name/team) because they are what make
 * the new developer resolvable by sync at all. The server rejects any id or email
 * already owned by someone else with a 409, which `FormModal` renders inline via
 * `ErrorText` — the dialog stays open with the draft intact so the admin can
 * correct the duplicate rather than lose what they typed.
 */
function CreateDeveloperFormModal({
    candidate,
    onClose,
    onCreated,
}: {
    /**
     * When opened from the review queue (DO1.5 / #255), the unmatched author this
     * dialog is promoting — every field seeds from it. Absent for the plain
     * "＋ Add developer" action, which keeps the original blank form.
     */
    candidate?: AuthorCandidate;
    /** Dismissed without creating anything. */
    onClose: () => void;
    /** Created — carries what the page confirms. Distinct from `onClose` so a
     *  dismiss can never be mistaken for a successful create. */
    onCreated: (result: {name: string; datesAttributed: number}) => void;
}): JSX.Element {
    const teams = useAdminTeams();
    const create = useCreateAdminDeveloper();
    const seed = candidate ? prefillFromCandidate(candidate) : null;
    const [name, setName] = useState(seed?.name ?? '');
    const [email, setEmail] = useState(seed?.email ?? '');
    // Team starts unselected rather than defaulting to the first row: which team
    // a developer lands on drives every aggregate they appear in, so it is a
    // deliberate choice, not something the form makes for the admin. That holds
    // for a promoted candidate too — the repo cannot tell us their team.
    const [team, setTeam] = useState('');
    const [draft, setDraft] = useState({
        github: seed?.github ?? '',
        bitbucket: seed?.bitbucket ?? '',
        gitlab: seed?.gitlab ?? '',
        gitEmails: seed?.gitEmails ?? '',
    });

    // Archived teams are not create targets (the server rejects them too).
    const activeTeams = (teams.data ?? []).filter((t) => !t.archived_at);
    const teamGate = optionsGate(teams, {
        loading: 'Loading teams…',
        failed: 'Couldn’t load teams',
    });

    function set<K extends keyof typeof draft>(key: K, value: string): void {
        setDraft((d) => ({...d, [key]: value}));
    }

    function submit(): void {
        const gitEmails = parseGitEmails(draft.gitEmails);
        // Blank optional fields are omitted rather than sent as '': the create
        // route stores what it is given, and an empty identity is no identity.
        create.mutate(
            {
                name: name.trim(),
                team,
                ...(email.trim() ? {email: email.trim()} : {}),
                ...(draft.github.trim() ? {github: draft.github.trim()} : {}),
                ...(draft.bitbucket.trim() ? {bitbucket: draft.bitbucket.trim()} : {}),
                ...(draft.gitlab.trim() ? {gitlab: draft.gitlab.trim()} : {}),
                ...(gitEmails.length > 0 ? {git_emails: gitEmails} : {}),
            },
            // Close only on success: a 409 keeps the dialog open with the draft
            // intact, so the conflict can't hide behind a dismissed modal. The
            // attributed-dates count comes back with the create (the server
            // replays retained authorship in the same transaction) and is what
            // the page confirms — a promotion that attributed nothing is a
            // different outcome from one that recovered six months of history.
            {
                onSuccess: (result) =>
                    onCreated({
                        name: result.developer.name,
                        datesAttributed: result.dates_attributed,
                    }),
            },
        );
    }

    return (
        <FormModal
            title={candidate ? `Add developer — ${candidateLabel(candidate)}` : 'Add developer'}
            onClose={onClose}
            onSubmit={submit}
            submitLabel="Add developer"
            pendingLabel="Adding…"
            pending={create.isPending}
            submitDisabled={!name.trim() || !team}
            error={create.isError ? create.error : null}
            testId="create-developer-modal"
        >
            <div className="space-y-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <TextField label="Name" value={name} onChange={setName} placeholder="Jane Doe" />
                    <SelectField label="Team" value={team} onChange={setTeam} disabled={teamGate.disabled}>
                        {/* An empty value keeps Save gated until a team is picked;
                            while the roster is unresolved the gate's own label
                            explains why the control is inert. */}
                        <option value="">{teamGate.label ?? 'Select a team…'}</option>
                        {activeTeams.map((t) => (
                            <option key={t.name} value={t.name}>
                                {t.name}
                            </option>
                        ))}
                    </SelectField>
                    <TextField
                        label="Email"
                        value={email}
                        onChange={setEmail}
                        placeholder="jane@company.com"
                    />
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

/** One unmatched-author row in the review queue. */
function CandidateRow({
    candidate,
    onPromote,
}: {
    candidate: AuthorCandidate;
    onPromote: (c: AuthorCandidate) => void;
}): JSX.Element {
    return (
        <tr className="border-b border-border/60">
            <Td>
                <span className="font-medium">
                    {candidate.display_name ?? candidateLabel(candidate)}
                </span>
                {candidate.likely_bot ? (
                    <>
                        {' '}
                        {/* Flagged, never hidden: the classifier is conservative and an
                            admin may legitimately promote an account it misread. The
                            reason rides in the tooltip so the badge isn't unexplained. */}
                        <Badge tone="warning" title={candidate.bot_reason}>
                            likely bot
                        </Badge>
                    </>
                ) : null}
            </Td>
            <Td>{candidate.provider}</Td>
            <Td>{candidateLabel(candidate)}</Td>
            <Td>{candidate.commit_count}</Td>
            <Td>{candidate.last_seen.slice(0, 10)}</Td>
            <Td>
                <SecondaryButton onClick={() => onPromote(candidate)} ariaHasPopup="dialog">
                    Add as developer
                </SecondaryButton>
            </Td>
        </tr>
    );
}

/**
 * The unmatched-authors review queue (DO1.5 / #255).
 *
 * These are git authors sync retained but could not attribute to anybody. Until
 * this shipped they were dropped into an advisory string nobody read, which is
 * how a freshly-connected provider ended up showing zero developers with no way
 * to find out who was actually committing.
 *
 * The list is DERIVED server-side from (retained authorship, identity map), so a
 * promoted author leaves it on the next fetch with nothing to clean up — the
 * create mutation invalidates this query.
 */
function UnmatchedAuthorsCard({onPromote}: {onPromote: (c: AuthorCandidate) => void}): JSX.Element {
    const candidates = useAdminDeveloperCandidates();

    return (
        // The page now carries TWO tables; the testid scopes assertions to this
        // one so a developers-table assertion cannot accidentally read a
        // candidate row (or vice versa).
        <div data-testid="unmatched-authors-card">
        <Card title="Unmatched authors">
            {candidates.isPending ? (
                <p className="text-sm text-muted">Loading…</p>
            ) : candidates.isError ? (
                <p className="text-sm text-danger">Failed to load: {candidates.error.message}</p>
            ) : (candidates.data ?? []).length === 0 ? (
                <EmptyState
                    title="No unmatched authors"
                    message="Every git author in the synced history already maps to a developer."
                    testId="candidates-empty"
                />
            ) : (
                <PaginatedTable
                    head={
                        <>
                            <Th>Author</Th>
                            <Th>Provider</Th>
                            <Th>Login / email</Th>
                            <Th>Commits</Th>
                            <Th>Last seen</Th>
                            <Th>Actions</Th>
                        </>
                    }
                    rows={candidates.data ?? []}
                    ariaLabel="Unmatched author pages"
                    storageKey="toprope.rowsPerPage.adminCandidates"
                    renderRow={(c) => (
                        <CandidateRow key={c.raw_author_key} candidate={c} onPromote={onPromote} />
                    )}
                />
            )}
        </Card>
        </div>
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
 * developer" box whose only job was to reveal an editor card below it. Since
 * DO1.1 (#251) the header also carries "＋ Add developer": developers used to
 * arrive only from the CLI or GitHub-org discovery, which left a connected
 * provider with no way to get anyone into the system.
 */
export function AdminIdentities(): JSX.Element {
    const developers = useAdminDevelopers();
    const formModal = useModalState<AdminDeveloper>();
    // Which candidate the open create dialog is promoting, if any. Kept beside
    // `formModal` rather than inside it: `useModalState` models create-or-edit over
    // ONE row type, and a candidate is not an AdminDeveloper. Both are cleared by
    // the same close, so they cannot disagree about what the dialog is doing.
    const [promoting, setPromoting] = useState<AuthorCandidate | null>(null);
    const [created, setCreated] = useState<{name: string; datesAttributed: number} | null>(null);

    function openPromote(candidate: AuthorCandidate): void {
        setCreated(null);
        setPromoting(candidate);
        formModal.openCreate();
    }

    function openCreate(): void {
        setCreated(null);
        setPromoting(null);
        formModal.openCreate();
    }

    function closeForm(): void {
        setPromoting(null);
        formModal.close();
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title="Developer identities"
                description="Add developers, link tool and git identities, and move developers between teams."
                actions={
                    <PrimaryButton onClick={openCreate} ariaHasPopup="dialog">
                        ＋ Add developer
                    </PrimaryButton>
                }
            />
            {/* The confirmation the acceptance criteria ask for: how much retained
                history the create actually attributed. Zero is reported honestly
                rather than dressed up as success — it means the identities matched
                no retained authorship, which is worth noticing. */}
            {created ? (
                <div
                    // `role="status"` for the same reason `TempPasswordBanner` carries it
                    // (#239): this banner renders on the PAGE after `FormModal` unmounts and
                    // focus is restored to the ＋ Add developer header button, so it lands
                    // nowhere near the user's focus. Unannounced, a screen-reader admin gets
                    // no confirmation at all — and the attributed-days count IS the payload
                    // of the feature, the thing #251/#255 promise the operator.
                    role="status"
                    data-testid="create-developer-confirmation"
                    className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
                >
                    {created.datesAttributed > 0
                        ? `Added ${created.name} — attributed ${created.datesAttributed} day(s) of retained history.`
                        : `Added ${created.name} — no retained history matched their identities yet.`}
                </div>
            ) : null}
            {/* No dialog renders until the admin asks for one. Create and edit
                are distinct components rather than one form with a nullable row:
                creating writes a whole developer (name + team + identities) in
                one POST, while editing splits into an identities PATCH and a
                separate team move. The edit branch keys on the developer's id so
                switching rows always remounts clean fields (#236 criterion 3),
                and `editing` is what narrows the non-null `dev` prop. */}
            {formModal.mode === 'create' ? (
                <CreateDeveloperFormModal
                    // Remount per candidate (and for the blank form) so the seeded
                    // fields reset instead of persisting from the previous author.
                    key={promoting?.raw_author_key ?? 'new'}
                    candidate={promoting ?? undefined}
                    onClose={closeForm}
                    onCreated={(result) => {
                        setCreated(result);
                        closeForm();
                    }}
                />
            ) : formModal.editing ? (
                <IdentityFormModal
                    key={formModal.editing.id}
                    dev={formModal.editing}
                    onDone={formModal.close}
                />
            ) : null}
            <UnmatchedAuthorsCard onPromote={openPromote} />
            <div data-testid="developers-card">
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
        </div>
    );
}
