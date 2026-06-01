import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {computeConnectors, computeGitProviders} from '../coverage';
import {forbidden, isAdmin} from './helpers';

/**
 * Read-only data-sources view (Task 2.13). Reports tool connector status and git
 * provider status derived from sync logs and snapshot activity. Connector
 * CONFIGURATION stays in the config file in Phase 2 — this endpoint only
 * surfaces operational status, never accepts changes.
 */
export function registerAdminDataSourceRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/admin/data-sources', async (request, reply) => {
        if (!isAdmin(request)) return forbidden(reply);
        return {
            data: {
                connectors: computeConnectors(db),
                git_providers: computeGitProviders(db),
            },
        };
    });
}
