import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseMutationResult,
    type UseQueryResult,
} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {
    AdminDataSources,
    AdminDeveloper,
    AdminDeveloperCreated,
    AdminDeveloperInput,
    AuthorCandidate,
    AdminGitProvider,
    AdminPasswordReset,
    AdminSubscription,
    AdminTeam,
    AdminUser,
    AdminUserWithTempPassword,
    GitProviderInput,
    GitProviderProbeResult,
    GitProviderRepo,
    GitProviderSyncHandle,
    ReconciliationResult,
    ReconciliationRunSummary,
    ReconciliationStatus,
} from '../api/types';

/**
 * React Query hooks for the Admin Management area (Task 2.13). Each mutation
 * invalidates the list it affects so the UI reflects the new server state
 * (lifecycle changes, archival, identity edits) without a manual refetch.
 */

// --- Users ---
export function useAdminUsers(): UseQueryResult<AdminUser[], Error> {
    return useQuery({queryKey: queryKeys.adminUsers, queryFn: api.getAdminUsers});
}

export function useCreateAdminUser(): UseMutationResult<
    AdminUserWithTempPassword,
    Error,
    {email: string; role: string; developer_id?: string | null}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: api.createAdminUser,
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminUsers}),
    });
}

export function useUpdateAdminUser(): UseMutationResult<
    AdminUser,
    Error,
    {id: string; patch: {email?: string; role?: string; developer_id?: string | null; active?: boolean}}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({id, patch}) => api.updateAdminUser(id, patch),
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminUsers}),
    });
}

export function useResetAdminUserPassword(): UseMutationResult<AdminPasswordReset, Error, string> {
    return useMutation({mutationFn: (id: string) => api.resetAdminUserPassword(id)});
}

// --- Teams ---
export function useAdminTeams(): UseQueryResult<AdminTeam[], Error> {
    return useQuery({queryKey: queryKeys.adminTeams, queryFn: api.getAdminTeams});
}

export function useCreateAdminTeam(): UseMutationResult<
    AdminTeam,
    Error,
    {name: string; department?: string | null; manager?: string | null}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: api.createAdminTeam,
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminTeams}),
    });
}

export function useUpdateAdminTeam(): UseMutationResult<
    AdminTeam,
    Error,
    {name: string; patch: {department?: string | null; manager?: string | null; archived?: boolean}}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({name, patch}) => api.updateAdminTeam(name, patch),
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminTeams}),
    });
}

// --- Developers ---
export function useAdminDevelopers(): UseQueryResult<AdminDeveloper[], Error> {
    return useQuery({queryKey: queryKeys.adminDevelopers, queryFn: api.getAdminDevelopers});
}

/**
 * The unmatched-author review queue (DO1.5 / #255) — retained git authors that map
 * to no developer, busiest first.
 */
export function useAdminDeveloperCandidates(
    // Optional and defaulted so the review queue's existing call site is
    // unchanged. The onboarding empty-state (DO1.7 / #257) passes `false` when
    // the org already has developers or the viewer is not an admin — the route
    // is admin-gated, so an ungated fetch would 403 for every manager who loads
    // the overview, and the query would be pure noise even when it succeeded.
    options: {enabled?: boolean} = {},
): UseQueryResult<AuthorCandidate[], Error> {
    return useQuery({
        queryKey: queryKeys.adminDeveloperCandidates,
        queryFn: api.getAdminDeveloperCandidates,
        enabled: options.enabled ?? true,
    });
}

/**
 * Create a developer (DO1.1 / #251). Invalidates the developers list so the new
 * row appears without a manual refetch, AND the candidate queue: the create
 * replays the new developer's retained authorship server-side, so whichever
 * candidate they matched is no longer unmatched (DO1.5 / #255).
 */
export function useCreateAdminDeveloper(): UseMutationResult<
    AdminDeveloperCreated,
    Error,
    AdminDeveloperInput
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: api.createAdminDeveloper,
        onSuccess: () => {
            void qc.invalidateQueries({queryKey: queryKeys.adminDevelopers});
            void qc.invalidateQueries({queryKey: queryKeys.adminDeveloperCandidates});
        },
    });
}

export function useUpdateAdminDeveloperIdentities(): UseMutationResult<
    AdminDeveloper,
    Error,
    {
        id: string;
        identities: {
            github?: string;
            copilot?: string;
            claude?: string;
            windsurf?: string;
            cursor?: string;
            bitbucket?: string;
            gitlab?: string;
            git_emails?: string[];
        };
    }
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({id, identities}) => api.updateAdminDeveloperIdentities(id, identities),
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminDevelopers}),
    });
}

export function useMoveAdminDeveloper(): UseMutationResult<
    AdminDeveloper,
    Error,
    {id: string; team: string}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({id, team}) => api.moveAdminDeveloper(id, team),
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminDevelopers}),
    });
}

// --- Subscriptions ---
export function useAdminSubscriptions(): UseQueryResult<AdminSubscription[], Error> {
    return useQuery({queryKey: queryKeys.adminSubscriptions, queryFn: api.getAdminSubscriptions});
}

export function useAssignAdminSubscription(): UseMutationResult<
    AdminSubscription,
    Error,
    {developer_id: string; tool: string; plan?: string | null; monthly_cost?: number | null; billing_model?: string}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: api.assignAdminSubscription,
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminSubscriptions}),
    });
}

export function useEndAdminSubscription(): UseMutationResult<AdminSubscription, Error, string> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.endAdminSubscription(id),
        onSuccess: () => void qc.invalidateQueries({queryKey: queryKeys.adminSubscriptions}),
    });
}

// --- Data sources (read-only) ---
export function useAdminDataSources(): UseQueryResult<AdminDataSources, Error> {
    return useQuery({queryKey: queryKeys.adminDataSources, queryFn: api.getAdminDataSources});
}

// --- Git providers (GC1 / #200) ---
// One list query; every write invalidates it so masked rows + sync status stay
// fresh. Test-connection is a mutation (a probe with a result), not a query —
// the admin triggers it explicitly and reads the ok/error inline.
/**
 * Poll cadence for the provider list (#209): 1s while any sync-now run is in
 * flight, off otherwise. A pure function of the cached list so the stop/start
 * condition is unit-testable deterministically — the hook wires it to
 * `query.state.data`.
 */
export function gitProvidersRefetchInterval(
    providers: AdminGitProvider[] | undefined,
): number | false {
    return providers?.some((p) => p.active_sync !== null) ? 1000 : false;
}

export function useAdminGitProviders(): UseQueryResult<AdminGitProvider[], Error> {
    return useQuery({
        queryKey: queryKeys.adminGitProviders,
        queryFn: api.getAdminGitProviders,
        // Poll only while a sync-now run is in flight (#209): live progress
        // (`active_sync`) streams in every second, and the poll that observes
        // the run settle both stops itself and already carries the terminal
        // last_sync_* outcome — no manual refresh.
        refetchInterval: (query) => gitProvidersRefetchInterval(query.state.data),
    });
}

// Returns the invalidation PROMISE so mutations that return it from their
// callback keep `isPending` true until the refetched list lands — the button
// can't re-enable against stale data (e.g. `active_sync` still null right
// after a sync trigger's 202).
function useInvalidateGitProviders(): () => Promise<void> {
    const qc = useQueryClient();
    return () => qc.invalidateQueries({queryKey: queryKeys.adminGitProviders});
}

export function useCreateAdminGitProvider(): UseMutationResult<AdminGitProvider, Error, GitProviderInput> {
    const invalidate = useInvalidateGitProviders();
    return useMutation({mutationFn: api.createAdminGitProvider, onSuccess: invalidate});
}

export function useUpdateAdminGitProvider(): UseMutationResult<
    AdminGitProvider,
    Error,
    {id: string; patch: GitProviderInput}
> {
    const invalidate = useInvalidateGitProviders();
    return useMutation({
        mutationFn: ({id, patch}) => api.updateAdminGitProvider(id, patch),
        onSuccess: invalidate,
    });
}

export function useDeleteAdminGitProvider(): UseMutationResult<{id: string; deleted: boolean}, Error, string> {
    const invalidate = useInvalidateGitProviders();
    return useMutation({mutationFn: (id: string) => api.deleteAdminGitProvider(id), onSuccess: invalidate});
}

/** Probe a saved provider by id. Resolves to {ok:false} on a reachability/auth failure. */
export function useTestAdminGitProvider(): UseMutationResult<GitProviderProbeResult, Error, string> {
    return useMutation({mutationFn: (id: string) => api.testAdminGitProvider(id)});
}

/** Probe a draft (unsaved) provider from the form body before saving. */
export function useTestDraftGitProvider(): UseMutationResult<GitProviderProbeResult, Error, GitProviderInput> {
    return useMutation({mutationFn: api.testDraftGitProvider});
}

/**
 * Trigger a sync for one saved provider; the outcome lands on the row (poll the
 * list). Invalidation runs on SETTLED, not success-only: a 409 ("already in
 * progress") or 503 must also refresh the list so the row picks up the actual
 * in-flight run and polling starts — otherwise the UI contradicts its own error.
 */
export function useSyncAdminGitProvider(): UseMutationResult<
    GitProviderSyncHandle,
    Error,
    {id: string; months?: number}
> {
    const invalidate = useInvalidateGitProviders();
    return useMutation({
        mutationFn: ({id, months}: {id: string; months?: number}) =>
            api.syncAdminGitProvider(id, months),
        onSettled: invalidate,
    });
}

/**
 * "Sync older history" (#229): extend a provider's synced window backward by an
 * ABSOLUTE months value. Like {@link useSyncAdminGitProvider}, invalidation runs
 * on SETTLED so a 409 (nothing older to sync / already in progress) or 503 still
 * refreshes the row — otherwise the UI would contradict its own error.
 */
export function useSyncOlderHistoryGitProvider(): UseMutationResult<
    GitProviderSyncHandle,
    Error,
    {id: string; months: number}
> {
    const invalidate = useInvalidateGitProviders();
    return useMutation({
        mutationFn: ({id, months}: {id: string; months: number}) =>
            api.syncOlderHistoryAdminGitProvider(id, months),
        onSettled: invalidate,
    });
}

/**
 * List a saved provider's repositories for the repo-scope picker (GC1.9 / #201).
 * `enabled` gates the fetch so the (potentially slow, network-bound) `/repos`
 * probe only runs once the admin opens "Select repositories" for this provider.
 */
export function useAdminGitProviderRepos(
    id: string,
    enabled: boolean,
): UseQueryResult<GitProviderRepo[], Error> {
    return useQuery({
        queryKey: queryKeys.adminGitProviderRepos(id),
        queryFn: () => api.getAdminGitProviderRepos(id),
        enabled,
    });
}

// --- Expense reconciliation (Task 4.4 / #99) ---
export function useReconciliation(
    status: ReconciliationStatus | 'all',
): UseQueryResult<ReconciliationResult[], Error> {
    return useQuery({
        queryKey: queryKeys.adminReconciliation(status),
        queryFn: () => api.getReconciliation(status),
    });
}

/**
 * Invalidate every reconciliation query (all status filters) after a mutation,
 * so a run/resolve/ignore is reflected regardless of which filter is active.
 */
function useInvalidateReconciliation(): () => void {
    const qc = useQueryClient();
    return () => void qc.invalidateQueries({queryKey: ['admin', 'reconciliation']});
}

export function useRunReconciliation(): UseMutationResult<
    ReconciliationRunSummary,
    Error,
    {period?: string; tolerance?: number}
> {
    const invalidate = useInvalidateReconciliation();
    return useMutation({mutationFn: api.runReconciliation, onSuccess: invalidate});
}

export function useResolveReconciliation(): UseMutationResult<
    ReconciliationResult,
    Error,
    {id: string; resolution: string}
> {
    const invalidate = useInvalidateReconciliation();
    return useMutation({
        mutationFn: ({id, resolution}) => api.resolveReconciliation(id, resolution),
        onSuccess: invalidate,
    });
}

export function useIgnoreReconciliation(): UseMutationResult<
    ReconciliationResult,
    Error,
    {id: string; note?: string}
> {
    const invalidate = useInvalidateReconciliation();
    return useMutation({
        mutationFn: ({id, note}) => api.ignoreReconciliation(id, note),
        onSuccess: invalidate,
    });
}
