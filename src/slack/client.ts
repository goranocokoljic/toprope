import type {SlackBlock, SlackView} from './blocks';

// The slice of the Slack Web API the bot needs. Kept as an interface so handlers
// depend on the capability, not on `fetch` — tests inject a fake.
export interface SlackClient {
    // Open a modal in response to an interaction trigger.
    openView(triggerId: string, view: SlackView): Promise<void>;
    // Post a message to a channel or DM (channel = a channel id or a user id for a DM).
    postMessage(channel: string, text: string, blocks?: SlackBlock[]): Promise<void>;
    // POST a JSON payload to an interaction's response_url (e.g. to delete the
    // original message when a prompt is dismissed).
    respond(responseUrl: string, body: Record<string, unknown>): Promise<void>;
}

const SLACK_API_BASE = 'https://slack.com/api';

// Slack Web API responses are `{ok: boolean, error?: string, ...}`.
interface SlackApiResponse {
    ok: boolean;
    error?: string;
}

async function callSlack(
    botToken: string,
    method: string,
    body: Record<string, unknown>,
): Promise<void> {
    const res = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
    });
    // A non-2xx is a transport/HTTP failure; ok=false is a Slack-level failure.
    // Both are surfaced so the caller can log them (Slack actions are best-effort
    // — a failed confirmation must never roll back an already-written report).
    if (!res.ok) {
        throw new Error(`Slack ${method} HTTP ${res.status}`);
    }
    const data = (await res.json()) as SlackApiResponse;
    if (!data.ok) {
        throw new Error(`Slack ${method} error: ${data.error ?? 'unknown'}`);
    }
}

/**
 * Real Slack client backed by the Web API and a bot token. Network failures and
 * Slack-level errors throw; callers decide whether to swallow them (confirmation
 * messages) or propagate.
 */
export function createSlackClient(botToken: string): SlackClient {
    return {
        async openView(triggerId, view): Promise<void> {
            await callSlack(botToken, 'views.open', {trigger_id: triggerId, view});
        },
        async postMessage(channel, text, blocks): Promise<void> {
            await callSlack(botToken, 'chat.postMessage', {
                channel,
                text,
                ...(blocks ? {blocks} : {}),
            });
        },
        async respond(responseUrl, body): Promise<void> {
            const res = await fetch(responseUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json; charset=utf-8'},
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                throw new Error(`Slack response_url HTTP ${res.status}`);
            }
        },
    };
}
