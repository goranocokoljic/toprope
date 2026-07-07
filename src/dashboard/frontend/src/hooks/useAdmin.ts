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
    AdminGitProvider,
    AdminPasswordReset,
    AdminSubscription,
    AdminTeam,
    AdminUser,
    AdminUserWithTempPassword,
    GitProviderInput,
    GitProviderProbeResult,
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
export function useAdminGitProviders(): UseQueryResult<AdminGitProvider[], Error> {
    return useQuery({queryKey: queryKeys.adminGitProviders, queryFn: api.getAdminGitProviders});
}

function useInvalidateGitProviders(): () => void {
    const qc = useQueryClient();
    return () => void qc.invalidateQueries({queryKey: queryKeys.adminGitProviders});
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

/** Trigger a sync for one saved provider; the outcome lands on the row (poll the list). */
export function useSyncAdminGitProvider(): UseMutationResult<GitProviderSyncHandle, Error, string> {
    const invalidate = useInvalidateGitProviders();
    return useMutation({mutationFn: (id: string) => api.syncAdminGitProvider(id), onSuccess: invalidate});
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
