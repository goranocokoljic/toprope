import {describe, it, expect} from 'vitest';
import {createLocalAgent} from '../../src/capture/local-agent';
import {createEditorExtension} from '../../src/capture/editor-extension';
import {buildCapturePayload, httpCaptureTransport, type CaptureWirePayload} from '../../src/capture/client';
import {decryptCapture, generateDeveloperKey} from '../../src/capture/encryption';

const PLAINTEXT = 'prompt: explain this stack trace\nresponse: the NPE is at ...';

describe('capture reference clients (Task 5.4)', () => {
    it('buildCapturePayload emits ciphertext + meta and never the plaintext', () => {
        const key = generateDeveloperKey();
        const payload = buildCapturePayload(
            {key, keyId: 'k1', mechanism: 'local_agent'},
            {sessionId: 's1', plaintext: PLAINTEXT, tool: 'copilot', promptCount: 2},
        );
        expect(payload.mechanism).toBe('local_agent');
        expect(payload.tool).toBe('copilot');
        expect(payload.prompt_count).toBe(2);
        // The wire payload carries only ciphertext; no plaintext leaks into JSON.
        expect(JSON.stringify(payload)).not.toContain('stack trace');
        // ...and it decrypts back with the key.
        const ct = Buffer.from(payload.ciphertext, 'base64');
        expect(decryptCapture(ct, payload.encryption_meta, key)).toBe(PLAINTEXT);
    });

    it('local agent and editor extension produce identical rows except the mechanism', async () => {
        const key = generateDeveloperKey();
        const sent: CaptureWirePayload[] = [];
        const transport = async (p: CaptureWirePayload): Promise<void> => {
            sent.push(p);
        };

        const agent = createLocalAgent({key, keyId: 'k1'}, transport);
        const extension = createEditorExtension({key, keyId: 'k1'}, transport);

        const fromAgent = await agent.capture({sessionId: 's1', plaintext: PLAINTEXT, tool: 'copilot'});
        const fromExt = await extension.capture({sessionId: 's1', plaintext: PLAINTEXT, tool: 'copilot'});

        expect(sent).toHaveLength(2);
        expect(fromAgent.mechanism).toBe('local_agent');
        expect(fromExt.mechanism).toBe('editor_extension');
        // Both decrypt to the same plaintext — the rows are identical bar mechanism/IV.
        expect(decryptCapture(Buffer.from(fromAgent.ciphertext, 'base64'), fromAgent.encryption_meta, key)).toBe(PLAINTEXT);
        expect(decryptCapture(Buffer.from(fromExt.ciphertext, 'base64'), fromExt.encryption_meta, key)).toBe(PLAINTEXT);
    });

    it('a failing transport surfaces an error to the agent (so it can retry)', async () => {
        const key = generateDeveloperKey();
        const agent = createLocalAgent({key, keyId: 'k1'}, async () => {
            throw new Error('network down');
        });
        await expect(agent.capture({sessionId: 's1', plaintext: PLAINTEXT})).rejects.toThrow('network down');
    });
});

describe('httpCaptureTransport (Task 5.4)', () => {
    const payload: CaptureWirePayload = {
        session_id: 's1',
        captured_at: '2026-06-15T00:00:00.000Z',
        ciphertext: 'AAAA',
        encryption_meta: {algo: 'AES-256-GCM', iv: 'aXY=', auth_tag: 'dGFn', key_id: 'k1'},
        mechanism: 'local_agent',
    };

    it('POSTs the encrypted payload to the endpoint with a bearer token', async () => {
        const calls: Array<{url: string; init: RequestInit}> = [];
        const fakeFetch = (async (url: string, init: RequestInit) => {
            calls.push({url, init});
            return {ok: true, status: 201} as Response;
        }) as unknown as typeof fetch;

        const transport = httpCaptureTransport({endpoint: 'http://host/api/me/captures', token: 'tok', fetchImpl: fakeFetch});
        await transport(payload);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://host/api/me/captures');
        expect(calls[0].init.method).toBe('POST');
        expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
        expect(JSON.parse(calls[0].init.body as string).ciphertext).toBe('AAAA');
    });

    it('throws on a non-2xx response so the caller can retry', async () => {
        const fakeFetch = (async () => ({ok: false, status: 503}) as Response) as unknown as typeof fetch;
        const transport = httpCaptureTransport({endpoint: 'http://host/x', token: 'tok', fetchImpl: fakeFetch});
        await expect(transport(payload)).rejects.toThrow(/HTTP 503/);
    });
});
