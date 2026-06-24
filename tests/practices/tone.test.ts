import {describe, it, expect} from 'vitest';
import {PRACTICE_METRICS} from '../../src/practices/metrics';
import {relatedPracticesIntro, isEncouraging, SCOLDING_WORDS} from '../../src/practices/tone';

describe('contextual-display tone (Task 6.2.7 / #162)', () => {
    it('every metric intro is framed as optional help and names the metric', () => {
        for (const metric of PRACTICE_METRICS) {
            const intro = relatedPracticesIntro(metric);
            // "may help" — an offer, not a verdict.
            expect(intro.toLowerCase()).toContain('may help');
            expect(intro.toLowerCase()).toContain('practices');
        }
    });

    it('no metric intro contains a scolding word (encouraging, never judgemental)', () => {
        for (const metric of PRACTICE_METRICS) {
            const intro = relatedPracticesIntro(metric);
            for (const word of SCOLDING_WORDS) {
                expect(intro.toLowerCase()).not.toContain(word);
            }
            expect(isEncouraging(intro)).toBe(true);
        }
    });

    it('isEncouraging flags copy that scolds', () => {
        // The exact register the surface must avoid — a judgement on the number.
        expect(isEncouraging('Your churn is bad — you should have caught this.')).toBe(false);
        expect(isEncouraging('This is a problem with your code.')).toBe(false);
        // ...and accepts the encouraging register.
        expect(isEncouraging('Here is a practice that may help.')).toBe(true);
    });

    it('isEncouraging is case-insensitive', () => {
        expect(isEncouraging('Your churn is BAD')).toBe(false);
    });
});
