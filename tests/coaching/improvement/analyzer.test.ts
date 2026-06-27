import {describe, it, expect} from 'vitest';
import {
    LocalHeuristicImprovementAnalyzer,
    LOCAL_DEFAULT_IMPROVEMENT_MODEL,
    type SessionAnalysisInput,
} from '../../../src/coaching/improvement/analyzer';
import type {LoopEventMeta} from '../../../src/coaching/realtime/types';
import {isImprovementCategory} from '../../../src/coaching/improvement/types';

const SESSION = 'sess-imp';

function loop(similarPromptCount: number): LoopEventMeta {
    return {sessionId: SESSION, detectedAt: '2026-06-15T00:00:00.000Z', similarPromptCount};
}

function input(plaintext: string, loopEvents: LoopEventMeta[] = []): SessionAnalysisInput {
    return {sessionId: SESSION, plaintext, loopEvents};
}

describe('LocalHeuristicImprovementAnalyzer (Task 6.5)', () => {
    const analyzer = new LocalHeuristicImprovementAnalyzer();

    it('is a LOCAL analyser with the default model name', () => {
        expect(analyzer.location).toBe('local');
        expect(analyzer.model).toBe(LOCAL_DEFAULT_IMPROVEMENT_MODEL);
    });

    it('produces suggestions grounded in concrete session numbers (specific, not generic)', () => {
        // 3 prompts, 2 of them brief (< 5 words), no error/code/path context.
        const res = analyzer.analyze(input('prompt: fix it\nprompt: now\nprompt: please refactor the whole module entirely'));
        const text = res.suggestions.map((s) => s.suggestion).join(' ');
        // Names the actual brief count AND the total prompt count — the specificity guarantee.
        expect(text).toContain('2 of your 3');
        // Every suggestion references a concrete number from THIS conversation.
        for (const s of res.suggestions) {
            expect(s.suggestion).toMatch(/\d/);
            expect(isImprovementCategory(s.category)).toBe(true);
        }
    });

    it('emits an efficiency suggestion for >=2 brief prompts, naming only real costs (no "0 repeated tries")', () => {
        // 2 brief prompts, zero loops → efficiency fires on briefPromptCount>=2.
        const res = analyzer.analyze(input('prompt: fix\nprompt: now\nprompt: please refactor the whole module entirely'));
        const efficiency = res.suggestions.find((s) => s.category === 'efficiency');
        expect(efficiency).toBeDefined();
        expect(efficiency!.suggestion).toContain('2 brief prompts');
        // With zero loops the text must NOT name a zero-count "repeated tries" term.
        expect(efficiency!.suggestion).not.toMatch(/\b0 repeated/);
        expect(efficiency!.suggestion).not.toContain('repeated tr');
    });

    it('flags missing context with the prompt count when no error/code/path is present', () => {
        const res = analyzer.analyze(input('prompt: how do I make this faster and more correct overall'));
        const context = res.suggestions.find((s) => s.category === 'context');
        expect(context).toBeDefined();
        expect(context!.suggestion).toContain('1 prompt');
    });

    it('does NOT flag context when the conversation includes an error, code, or file path', () => {
        const res = analyzer.analyze(input('prompt: I hit a TypeError in src/billing.ts:42, here is the stack trace and code'));
        expect(res.suggestions.find((s) => s.category === 'context')).toBeUndefined();
    });

    it('flags repeated-prompt loops with the loop and retry counts', () => {
        const res = analyzer.analyze(input('prompt: a well specified request with plenty of words here', [loop(2), loop(3)]));
        const iteration = res.suggestions.find((s) => s.category === 'iteration');
        expect(iteration).toBeDefined();
        // 2 loops, ~5 total repetitions.
        expect(iteration!.suggestion).toContain('2 repeated-prompt loop');
        expect(iteration!.suggestion).toContain('5');
    });

    it('gives a specific next-level suggestion for an already-strong conversation (no weak signals)', () => {
        // Specific prompt, has context (file path), no loops, not brief.
        const res = analyzer.analyze(input('prompt: refactor the retry logic in src/net/client.ts to add a backoff cap'));
        expect(res.suggestions).toHaveLength(1);
        expect(res.suggestions[0].category).toBe('next_level');
        // Still specific: grounded in the real prompt count, not a generic "looks good".
        expect(res.suggestions[0].suggestion).toContain('1 prompt');
    });

    it('always returns at least one suggestion, even for empty plaintext', () => {
        const res = analyzer.analyze(input(''));
        expect(res.suggestions.length).toBeGreaterThanOrEqual(1);
        expect(res.reviewText.length).toBeGreaterThan(0);
    });

    it('never echoes the raw prompt text back in the review or suggestions', () => {
        const secret = 'SUPERSECRETMARKER deploy creds in src/secret.ts';
        const res = analyzer.analyze(input(`prompt: ${secret}`, [loop(2)]));
        expect(res.reviewText).not.toContain('SUPERSECRETMARKER');
        for (const s of res.suggestions) {
            expect(s.suggestion).not.toContain('SUPERSECRETMARKER');
        }
    });

    it('emits a within-developer narrative that compares to no one else', () => {
        const res = analyzer.analyze(input('prompt: x'));
        expect(res.reviewText.toLowerCase()).toContain('your own work');
        expect(res.reviewText.toLowerCase()).not.toMatch(/than (other|your peers|the team)/);
    });
});
