import {describe, it, expect} from 'vitest';
import {runDailyPrompt, startSlackDailyPrompt} from '../../src/slack/scheduler';
import {FakeSlackClient} from './fake-client';

describe('runDailyPrompt', () => {
    it('posts the prompt to every configured channel', async () => {
        const client = new FakeSlackClient();
        await runDailyPrompt(client, ['C1', 'C2'], () => {});
        expect(client.postMessageCalls.map((c) => c.channel)).toEqual(['C1', 'C2']);
        // The prompt carries interactive blocks (the Log/Dismiss buttons).
        expect(client.postMessageCalls[0].blocks).toBeDefined();
    });

    it('continues to remaining channels when one fails', async () => {
        const client = new FakeSlackClient();
        client.postMessageError = new Error('boom');
        const logged: string[] = [];
        await runDailyPrompt(client, ['C1', 'C2'], (m) => logged.push(m));
        expect(client.postMessageCalls).toHaveLength(2);
        expect(logged).toHaveLength(2);
    });
});

describe('startSlackDailyPrompt gating', () => {
    const client = new FakeSlackClient();

    it('does nothing when slack is disabled', () => {
        expect(startSlackDailyPrompt({enabled: false, daily_prompt: {enabled: true, channels: ['C1']}}, {client})).toEqual([]);
    });

    it('does nothing when the daily prompt is disabled', () => {
        expect(startSlackDailyPrompt({enabled: true, daily_prompt: {enabled: false, channels: ['C1']}}, {client})).toEqual([]);
    });

    it('does nothing when no channels are configured', () => {
        expect(startSlackDailyPrompt({enabled: true, daily_prompt: {enabled: true, channels: []}}, {client})).toEqual([]);
    });

    it('schedules a task when enabled with channels', () => {
        const tasks = startSlackDailyPrompt(
            {enabled: true, daily_prompt: {enabled: true, time: '16:00', channels: ['C1']}},
            {client},
        );
        expect(tasks).toHaveLength(1);
        tasks.forEach((t) => t.stop());
    });
});
