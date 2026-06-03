import {describe, it, expect, vi} from 'vitest';
import {
    buildSummaryPrompt,
    findFabricatedUsageLanguage,
    assertNoFabricatedUsageLanguage,
    isGitOnly,
    directUsageSubstantiated,
    FABRICATED_USAGE_TERMS,
    LEVEL_BRIEFS,
    type PromptOptions,
} from '../../src/summaries/prompts';
import {
    buildSummaryInput,
    type AggregateMetrics,
    type SummaryInputPayload,
} from '../../src/summaries/input-builder';
import {SummaryModelClient, type ResolvedSummaryModel} from '../../src/summaries/model-client';
import type {SummaryLevel} from '../../src/summaries/model-client';
import type {MaturityBasis} from '../../src/aggregation/team-period';

/** Git-only launch metrics (the Phase 3 default: tool fields null, git_estimate basis). */
function metrics(overrides: Partial<AggregateMetrics> = {}): AggregateMetrics {
    return {
        developer_count: 6,
        active_developer_count: 5,
        total_commits: 142,
        total_prs_merged: 23,
        avg_code_churn: 0.11,
        avg_ai_signature_score: 68,
        subscription_cost: 180,
        cost_per_pr: 7.83,
        ai_maturity_score: 56,
        ai_maturity_basis: 'git_estimate',
        data_quality: 'medium',
        ...overrides,
    };
}

function payloadFor(
    level: SummaryLevel,
    opts: {prior?: AggregateMetrics | null; basis?: MaturityBasis} = {},
): SummaryInputPayload {
    const current = metrics(opts.basis ? {ai_maturity_basis: opts.basis} : {});
    return buildSummaryInput({
        level,
        periodLabel: level === 'weekly' ? '2026-W21' : level === 'monthly' ? '2026-05' : level === 'quarterly' ? '2026-Q2' : '2026',
        start: '2026-05-19',
        end: '2026-05-25',
        scope: {type: 'team', name: 'backend'},
        current,
        prior: opts.prior === undefined ? metrics({total_commits: 120}) : opts.prior,
    });
}

const ALL_LEVELS: SummaryLevel[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

/**
 * A mocked Ollama model whose response text we control, so adversarial assertions
 * are stable (no real model). Returns the canned `response` for any prompt and
 * captures the prompt actually sent, so a test can prove the generation came from
 * the real `buildSummaryPrompt` output rather than a bare string literal.
 */
function mockModel(response: string): {client: SummaryModelClient; sentPrompt: () => string} {
    let captured = '';
    const fetchImpl = vi.fn(async (_url: string, init?: {body?: string}) => {
        const body = init?.body ? (JSON.parse(init.body) as {prompt?: string}) : {};
        captured = body.prompt ?? '';
        return {
            ok: true,
            status: 200,
            json: async () => ({response}),
            text: async () => JSON.stringify({response}),
        } as Response;
    }) as unknown as typeof fetch;
    const config: ResolvedSummaryModel = {
        type: 'ollama',
        endpoint: 'http://localhost:11434',
        model_name: 'llama3.1:8b',
    };
    return {
        client: new SummaryModelClient(config, {fetchImpl, logger: {warn: () => undefined}}),
        sentPrompt: () => captured,
    };
}

describe('LEVEL_BRIEFS', () => {
    it('defines a distinct brief for every level', () => {
        for (const level of ALL_LEVELS) {
            expect(LEVEL_BRIEFS[level]).toBeDefined();
            expect(LEVEL_BRIEFS[level].audience.length).toBeGreaterThan(0);
            expect(LEVEL_BRIEFS[level].targetLength.length).toBeGreaterThan(0);
        }
    });

    it('scales target depth with the level (weekly shortest, yearly longest)', () => {
        // Each level names its own audience, so the four prompts are genuinely
        // different rather than one template reused.
        const audiences = ALL_LEVELS.map((l) => LEVEL_BRIEFS[l].audience);
        expect(new Set(audiences).size).toBe(4);
        expect(LEVEL_BRIEFS.weekly.targetLength).toMatch(/two short paragraphs/);
        expect(LEVEL_BRIEFS.monthly.targetLength).toMatch(/one page/);
        expect(LEVEL_BRIEFS.quarterly.targetLength).toMatch(/two to three pages/);
        expect(LEVEL_BRIEFS.yearly.targetLength).toMatch(/full narrative/);
    });
});

describe('buildSummaryPrompt — structure and per-level depth', () => {
    it('produces a distinct prompt per level, naming the audience and target length', () => {
        for (const level of ALL_LEVELS) {
            const prompt = buildSummaryPrompt(payloadFor(level));
            expect(prompt).toContain(level.toUpperCase());
            expect(prompt).toContain(LEVEL_BRIEFS[level].audience);
            expect(prompt).toContain(LEVEL_BRIEFS[level].targetLength);
        }
    });

    it('embeds the numbers-only input block', () => {
        const prompt = buildSummaryPrompt(payloadFor('weekly'));
        expect(prompt).toContain('Period: 2026-W21');
        expect(prompt).toContain('Total commits: 142');
        expect(prompt).toContain('Input metrics (the only data you may use):');
    });

    it('injects a regeneration focus when provided, without licensing new metrics', () => {
        const options: PromptOptions = {focus: 'cost efficiency'};
        const prompt = buildSummaryPrompt(payloadFor('monthly'), options);
        expect(prompt).toContain('cost efficiency');
        expect(prompt).toMatch(/do not introduce any metric that is not in the input/i);
    });

    it('ignores an empty/whitespace focus', () => {
        const prompt = buildSummaryPrompt(payloadFor('monthly'), {focus: '   '});
        expect(prompt).not.toMatch(/Additional requested focus/i);
    });
});

describe('buildSummaryPrompt — tier-aware preamble (git-only)', () => {
    const prompt = buildSummaryPrompt(payloadFor('weekly'));

    it('states the data basis (git-based) at least once', () => {
        expect(prompt).toContain('git analysis + expense data; no direct tool usage');
        expect(prompt).toMatch(/CARRY THE DATA BASIS/i);
    });

    it('declares direct tool usage is not connected', () => {
        expect(prompt).toMatch(/Direct tool-usage data is NOT connected/i);
    });

    it('explicitly forbids the direct-usage vocabulary', () => {
        expect(prompt).toMatch(/MUST NOT use.*acceptance rate.*interactions.*suggestions accepted/is);
    });

    it('instructs git-signal vocabulary instead', () => {
        expect(prompt).toMatch(/commit activity/i);
        expect(prompt).toMatch(/merged PRs/i);
        expect(prompt).toMatch(/estimated AI-assistance signal/i);
    });

    it('forbids individual judgement while allowing neutral factual mention', () => {
        expect(prompt).toMatch(/NEVER JUDGEMENT OF INDIVIDUALS/i);
        expect(prompt).toMatch(/worth a check-in/i);
    });

    it('mandates the concise analytical voice', () => {
        expect(prompt).toMatch(/concise, analytical/i);
    });
});

describe('buildSummaryPrompt — deltas vs first period', () => {
    it('instructs "first period — no prior comparison" and carries the note into the input block', () => {
        const firstPeriod = payloadFor('weekly', {prior: null});
        const prompt = buildSummaryPrompt(firstPeriod);
        expect(prompt).toMatch(/first period — no prior comparison/i);
        expect(prompt).toContain('first period for this scope — no prior-period comparison available');
    });

    it('does not show a prior-comparison note when a prior period exists', () => {
        const withPrior = payloadFor('weekly');
        const prompt = buildSummaryPrompt(withPrior);
        expect(prompt).not.toContain('first period for this scope — no prior-period comparison available');
        // The delta is rendered in the input block instead.
        expect(prompt).toMatch(/vs prior/);
    });
});

describe('buildSummaryPrompt — only the measured tier relaxes the ban', () => {
    it('permits direct-usage description when the period is measured', () => {
        const prompt = buildSummaryPrompt(payloadFor('monthly', {basis: 'measured'}));
        expect(prompt).not.toMatch(/Direct tool-usage data is NOT connected/i);
        expect(prompt).not.toMatch(/MUST NOT use/);
        expect(prompt).toMatch(/you may describe them as measured/i);
    });

    it('still bans direct-usage language for the mixed tier (partial usage, no per-tool fields)', () => {
        const prompt = buildSummaryPrompt(payloadFor('monthly', {basis: 'mixed'}));
        expect(prompt).toMatch(/only PARTIALLY connected/i);
        expect(prompt).toMatch(/MUST NOT use/);
        expect(prompt).not.toMatch(/you may describe them as measured/i);
    });
});

describe('isGitOnly / directUsageSubstantiated', () => {
    it('isGitOnly is true only for the git_estimate launch basis', () => {
        expect(isGitOnly(payloadFor('weekly', {basis: 'git_estimate'}))).toBe(true);
        expect(isGitOnly(payloadFor('weekly', {basis: 'mixed'}))).toBe(false);
        expect(isGitOnly(payloadFor('weekly', {basis: 'measured'}))).toBe(false);
    });

    it('directUsageSubstantiated is true only for the fully-measured basis', () => {
        expect(directUsageSubstantiated(payloadFor('weekly', {basis: 'git_estimate'}))).toBe(false);
        expect(directUsageSubstantiated(payloadFor('weekly', {basis: 'mixed'}))).toBe(false);
        expect(directUsageSubstantiated(payloadFor('weekly', {basis: 'measured'}))).toBe(true);
    });
});

describe('findFabricatedUsageLanguage — output guard', () => {
    const gitOnly = payloadFor('weekly', {basis: 'git_estimate'});

    it('returns empty for a clean git-signal narrative', () => {
        const clean =
            'The backend team had a strong week: commit activity rose 18% and 23 PRs merged. Code churn dropped to ' +
            '11%, and the estimated AI-assistance signal ticked up. These figures are based on git activity and ' +
            "expense data, since direct tool usage isn't yet connected.";
        expect(findFabricatedUsageLanguage(clean, gitOnly)).toEqual([]);
    });

    it('flags each forbidden direct-usage term (case-insensitive)', () => {
        const bad =
            'Copilot acceptance rate climbed to 34%, with thousands of Interactions and many Suggestions Accepted.';
        const found = findFabricatedUsageLanguage(bad, gitOnly);
        expect(found).toContain('acceptance rate');
        expect(found).toContain('interactions');
        expect(found).toContain('suggestions accepted');
    });

    it('matches whole words only — does not trip on benign substrings', () => {
        // "interaction" appears inside no forbidden whole word here; "active usage"
        // is forbidden but "active developers" is not.
        const benign = 'Five active developers contributed; the interactional dynamics are out of scope.';
        expect(findFabricatedUsageLanguage(benign, gitOnly)).toEqual([]);
    });

    it('matches multi-word phrases across line wraps and irregular whitespace', () => {
        // A multi-page narrative wraps mid-phrase; a literal-single-space matcher
        // would miss these. The guard must still catch them.
        const wrapped = 'Copilot performance was strong: the acceptance\nrate climbed all quarter.';
        expect(findFabricatedUsageLanguage(wrapped, gitOnly)).toContain('acceptance rate');
        const doubleSpaced = 'There were many  suggestions  accepted this month.';
        expect(findFabricatedUsageLanguage(doubleSpaced, gitOnly)).toContain('suggestions accepted');
        const nbspText = `The acceptance${String.fromCharCode(0x00a0)}rate was high.`;
        expect(findFabricatedUsageLanguage(nbspText, gitOnly)).toContain('acceptance rate');
    });

    it('still guards the mixed tier — partial usage does not substantiate the terms', () => {
        const mixed = payloadFor('weekly', {basis: 'mixed'});
        const bad = 'The acceptance rate was 34% across many interactions.';
        const found = findFabricatedUsageLanguage(bad, mixed);
        expect(found).toContain('acceptance rate');
        expect(found).toContain('interactions');
    });

    it('permits the same terms only when the period is fully measured (fields exist)', () => {
        const measured = payloadFor('weekly', {basis: 'measured'});
        const bad = 'The acceptance rate was 34% across many interactions.';
        expect(findFabricatedUsageLanguage(bad, measured)).toEqual([]);
    });

    it('every catalogued term is detectable in isolation', () => {
        for (const term of FABRICATED_USAGE_TERMS) {
            expect(findFabricatedUsageLanguage(`prefix ${term} suffix`, gitOnly)).toContain(term);
        }
    });
});

describe('assertNoFabricatedUsageLanguage', () => {
    const gitOnly = payloadFor('weekly', {basis: 'git_estimate'});

    it('throws naming the offending terms for git-only violations', () => {
        expect(() =>
            assertNoFabricatedUsageLanguage('acceptance rate was high', gitOnly),
        ).toThrowError(/acceptance rate/);
    });

    it('does not throw for clean text', () => {
        expect(() =>
            assertNoFabricatedUsageLanguage('commit activity rose; merged PRs up.', gitOnly),
        ).not.toThrow();
    });
});

/**
 * ADVERSARIAL TEST (required by the issue): drive the full prompt → model → guard
 * path with a *mocked* model so the assertion is deterministic. A well-behaved
 * model produces clean git-signal prose; the guard confirms it carries NONE of the
 * forbidden direct-usage vocabulary. A misbehaving model is caught by the guard —
 * which is exactly the enforcement the generator (Task 3.9) will rely on.
 */
describe('adversarial: full prompt → mocked model → guard', () => {
    it('a compliant git-only generation passes the guard and states the basis', async () => {
        const payload = payloadFor('weekly', {basis: 'git_estimate'});
        const compliant =
            'The backend team stayed active this week: 5 of 6 developers committed, commit activity rose 18% and 23 ' +
            'PRs merged. Code churn eased to 11% and the estimated AI-assistance signal edged up. One developer was ' +
            'inactive — worth a check-in. These figures are based on git activity and expense data, since direct tool ' +
            "usage isn't yet connected.";
        const {client, sentPrompt} = mockModel(compliant);

        const result = await client.generate(buildSummaryPrompt(payload));
        // The generation must have come from the real prompt builder — confirm the
        // tier ban clause actually reached the model, not just a hand-written string.
        expect(sentPrompt()).toMatch(/MUST NOT use/);
        expect(sentPrompt()).toContain('git analysis + expense data; no direct tool usage');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(findFabricatedUsageLanguage(result.text, payload)).toEqual([]);
            expect(result.text.toLowerCase()).toContain('git activity');
        }
    });

    it('a misbehaving git-only generation is caught by the guard', async () => {
        const payload = payloadFor('weekly', {basis: 'git_estimate'});
        const offending =
            'Copilot performed well: the acceptance rate hit 41% across thousands of interactions, with many ' +
            'suggestions accepted.';
        const {client} = mockModel(offending);

        const result = await client.generate(buildSummaryPrompt(payload));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(() => assertNoFabricatedUsageLanguage(result.text, payload)).toThrowError(
                /fabricated direct-usage language/i,
            );
        }
    });
});
