import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {generateSummary, type GenerateOptions} from '../../src/summaries/generator';
import {getSummaryByTarget} from '../../src/summaries/store';
import type {SummaryTarget} from '../../src/summaries/target';
import type {
    SummaryModelClient,
    SummaryModelResult,
} from '../../src/summaries/model-client';
import {makeDb, addDeveloper, addGitSnapshot} from '../aggregation/helpers';

const TARGET: SummaryTarget = {
    level: 'monthly',
    period: '2026-05',
    scope: {type: 'team', name: 'backend'},
};
const NOW = new Date('2026-06-01T00:00:00.000Z');

/** A fake model client whose generate() is fully controlled by the test. */
function fakeClient(impl: (prompt: string) => Promise<SummaryModelResult>): SummaryModelClient {
    return {generate: impl} as unknown as SummaryModelClient;
}

/** Build GenerateOptions wiring a canned client result and a pinned clock. */
function deps(
    impl: (prompt: string) => Promise<SummaryModelResult>,
    extra: Partial<GenerateOptions> = {},
): GenerateOptions {
    return {now: () => NOW, createClient: () => fakeClient(impl), ...extra};
}

function seed(db: Database.Database): void {
    addDeveloper(db, 'dev-1', 'backend');
    addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2, code_churn_rate: 0.2});
}

describe('generateSummary', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        seed(db);
    });
    afterEach(() => db.close());

    it('stores text, model_used, input_hash, and generated_at on success', async () => {
        const result = await generateSummary(
            db,
            {},
            TARGET,
            deps(async () => ({ok: true, text: 'A clean git-based narrative.', model: 'test-model'})),
        );
        expect(result.ok).toBe(true);

        const stored = getSummaryByTarget(db, TARGET);
        expect(stored).not.toBeNull();
        expect(stored!.summary_text).toBe('A clean git-based narrative.');
        expect(stored!.model_used).toBe('test-model');
        expect(stored!.input_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(stored!.generated_at).toBe(NOW.toISOString());
        expect(stored!.regenerated_count).toBe(0);
        expect(stored!.is_stale).toBe(0);
    });

    it('increments the counter and passes the focus into the prompt on regeneration', async () => {
        const prompts: string[] = [];
        const capture =
            (text: string) =>
            async (prompt: string): Promise<SummaryModelResult> => {
                prompts.push(prompt);
                return {ok: true, text, model: 'test-model'};
            };

        await generateSummary(db, {}, TARGET, deps(capture('first pass narrative')));
        const second = await generateSummary(
            db,
            {},
            TARGET,
            deps(capture('cost-focused narrative'), {focus: 'cost'}),
        );

        expect(second.ok).toBe(true);
        const stored = getSummaryByTarget(db, TARGET);
        expect(stored!.regenerated_count).toBe(1);
        expect(stored!.summary_text).toBe('cost-focused narrative');
        // The focus instruction reached the prompt on the regeneration only.
        expect(prompts[0]).not.toMatch(/requested focus for this regeneration: cost/);
        expect(prompts[1]).toMatch(/requested focus for this regeneration: cost/);
    });

    it('leaves no partial row and reports retryable when the model is down', async () => {
        const result = await generateSummary(
            db,
            {},
            TARGET,
            deps(async () => ({
                ok: false,
                error: 'endpoint unreachable',
                retryable: true,
                model: 'test-model',
            })),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.retryable).toBe(true);
        // Nothing was written.
        expect(getSummaryByTarget(db, TARGET)).toBeNull();
    });

    it('rejects fabricated direct-usage language without storing a row', async () => {
        const result = await generateSummary(
            db,
            {},
            TARGET,
            // git_estimate period — "acceptance rate" is forbidden fabrication.
            deps(async () => ({
                ok: true,
                text: 'The team hit a 92% acceptance rate this month.',
                model: 'test-model',
            })),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/fabricated direct-usage language/);
        expect(getSummaryByTarget(db, TARGET)).toBeNull();
    });

    it('regenerates an existing row in place (same id, updated text)', async () => {
        await generateSummary(
            db,
            {},
            TARGET,
            deps(async () => ({ok: true, text: 'v1', model: 'm'})),
        );
        await generateSummary(
            db,
            {},
            TARGET,
            deps(async () => ({ok: true, text: 'v2', model: 'm'})),
        );
        const rows = db.prepare('SELECT COUNT(*) AS n FROM summaries').get() as {n: number};
        expect(rows.n).toBe(1);
        expect(getSummaryByTarget(db, TARGET)!.summary_text).toBe('v2');
    });
});
