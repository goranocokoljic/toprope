import {useContext} from 'react';
import {Link} from 'react-router-dom';
import {AuthContext} from '../auth/authContext';
import {useAdminDeveloperCandidates} from '../hooks/useAdmin';
import {StatePanel} from './StatePanel';

/**
 * The cold-start fix for the dead end that motivated Epic DO1 (#250): a git
 * provider is connected, sync has run and retained the repository's authorship —
 * and the product shows nothing, because sync attributes commits only to
 * developers that already exist and the registry is empty.
 *
 * Before DO1 there was no way out of that state from the UI at all. Now there is
 * (Admin → Developer identities carries "＋ Add developer" and the unmatched-author
 * review queue), but only if you already know to look there. This panel is the
 * signpost: it appears on the organization overview — the surface where the
 * emptiness is actually noticed — states how many authors are waiting, and links
 * straight to the queue.
 *
 * It renders `null` unless ALL of these hold, so it can never nag an org that is
 * simply new:
 *
 *  - the viewer is an admin. The review queue and the create route are both
 *    admin-gated server-side, so pointing anyone else at them offers an action
 *    they cannot take — and the candidates fetch itself would 403.
 *  - the org has ZERO developers. One developer means onboarding has started and
 *    the ordinary review queue on the admin page is the right surface; this is a
 *    first-run signpost, not a permanent nag about unmatched authors.
 *  - retained authorship resolved to at least one unmatched author. With no
 *    candidates there is nothing to promote, so the honest state is the ordinary
 *    cold-start "connect a tool / register developers" copy, not this.
 *
 * The candidates query is `enabled` only when the first two hold, so a manager
 * loading the overview issues no admin request, and an org with developers issues
 * none either.
 */
export function OnboardingEmptyState({
    /**
     * Developers currently in the registry — `OverviewData.total_developers`. Taken
     * as a prop rather than fetched again: the overview has already loaded it, and a
     * second source for "how many developers exist" is a second thing that can
     * disagree with the number displayed a few pixels above.
     */
    totalDevelopers,
}: {
    totalDevelopers: number;
}): JSX.Element | null {
    // Read the context directly rather than through `useAuth`, matching
    // `RequireAdmin`: that keeps the component harmless when it is rendered
    // outside an AuthProvider (isolated tests, storybook-style harnesses) instead
    // of throwing.
    const auth = useContext(AuthContext);
    const isAdmin = auth?.user?.role === 'admin';
    const eligible = isAdmin && totalDevelopers === 0;

    const candidates = useAdminDeveloperCandidates({enabled: eligible});
    const count = candidates.data?.length ?? 0;

    // A failed or in-flight candidates fetch renders nothing rather than a
    // guessed-at panel: this is an advisory signpost, and the page's own error
    // and loading treatments already own those states.
    if (!eligible || count === 0) return null;

    return (
        <StatePanel
            tone="warning"
            testId="onboarding-empty-state"
            icon={<span aria-hidden>👥</span>}
            title="You have unmatched authors — add developers to see activity"
            description={
                `Sync retained commit history for ${count} git ` +
                `${count === 1 ? 'author' : 'authors'} that ${count === 1 ? 'does' : 'do'} not map to ` +
                'any developer yet. Adding them attributes that retained history automatically — ' +
                'no re-sync needed.'
            }
        >
            <div className="text-center">
                <Link
                    to="/admin/identities"
                    className="inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
                >
                    Review {count} unmatched {count === 1 ? 'author' : 'authors'} →
                </Link>
            </div>
        </StatePanel>
    );
}
