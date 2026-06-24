import {describe, it, expect} from 'vitest';
import {PRACTICE_METRICS, PRACTICE_METRIC_LABELS} from '../../src/practices/metrics';
import {relatedPracticesIntro} from '../../src/practices/tone';

// The judgemental register the surface must never drift into — a verdict on the
// developer's number rather than an offer of help. Kept local to the test (not
// exported from the module) since nothing in production needs it; the test guards
// the actual production copy against it, so a future edit to the template that
// scolds fails here.
const SCOLDING_WORDS = ['bad', 'poor', 'worst', 'terrible', 'wrong', 'fail', 'problem', 'fault', 'blame', 'too high', 'too low'];

describe('contextual-display tone (Task 6.2.7 / #162)', () => {
    it('the intro is the reviewed copy, naming the metric as optional help', () => {
        // Assert the exact production string per metric — a regression in the template
        // (or a label) fails loudly rather than silently.
        for (const metric of PRACTICE_METRICS) {
            expect(relatedPracticesIntro(metric)).toBe(
                `Here are a few practices that may help with ${PRACTICE_METRIC_LABELS[metric]}.`,
            );
        }
        // The "may help" framing is the offer, not a verdict.
        expect(relatedPracticesIntro('churn')).toContain('may help');
    });

    it('no metric intro contains a scolding word (encouraging, never judgemental)', () => {
        for (const metric of PRACTICE_METRICS) {
            const intro = relatedPracticesIntro(metric).toLowerCase();
            for (const word of SCOLDING_WORDS) {
                expect(intro).not.toContain(word);
            }
        }
    });
});
