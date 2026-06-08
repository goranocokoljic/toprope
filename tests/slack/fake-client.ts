import type {SlackBlock, SlackView} from '../../src/slack/blocks';
import type {SlackClient} from '../../src/slack/client';

export interface OpenViewCall {
    triggerId: string;
    view: SlackView;
}
export interface PostMessageCall {
    channel: string;
    text: string;
    blocks?: SlackBlock[];
}
export interface RespondCall {
    responseUrl: string;
    body: Record<string, unknown>;
}

// Recording fake of SlackClient for handler/route tests. By default every call
// succeeds; set a `*Error` to make the matching method reject (to exercise the
// best-effort error paths).
export class FakeSlackClient implements SlackClient {
    openViewCalls: OpenViewCall[] = [];
    postMessageCalls: PostMessageCall[] = [];
    respondCalls: RespondCall[] = [];

    openViewError: Error | null = null;
    postMessageError: Error | null = null;
    respondError: Error | null = null;

    async openView(triggerId: string, view: SlackView): Promise<void> {
        this.openViewCalls.push({triggerId, view});
        if (this.openViewError) throw this.openViewError;
    }
    async postMessage(channel: string, text: string, blocks?: SlackBlock[]): Promise<void> {
        this.postMessageCalls.push({channel, text, blocks});
        if (this.postMessageError) throw this.postMessageError;
    }
    async respond(responseUrl: string, body: Record<string, unknown>): Promise<void> {
        this.respondCalls.push({responseUrl, body});
        if (this.respondError) throw this.respondError;
    }
}
