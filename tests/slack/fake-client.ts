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
export interface DeleteMessageCall {
    responseUrl: string;
}

// Recording fake of SlackClient for handler/route tests. By default every call
// succeeds; set a `*Error` to make the matching method reject (to exercise the
// best-effort error paths).
export class FakeSlackClient implements SlackClient {
    openViewCalls: OpenViewCall[] = [];
    postMessageCalls: PostMessageCall[] = [];
    deleteMessageCalls: DeleteMessageCall[] = [];

    openViewError: Error | null = null;
    postMessageError: Error | null = null;
    deleteMessageError: Error | null = null;

    async openView(triggerId: string, view: SlackView): Promise<void> {
        this.openViewCalls.push({triggerId, view});
        if (this.openViewError) throw this.openViewError;
    }
    async postMessage(channel: string, text: string, blocks?: SlackBlock[]): Promise<void> {
        this.postMessageCalls.push({channel, text, blocks});
        if (this.postMessageError) throw this.postMessageError;
    }
    async deleteMessage(responseUrl: string): Promise<void> {
        this.deleteMessageCalls.push({responseUrl});
        if (this.deleteMessageError) throw this.deleteMessageError;
    }
}
