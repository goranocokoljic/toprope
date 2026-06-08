import cron from 'node-cron';
import type {SlackBotConfig} from '../config/types';
import {parseSyncTimeToCron} from '../scheduler/scheduler';
import {createSlackClient, type SlackClient} from './client';
import {buildDailyPromptMessage} from './blocks';

const DEFAULT_PROMPT_TIME = '16:00';

/**
 * Post the daily self-report prompt to each configured channel. Each channel is
 * independent — a failure posting to one is logged and the rest still go out.
 * Exported for direct testing without scheduling.
 */
export async function runDailyPrompt(
    client: SlackClient,
    channels: string[],
    log: (message: string, err: unknown) => void = (m, e) => console.error(`[slack] ${m}`, e),
): Promise<void> {
    const {text, blocks} = buildDailyPromptMessage();
    for (const channel of channels) {
        try {
            await client.postMessage(channel, text, blocks);
        } catch (err) {
            log(`failed to post daily prompt to ${channel}`, err);
        }
    }
}

export interface StartDailyPromptOptions {
    client?: SlackClient;
}

/**
 * Schedule the optional end-of-day prompt. Returns the cron tasks created (for
 * onClose teardown), or an empty array when the prompt is not active.
 *
 * The prompt is gated on ALL of: the bot enabled, daily_prompt.enabled, a bot
 * token present, and at least one channel configured — so it fires only when
 * explicitly opted in and actually deliverable.
 */
export function startSlackDailyPrompt(
    config: SlackBotConfig,
    options: StartDailyPromptOptions = {},
): ReturnType<typeof cron.schedule>[] {
    if (!config.enabled || !config.daily_prompt?.enabled) return [];

    const channels = config.daily_prompt.channels ?? [];
    if (channels.length === 0) return [];
    if (!options.client && !config.bot_token) return [];

    const client = options.client ?? createSlackClient(config.bot_token ?? '');
    const cronExpr = parseSyncTimeToCron(config.daily_prompt.time ?? DEFAULT_PROMPT_TIME);

    const task = cron.schedule(
        cronExpr,
        () => {
            void runDailyPrompt(client, channels);
        },
        {timezone: 'UTC'},
    );
    return [task];
}
