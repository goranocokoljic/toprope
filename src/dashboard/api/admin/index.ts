import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {registerAdminUserRoutes} from './users';
import {registerAdminTeamRoutes} from './teams';
import {registerAdminDeveloperRoutes} from './developers';
import {registerAdminSubscriptionRoutes} from './subscriptions';
import {registerAdminDataSourceRoutes} from './data-sources';
import {registerAdminReconciliationRoutes} from './reconciliation';

/**
 * Admin Management API (Task 2.13 / #48). Wraps the Phase 1 user/team/developer/
 * subscription capabilities behind admin-only HTTP endpoints so the web Admin
 * area can manage them without the CLI. The session middleware already confines
 * the developer role away from /api/admin; each route additionally asserts the
 * admin role as defense-in-depth.
 */
export function registerAdminRoutes(app: FastifyInstance, db: Database.Database): void {
    registerAdminUserRoutes(app, db);
    registerAdminTeamRoutes(app, db);
    registerAdminDeveloperRoutes(app, db);
    registerAdminSubscriptionRoutes(app, db);
    registerAdminDataSourceRoutes(app, db);
    registerAdminReconciliationRoutes(app, db);
}
