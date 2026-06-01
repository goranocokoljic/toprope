import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    getSubscriptionById,
    listSubscriptions,
    revokeSubscription,
    upsertSubscription,
} from '../../../expenses/subscription-tracker';
import {getDeveloperById} from '../../../registry/developers';
import {asObject, badRequest, forbidden, isAdmin, notFound} from './helpers';

// Subscriptions created/changed through the admin UI are tagged with this
// data_source so they are distinguishable from CSV-imported ones.
const ADMIN_DATA_SOURCE = 'admin';
const DEFAULT_BILLING_MODEL = 'company_managed';

export function registerAdminSubscriptionRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/admin/subscriptions', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        return {data: listSubscriptions(db)};
    });

    // Assign or change a subscription. upsertSubscription is lifecycle-aware: a
    // plan/cost change to an existing active seat revokes the old row and opens a
    // new one (recording a plan_change_event), rather than silently overwriting.
    app.post<{Body: unknown}>('/api/admin/subscriptions', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        const body = asObject(request.body);
        if (!body) return badRequest(reply, 'Request body must be an object');

        const developerId = typeof body.developer_id === 'string' ? body.developer_id : '';
        if (!developerId || !getDeveloperById(db, developerId)) {
            return badRequest(reply, 'A valid developer_id is required');
        }
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        if (!tool) return badRequest(reply, 'tool is required');

        let plan: string | null = null;
        if (body.plan !== undefined && body.plan !== null) {
            if (typeof body.plan !== 'string') return badRequest(reply, 'plan must be a string');
            plan = body.plan.trim() || null;
        }

        let monthlyCost: number | null = null;
        if (body.monthly_cost !== undefined && body.monthly_cost !== null) {
            if (typeof body.monthly_cost !== 'number' || !Number.isFinite(body.monthly_cost) || body.monthly_cost < 0) {
                return badRequest(reply, 'monthly_cost must be a non-negative number');
            }
            monthlyCost = body.monthly_cost;
        }

        const billingModel =
            typeof body.billing_model === 'string' && body.billing_model.trim()
                ? body.billing_model.trim()
                : DEFAULT_BILLING_MODEL;

        const subscription = upsertSubscription(db, {
            developer_id: developerId,
            tool,
            plan,
            billing_model: billingModel,
            monthly_cost: monthlyCost,
            data_source: ADMIN_DATA_SOURCE,
        });
        return reply.status(201).send({data: subscription});
    });

    // End a subscription (revoke the seat). active:false ends it; the row is kept
    // so cost history stays intact.
    app.patch<{Params: {id: string}; Body: unknown}>(
        '/api/admin/subscriptions/:id',
        async (request, reply) => {
            if (!isAdmin(request)) return forbidden(reply);
            const existing = getSubscriptionById(db, request.params.id);
            if (!existing) return notFound(reply, 'Subscription not found');

            const body = asObject(request.body);
            if (!body) return badRequest(reply, 'Request body must be an object');

            if (body.active !== false) {
                return badRequest(reply, 'Only ending a subscription (active:false) is supported here');
            }
            revokeSubscription(db, existing.id);
            return {data: getSubscriptionById(db, existing.id)};
        },
    );
}
