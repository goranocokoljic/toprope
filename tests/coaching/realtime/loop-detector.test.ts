import {describe, it, expect} from 'vitest';
import {LoopDetector, jaccard, tokenSet} from '../../../src/coaching/realtime/loop-detector';

describe('loop detector — token-set similarity (Task 5.6)', () => {
    it('tokenSet lowercases, splits on punctuation, and de-duplicates', () => {
        expect([...tokenSet('Fix the BUG, fix the bug!')].sort()).toEqual(['bug', 'fix', 'the']);
    });

    it('jaccard is 1 for identical token sets and 0 for disjoint', () => {
        expect(jaccard(tokenSet('add a retry to the client'), tokenSet('add a retry to the client'))).toBe(1);
        expect(jaccard(tokenSet('alpha beta'), tokenSet('gamma delta'))).toBe(0);
    });

    it('jaccard treats an empty prompt as no signal (0), not a match', () => {
        expect(jaccard(tokenSet(''), tokenSet(''))).toBe(0);
        expect(jaccard(tokenSet('hello world'), tokenSet(''))).toBe(0);
    });

    it('fires only once the Nth similar prompt arrives (>= minSimilar)', () => {
        const detector = new LoopDetector({similarityThreshold: 0.6, minSimilar: 3, windowSize: 10});
        const prompt = 'why does the login request keep failing intermittently';
        expect(detector.observe(prompt)).toBeNull(); // 1st
        expect(detector.observe(prompt)).toBeNull(); // 2nd — only 1 prior match
        const loop = detector.observe(prompt); // 3rd — 2 prior matches → loop of 3
        expect(loop).not.toBeNull();
        expect(loop?.similarPromptCount).toBe(3);
    });

    it('does not fire for dissimilar prompts below the threshold', () => {
        const detector = new LoopDetector({similarityThreshold: 0.6, minSimilar: 2, windowSize: 10});
        expect(detector.observe('refactor the billing module')).toBeNull();
        expect(detector.observe('write a haiku about autumn leaves')).toBeNull();
        expect(detector.observe('configure the kubernetes ingress')).toBeNull();
    });

    it('counts only prompts that meet the similarity threshold', () => {
        const detector = new LoopDetector({similarityThreshold: 0.5, minSimilar: 2, windowSize: 10});
        detector.observe('the database connection pool is exhausted under load');
        // Near-identical → similar; fires a loop of 2.
        const loop = detector.observe('the database connection pool is exhausted under heavy load');
        expect(loop?.similarPromptCount).toBe(2);
    });

    it('respects the rolling window: old prompts fall out and stop counting', () => {
        const detector = new LoopDetector({similarityThreshold: 0.6, minSimilar: 2, windowSize: 2});
        detector.observe('same repeated question here'); // window: [A]
        detector.observe('totally unrelated topic one'); // window: [A, B]
        detector.observe('another unrelated topic two'); // window: [B, C] — A evicted
        // The original A is gone from the window, so a 2nd A is not a loop.
        expect(detector.observe('same repeated question here')).toBeNull();
    });
});
