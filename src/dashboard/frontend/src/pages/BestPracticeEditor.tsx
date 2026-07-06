import {useEffect, useState} from 'react';
import {Link, useNavigate, useParams} from 'react-router-dom';
import {
    useBrowsePractices,
    useCreatePractice,
    useOwnedPractice,
    usePreviewPractice,
    useSavePractice,
} from '../hooks/usePractices';
import {Card} from '../components/Card';
import {Skeleton} from '../components/Skeleton';
import {ErrorState} from '../components/ErrorState';
import {contributionModelExplainer} from '../components/practiceModel';
import type {ContributionModel} from '../api/types';

/**
 * Best-practice create / edit editor (Task 6.2.8 / #163) — the create/edit ENTRY POINTS
 * the browse UI links to, "respecting the active contribution model" (6.2.2).
 *
 * One component drives both routes: `/developer/practices/new` (create a draft) and
 * `/developer/practices/:id/edit` (edit one of your own). It is a thin surface over the
 * 6.2.3 authoring routes — title/scope/markdown with a live sanitized preview — and it
 * keeps the model-aware framing honest: creating lands a DRAFT, and the confirmation
 * explains what publishing means for the viewer's team rather than implying it is live.
 * Edit is owner-only server-side; the browse detail only links here when `canEdit`.
 */
export function BestPracticeEditor(): JSX.Element {
    const {id: idParam} = useParams<{id: string}>();
    const editId = idParam ?? '';
    const isEdit = editId.length > 0;

    const owned = useOwnedPractice(editId, isEdit);
    // The active model drives the model-aware copy; it's already cached from the list.
    const browse = useBrowsePractices({});

    const [title, setTitle] = useState('');
    const [scope, setScope] = useState<'org' | 'team'>('org');
    const [markdown, setMarkdown] = useState('');
    const [loaded, setLoaded] = useState(false);

    // Seed the editor from the loaded practice ONCE, so later keystrokes aren't clobbered
    // by a re-render of the same query data.
    useEffect(() => {
        if (isEdit && owned.data && !loaded) {
            setTitle(owned.data.title);
            setMarkdown(owned.data.markdown);
            setLoaded(true);
        }
    }, [isEdit, owned.data, loaded]);

    if (isEdit && owned.isPending) {
        return (
            <Card>
                <Skeleton className="h-40 w-full" />
            </Card>
        );
    }
    if (isEdit && owned.isError) {
        return (
            <ErrorState
                title="Couldn’t open this practice"
                detail="You can only edit practices you authored."
            />
        );
    }

    return (
        <EditorForm
            isEdit={isEdit}
            editId={editId}
            title={title}
            setTitle={setTitle}
            scope={scope}
            setScope={setScope}
            markdown={markdown}
            setMarkdown={setMarkdown}
            model={browse.data?.model}
        />
    );
}

interface EditorFormProps {
    isEdit: boolean;
    editId: string;
    title: string;
    setTitle: (v: string) => void;
    scope: 'org' | 'team';
    setScope: (v: 'org' | 'team') => void;
    markdown: string;
    setMarkdown: (v: string) => void;
    model: ContributionModel | undefined;
}

function EditorForm(props: EditorFormProps): JSX.Element {
    const {isEdit, editId, title, setTitle, scope, setScope, markdown, setMarkdown, model} = props;
    const navigate = useNavigate();
    const preview = usePreviewPractice();
    const create = useCreatePractice();
    const save = useSavePractice(editId);
    const [created, setCreated] = useState(false);

    const canSubmit = markdown.trim().length > 0 && (isEdit || title.trim().length > 0);

    function submit(e: React.FormEvent): void {
        e.preventDefault();
        if (!canSubmit) {
            return;
        }
        if (isEdit) {
            save.mutate(markdown, {onSuccess: () => navigate(`/developer/practices/${encodeURIComponent(editId)}`)});
        } else {
            create.mutate({title: title.trim(), scope, markdown}, {onSuccess: () => setCreated(true)});
        }
    }

    if (created) {
        return (
            <Card title="Draft saved">
                <p className="text-sm text-muted" data-testid="create-confirmation">
                    Your practice was saved as a draft.{model ? ` ${contributionModelExplainer(model)}` : ''}
                </p>
                <div className="mt-3">
                    <Link to="/developer/practices" className="text-sm font-medium text-accent hover:underline">
                        ← Back to best practices
                    </Link>
                </div>
            </Card>
        );
    }

    const submitError = isEdit ? save.error : create.error;

    return (
        <div className="space-y-5">
            <div>
                <Link to="/developer/practices" className="text-xs text-accent hover:underline">
                    ← All best practices
                </Link>
                <h1 className="mt-2 text-2xl font-semibold text-foreground">
                    {isEdit ? 'Edit practice' : 'Share a practice'}
                </h1>
                {model ? (
                    <p className="mt-1 text-sm text-muted" data-testid="model-explainer">
                        {contributionModelExplainer(model)}
                    </p>
                ) : null}
            </div>

            <Card>
                <form onSubmit={submit} className="space-y-4" aria-label="Practice editor">
                    {!isEdit ? (
                        <>
                            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                                Title
                                <input
                                    type="text"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    placeholder="A short, descriptive title"
                                    className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                                Scope
                                <select
                                    value={scope}
                                    onChange={(e) => setScope(e.target.value as 'org' | 'team')}
                                    className="w-48 rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                                >
                                    <option value="org">Organization</option>
                                    <option value="team">My team</option>
                                </select>
                            </label>
                        </>
                    ) : null}
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Content (Markdown — fenced code blocks and {'{{metric}}'} references supported)
                        <textarea
                            value={markdown}
                            onChange={(e) => setMarkdown(e.target.value)}
                            rows={12}
                            placeholder="Write the practice in Markdown…"
                            className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                        />
                    </label>

                    {submitError ? (
                        <p className="text-xs text-danger">
                            Couldn’t save. Check the title and content, then try again.
                        </p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            type="submit"
                            disabled={!canSubmit || create.isPending || save.isPending}
                            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-60"
                        >
                            {isEdit ? 'Save changes' : 'Save draft'}
                        </button>
                        <button
                            type="button"
                            onClick={() => preview.mutate(markdown)}
                            disabled={preview.isPending}
                            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground disabled:opacity-60"
                        >
                            Update preview
                        </button>
                    </div>
                </form>
            </Card>

            {preview.data ? (
                <Card title="Preview">
                    <div
                        className="practice-content space-y-3 text-sm leading-relaxed text-foreground [&_code]:rounded [&_code]:bg-surface-raised [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-raised [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5"
                        data-testid="editor-preview"
                        dangerouslySetInnerHTML={{__html: preview.data.html}}
                    />
                </Card>
            ) : null}
        </div>
    );
}
