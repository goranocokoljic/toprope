import type Database from 'better-sqlite3';
import {getDeveloperById, findByEmail} from '../registry/developers';
import {readEnvWithLegacyFallback} from '../config/compat';
import {SelfReportError} from './core';

export const DEVELOPER_ID_ENV = 'TOPROPE_DEVELOPER_ID';
export const DEVELOPER_EMAIL_ENV = 'TOPROPE_DEVELOPER_EMAIL';

/**
 * Resolve the authenticated developer for a self-reporting CLI command.
 *
 * Identity comes from the caller's own environment — never from a command
 * argument — so a developer can only ever log usage for themselves. There is
 * deliberately no flag to target another developer.
 *
 * Precedence:
 *   1. TOPROPE_DEVELOPER_ID    — exact developer id
 *   2. TOPROPE_DEVELOPER_EMAIL — resolved against the registry by email
 *
 * Throws SelfReportError when no identity is configured or it doesn't match a
 * known developer.
 */
export function resolveSelfDeveloperId(
    db: Database.Database,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const idRaw = readEnvWithLegacyFallback(DEVELOPER_ID_ENV, env)?.trim();
    if (idRaw) {
        const dev = getDeveloperById(db, idRaw);
        if (!dev) {
            throw new SelfReportError(
                `${DEVELOPER_ID_ENV}='${idRaw}' does not match any developer. ` +
                    'Check your developer id with `toprope dev list`.',
            );
        }
        return dev.id;
    }

    const emailRaw = readEnvWithLegacyFallback(DEVELOPER_EMAIL_ENV, env)?.trim();
    if (emailRaw) {
        const dev = findByEmail(db, emailRaw);
        if (!dev) {
            throw new SelfReportError(
                `${DEVELOPER_EMAIL_ENV}='${emailRaw}' does not match any developer. ` +
                    'Check your registered email with `toprope dev list`.',
            );
        }
        return dev.id;
    }

    throw new SelfReportError(
        `No developer identity configured. Set ${DEVELOPER_ID_ENV} (your developer id) ` +
            `or ${DEVELOPER_EMAIL_ENV} (your registered email) to log your own usage. ` +
            'Find your id with `toprope dev list`.',
    );
}
