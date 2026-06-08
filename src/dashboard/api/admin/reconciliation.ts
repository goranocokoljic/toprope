import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    getReconciliationResultById,
    ignoreReconciliationResult,
    latestExpensePeriod,
    listReconciliationResults,
    reconcilePeriod,
    resolveReconciliationResult,
    type ReconciliationStatus,
} from '../../../expenses/reconcile';
import {asObject, badRequest, conflict, forbidden, isAdmin, notFound} from './helpers';

const VALID_STATUSES: readonly (ReconciliationStatus | 'all')[] = [
    'open',
    'resolved',
    'ignored',
    'all',
];
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Admin Reconciliation API (Task 4.4 / #99). Exposes the expense-vs-registry
 * reconciliation queue and the resolve/ignore workflow behind admin-only HTTP
 * endpoints, mirroring the rest of the admin area: the session middleware
 * already confines the developer role away from /api/admin, and each route
 * re-asserts the admin role as defense-in-depth.
 */
export function registerAdminReconciliationRoutes(
    app: FastifyInstance,
    db: Database.Database,
): void {
    // List reconciliation results. Defaults to open (the action queue); ?status=
    // (open|resolved|ignored|all) and ?period=YYYY-MM narrow the view.
    app.get<{Querystring: {status?: string; period?: string}}>(
        '/api/admin/reconciliation',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);

            const statusParam = request.query.status;
            if (statusParam !== undefined && !VALID_STATUSES.includes(statusParam as ReconciliationStatus | 'all')) {
                return badRequest(reply, `status must be one of: ${VALID_STATUSES.join(', ')}`);
            }
            const period = request.query.period;
            if (period !== undefined && !PERIOD_RE.test(period)) {
                return badRequest(reply, 'period must be in YYYY-MM format');
            }

            return {
                data: listReconciliationResults(db, {
                    status: statusParam as ReconciliationStatus | 'all' | undefined,
                    period,
                }),
            };
        },
    );

    // Run reconciliation for a period. Defaults to the latest expense period when
    // none is supplied. Optional tolerance overrides the cost-discrepancy cutoff.
    app.post<{Body: unknown}>('/api/admin/reconciliation/run', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const body = asObject(request.body) ?? {};

        let period: string | undefined;
        if (body.period !== undefined && body.period !== null) {
            if (typeof body.period !== 'string' || !PERIOD_RE.test(body.period)) {
                return badRequest(reply, 'period must be in YYYY-MM format');
            }
            period = body.period;
        }
        if (!period) {
            const latest = latestExpensePeriod(db);
            if (!latest) {
                return badRequest(reply, 'No expense data to reconcile. Import expenses or pass a period.');
            }
            period = latest;
        }

        let tolerance: number | undefined;
        if (body.tolerance !== undefined && body.tolerance !== null) {
            if (typeof body.tolerance !== 'number' || !Number.isFinite(body.tolerance) || body.tolerance < 0) {
                return badRequest(reply, 'tolerance must be a non-negative number');
            }
            tolerance = body.tolerance;
        }

        const summary = reconcilePeriod(db, period, {tolerance});
        return {data: summary};
    });

    // Resolve an open result with a (required) note.
    app.post<{Params: {id: string}; Body: unknown}>(
        '/api/admin/reconciliation/:id/resolve',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            if (!getReconciliationResultById(db, request.params.id)) {
                return notFound(reply, 'Reconciliation result not found');
            }
            const body = asObject(request.body);
            if (!body) return badRequest(reply, 'Request body must be an object');

            const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : '';
            if (!resolution) {
                return badRequest(reply, 'A non-empty resolution note is required');
            }

            try {
                return {data: resolveReconciliationResult(db, request.params.id, resolution)};
            } catch (err) {
                // Already resolved/ignored — a concurrent action beat this one.
                return conflict(reply, err instanceof Error ? err.message : 'Could not resolve result');
            }
        },
    );

    // Ignore an open result (suppress it from future runs). Note optional.
    app.post<{Params: {id: string}; Body: unknown}>(
        '/api/admin/reconciliation/:id/ignore',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            if (!getReconciliationResultById(db, request.params.id)) {
                return notFound(reply, 'Reconciliation result not found');
            }
            const body = asObject(request.body) ?? {};
            let note: string | undefined;
            if (body.note !== undefined && body.note !== null) {
                if (typeof body.note !== 'string') {
                    return badRequest(reply, 'note must be a string');
                }
                note = body.note;
            }

            try {
                return {data: ignoreReconciliationResult(db, request.params.id, note)};
            } catch (err) {
                return conflict(reply, err instanceof Error ? err.message : 'Could not ignore result');
            }
        },
    );
}
