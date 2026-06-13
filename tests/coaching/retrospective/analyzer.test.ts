import {describe, it, expect} from 'vitest';
import {LocalHeuristicAnalyzer, LOCAL_DEFAULT_MODEL, type SessionAnalysisInput} from '../../../src/coaching/retrospective/analyzer';

const SESSION = 'sess-1';

function input(plaintext: string, loops: SessionAnalysisInput['loopEvents'] = []): SessionAnalysisInput {
    return {sessionId: SESSION, plaintext, loopEvents: loops};
}

describe('LocalHeuristicAnalyzer (Task 5.7)', () => {
    it('reports as a local analyser with the default model name', () => {
        const a = new LocalHeuristicAnalyzer();
        expect(a.location).toBe('local');
        expect(a.model).toBe(LOCAL_DEFAULT_MODEL);
    });

    it('honors a custom local model name (e.g. an Ollama model)', () => {
        const a = new LocalHeuristicAnalyzer('ollama:llama3');
        expect(a.location).toBe('local');
        expect(a.model).toBe('ollama:llama3');
    });

    it('produces a narrative + highlights and never compares to peers', () => {
        const a = new LocalHeuristicAnalyzer();
        const result = a.analyze(
            input('prompt: please refactor the billing module to extract the tax calculation into a helper'),
        );
        expect(result.retrospectiveText.length).toBeGreaterThan(0);
        expect(result.highlights.worked.length).toBeGreaterThan(0);
        // Within-developer framing: no comparative language about other people.
        const text = (result.retrospectiveText + ' ' + JSON.stringify(result.highlights)).toLowerCase();
        for (const banned of ['peer', 'other developers', 'team average', 'compared to', 'than your colleagues', 'rank']) {
            expect(text).not.toContain(banned);
        }
    });

    it('flags brief/underspecified prompts in the improve highlights', () => {
        const a = new LocalHeuristicAnalyzer();
        const result = a.analyze(input('prompt: fix it\nprompt: still broken\nprompt: help'));
        expect(result.highlights.improve.join(' ')).toMatch(/brief/i);
    });

    it('ties loop metadata (Task 5.6) into the improve highlights', () => {
        const a = new LocalHeuristicAnalyzer();
        const result = a.analyze(
            input('prompt: write a function that parses the config file and returns a typed object', [
                {sessionId: SESSION, detectedAt: '2026-06-15T00:00:00.000Z', similarPromptCount: 3},
                {sessionId: SESSION, detectedAt: '2026-06-15T00:01:00.000Z', similarPromptCount: 2},
            ]),
        );
        expect(result.highlights.improve.join(' ')).toMatch(/loop/i);
    });

    it('rewards prompts that include concrete context (error/code)', () => {
        const a = new LocalHeuristicAnalyzer();
        const result = a.analyze(
            input('prompt: got TypeError: cannot read property foo of undefined in src/app.ts:42 — how do I fix this?'),
        );
        expect(result.highlights.worked.join(' ')).toMatch(/context/i);
    });

    it('suggests adding context when none is present', () => {
        const a = new LocalHeuristicAnalyzer();
        const result = a.analyze(input('prompt: make the thing work the way I described earlier please thanks'));
        expect(result.highlights.improve.join(' ')).toMatch(/error|code|path|context/i);
    });

    it('always offers at least one within-developer positive', () => {
        const a = new LocalHeuristicAnalyzer();
        // A maximally "bad" session (brief, no context, looping) should still get a win.
        const result = a.analyze(
            input('prompt: x\nprompt: y', [{sessionId: SESSION, detectedAt: '2026-06-15T00:00:00.000Z', similarPromptCount: 5}]),
        );
        expect(result.highlights.worked.length).toBeGreaterThan(0);
    });

    it('answers a follow-up grounded in the session signals', () => {
        const a = new LocalHeuristicAnalyzer();
        const session = input('prompt: fix\nprompt: fix again', [
            {sessionId: SESSION, detectedAt: '2026-06-15T00:00:00.000Z', similarPromptCount: 4},
        ]);
        const retro = a.analyze(session);
        const answer = a.followUp(session, retro.retrospectiveText, 'why was the looping flagged?');
        expect(answer).toMatch(/loop/i);
    });
});
