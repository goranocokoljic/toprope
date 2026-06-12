import {describe, it, expect} from 'vitest';
import {RealtimeCoach, type NudgeSettings} from '../../../src/coaching/realtime/coach';

const SECRET = 'SUPERSECRETMARKER refactor the billing code please';

function coach(settings: Partial<NudgeSettings> = {}, sessionId = 'sess-1'): RealtimeCoach {
    return new RealtimeCoach({
        settings: {enabled: true, frequency: 'high', dismissible: true, ...settings},
        sessionId,
        loop: {similarityThreshold: 0.6, minSimilar: 3, windowSize: 10},
    });
}

describe('RealtimeCoach — settings adherence + privacy (Task 5.6)', () => {
    it('is fully inert when nudges are disabled', () => {
        const c = coach({enabled: false});
        const r = c.observePrompt('fix this'); // would normally be a short_prompt nudge
        expect(r.nudges).toEqual([]);
        expect(r.nudgeEvents).toEqual([]);
        expect(r.loopEvent).toBeNull();
    });

    it('delivers a structural nudge when enabled (high frequency = every prompt)', () => {
        const c = coach({frequency: 'high'});
        const r = c.observePrompt('fix this');
        expect(r.nudges.map((n) => n.type)).toContain('short_prompt');
        expect(r.nudgeEvents).toHaveLength(r.nudges.length);
    });

    it('stamps the dismissible flag from settings onto delivered nudges', () => {
        const r = coach({dismissible: false}).observePrompt('fix this');
        expect(r.nudges.every((n) => n.dismissible === false)).toBe(true);
    });

    it('throttles nudge delivery by frequency (low spaces them out)', () => {
        const c = coach({frequency: 'low'}); // cooldown 5
        const short = 'fix this';
        const delivered: number[] = [];
        for (let i = 0; i < 8; i++) {
            const r = c.observePrompt(short);
            delivered.push(r.nudges.length);
        }
        // First prompt delivers; the next several are throttled until the cooldown elapses.
        expect(delivered[0]).toBeGreaterThan(0);
        expect(delivered.slice(1, 5).every((n) => n === 0)).toBe(true);
        // After 5 quiet observations a nudge is delivered again.
        expect(delivered[6]).toBeGreaterThan(0);
    });

    it('detects a loop and surfaces a repeated_prompt nudge + loop metadata', () => {
        const c = coach({frequency: 'high'});
        const p = 'why does the deploy keep timing out on the staging cluster';
        c.observePrompt(p);
        c.observePrompt(p);
        const r = c.observePrompt(p); // 3rd → loop
        expect(r.loop?.similarPromptCount).toBe(3);
        expect(r.loopEvent?.similarPromptCount).toBe(3);
        expect(r.nudges.map((n) => n.type)).toContain('repeated_prompt');
    });

    it('NEVER places prompt text on the synced metadata events (no-content)', () => {
        const c = coach({frequency: 'high'});
        c.observePrompt(SECRET);
        c.observePrompt(SECRET);
        const r = c.observePrompt(SECRET);
        const serialized = JSON.stringify({loopEvent: r.loopEvent, nudgeEvents: r.nudgeEvents});
        expect(serialized).not.toContain('SUPERSECRETMARKER');
        expect(serialized).not.toContain('billing');
        // The metadata carries only the session id, a count/type, and timestamps.
        expect(r.loopEvent).toMatchObject({sessionId: 'sess-1', similarPromptCount: 3});
        expect(r.nudgeEvents.every((e) => e.sessionId === 'sess-1' && typeof e.nudgeType === 'string')).toBe(true);
    });
});
