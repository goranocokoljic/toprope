import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {generateSummary} from '../../src/summaries/generator';
import {
    checkSummaryStaleness,
    markStaleSummariesForRecompute,
} from '../../src/summaries/staleness';
import {getSummaryByTarget} from '../../src/summaries/store';
import {runAggregationForPeriod} from '../../src/aggregation/scheduler';
import type {SummaryTarget} from '../../src/summaries/target';
import type {SummaryModelResult} from '../../src/summaries/model-client';
import {makeDb, addDeveloper, addGitSnapshot} from '../aggregation/helpers';

const MONTHLY: SummaryTarget = {
    level: 'monthly',
    period: '2026-05',
    scope: {type: 'team', name: 'backend'},
};

/** Generate a summary with a canned model response so tests don't hit a server. */
async function generate(db: Database.Database, target: SummaryTarget, text = 'narrative'): Promise<void> {
    const result = await generateSummary(db, {}, target, {
        createClient: () =>
            ({
                generate: async (): Promise<SummaryModelResult> => ({ok: true, text, model: 'm'}),
            }) as never,
    });
    if (!result.ok) throw new Error(`fixture generate failed: ${result.error}`);
}

describe('checkSummaryStaleness', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2});
    });
    afterEach(() => db.close());

    it('returns false and leaves the flag clear when the input is unchanged', async () => {
        await generate(db, MONTHLY);
        const record = getSummaryByTarget(db, MONTHLY)!;
        expect(checkSummaryStaleness(db, record)).toBe(false);
        expect(getSummaryByTarget(db, MONTHLY)!.is_stale).toBe(0);
    });

    it('marks is_stale = 1 when the underlying aggregate changed', async () => {
        await generate(db, MONTHLY);
        // Late-arriving data inside the same month.
        addGitSnapshot(db, 'dev-1', '2026-05-20', {commits: 7, prs_merged: 3});

        const record = getSummaryByTarget(db, MONTHLY)!;
        expect(checkSummaryStaleness(db, record)).toBe(true);
        expect(getSummaryByTarget(db, MONTHLY)!.is_stale).toBe(1);
    });

    it('clears staleness on a fresh generation (new matching input_hash)', async () => {
        await generate(db, MONTHLY);
        addGitSnapshot(db, 'dev-1', '2026-05-20', {commits: 7, prs_merged: 3});
        checkSummaryStaleness(db, getSummaryByTarget(db, MONTHLY)!);
        expect(getSummaryByTarget(db, MONTHLY)!.is_stale).toBe(1);

        // Regenerate against the new data — the write resets is_stale.
        await generate(db, MONTHLY, 'refreshed narrative');
        expect(getSummaryByTarget(db, MONTHLY)!.is_stale).toBe(0);
        // And the freshly built input now matches again.
        expect(checkSummaryStaleness(db, getSummaryByTarget(db, MONTHLY)!)).toBe(false);
    });
});

describe('markStaleSummariesForRecompute', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
    });
    afterEach(() => db.close());

    it('maps a weekly week_start key to the ISO week label and marks affected summaries', async () => {
        // 2026-05-18 is the Monday of ISO week 2026-W21.
        addGitSnapshot(db, 'dev-1', '2026-05-19', {commits: 5, prs_merged: 2});
        const weekly: SummaryTarget = {
            level: 'weekly',
            period: '2026-W21',
            scope: {type: 'team', name: 'backend'},
        };
        await generate(db, weekly);

        addGitSnapshot(db, 'dev-1', '2026-05-20', {commits: 4, prs_merged: 1});
        const marked = markStaleSummariesForRecompute(db, 'weekly', '2026-05-18');
        expect(marked).toBe(1);
        expect(getSummaryByTarget(db, weekly)!.is_stale).toBe(1);
    });

    it('is invoked by the aggregation recompute path and flags a changed period', async () => {
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2});
        await generate(db, MONTHLY);

        // Mutate snapshots, then recompute the month through the shared path.
        addGitSnapshot(db, 'dev-1', '2026-05-21', {commits: 9, prs_merged: 4});
        runAggregationForPeriod(db, 'monthly', '2026-05');

        expect(getSummaryByTarget(db, MONTHLY)!.is_stale).toBe(1);
    });

    it('returns 0 when no summary exists for the recomputed period', () => {
        expect(markStaleSummariesForRecompute(db, 'monthly', '2026-05')).toBe(0);
    });
});
