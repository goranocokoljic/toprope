import {describe, it, expect, vi} from 'vitest';
import {
    resolveSummaryModel,
    createSummaryModelClient,
    SummaryModelClient,
    type ResolvedSummaryModel,
    type SummaryModelLogger,
} from '../../src/summaries/model-client';
import type {SummariesConfig} from '../../src/config/types';

const silentLogger: SummaryModelLogger = {warn: () => undefined};

/** A minimal fake fetch returning a JSON Response-like object. */
function jsonFetch(status: number, body: unknown, textBody = ''): typeof fetch {
    return vi.fn(async () => {
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
            text: async () => textBody || JSON.stringify(body),
        } as Response;
    }) as unknown as typeof fetch;
}

describe('resolveSummaryModel', () => {
    it('defaults to ollama at the local endpoint when nothing is configured', () => {
        const resolved = resolveSummaryModel({model: {model_name: 'llama3.1:70b'}}, 'monthly');
        expect(resolved.type).toBe('ollama');
        expect(resolved.endpoint).toBe('http://localhost:11434');
        expect(resolved.model_name).toBe('llama3.1:70b');
    });

    it('uses the base model_name when a level has no override', () => {
        const summaries: SummariesConfig = {
            model: {type: 'ollama', model_name: 'llama3.1:70b'},
            monthly: {enabled: true},
        };
        expect(resolveSummaryModel(summaries, 'monthly').model_name).toBe('llama3.1:70b');
    });

    it('applies a per-level model override (monthly uses a different model)', () => {
        const summaries: SummariesConfig = {
            model: {type: 'ollama', model_name: 'llama3.1:8b'},
            monthly: {model_name: 'llama3.1:70b'},
        };
        expect(resolveSummaryModel(summaries, 'weekly').model_name).toBe('llama3.1:8b');
        expect(resolveSummaryModel(summaries, 'monthly').model_name).toBe('llama3.1:70b');
    });

    it('resolves the yearly level (newly added)', () => {
        const summaries: SummariesConfig = {
            model: {type: 'ollama', model_name: 'base'},
            yearly: {model_name: 'big'},
        };
        expect(resolveSummaryModel(summaries, 'yearly').model_name).toBe('big');
    });

    it('falls back to the provider default endpoint per type', () => {
        expect(resolveSummaryModel({model: {type: 'anthropic', model_name: 'm'}}, 'weekly').endpoint).toBe(
            'https://api.anthropic.com',
        );
        expect(resolveSummaryModel({model: {type: 'openai', model_name: 'm'}}, 'weekly').endpoint).toBe(
            'https://api.openai.com',
        );
    });

    it('honours an explicit endpoint override', () => {
        const resolved = resolveSummaryModel(
            {model: {type: 'ollama', endpoint: 'http://gpu-box:11434', model_name: 'm'}},
            'weekly',
        );
        expect(resolved.endpoint).toBe('http://gpu-box:11434');
    });

    it('throws on an unsupported model type', () => {
        expect(() => resolveSummaryModel({model: {type: 'cohere', model_name: 'm'}}, 'weekly')).toThrow(
            /Unsupported summary model type/,
        );
    });

    it('throws when no model_name can be resolved for a level', () => {
        expect(() => resolveSummaryModel({model: {type: 'ollama'}}, 'weekly')).toThrow(/No model_name/);
    });
});

function ollamaConfig(overrides: Partial<ResolvedSummaryModel> = {}): ResolvedSummaryModel {
    return {type: 'ollama', endpoint: 'http://localhost:11434', model_name: 'llama3.1:8b', ...overrides};
}

describe('SummaryModelClient.generate — ollama', () => {
    it('returns ok with the trimmed response text on success', async () => {
        const fetchImpl = jsonFetch(200, {response: '  The team had a strong week.  '});
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: silentLogger});
        const result = await client.generate('prompt');
        expect(result).toEqual({ok: true, text: 'The team had a strong week.', model: 'llama3.1:8b'});
    });

    it('calls the ollama /api/generate endpoint with the configured model', async () => {
        const fetchImpl = jsonFetch(200, {response: 'ok'});
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: silentLogger});
        await client.generate('my prompt');
        const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toBe('http://localhost:11434/api/generate');
        expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
            model: 'llama3.1:8b',
            prompt: 'my prompt',
            stream: false,
        });
    });

    it('trims a trailing slash on the endpoint so the path does not double up', async () => {
        const fetchImpl = jsonFetch(200, {response: 'ok'});
        const client = new SummaryModelClient(ollamaConfig({endpoint: 'http://localhost:11434/'}), {
            fetchImpl,
            logger: silentLogger,
        });
        await client.generate('p');
        const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toBe('http://localhost:11434/api/generate');
    });

    it('treats a 5xx as a retryable failure without throwing', async () => {
        const fetchImpl = jsonFetch(503, {}, 'service unavailable');
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: silentLogger});
        const result = await client.generate('p');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.retryable).toBe(true);
            expect(result.error).toContain('503');
        }
    });

    it('treats a 4xx (not 429) as a non-retryable failure', async () => {
        const fetchImpl = jsonFetch(400, {}, 'bad request');
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: silentLogger});
        const result = await client.generate('p');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.retryable).toBe(false);
    });

    it('treats a 429 as retryable', async () => {
        const fetchImpl = jsonFetch(429, {}, 'rate limited');
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: silentLogger});
        const result = await client.generate('p');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.retryable).toBe(true);
    });

    it('handles an unreachable endpoint (fetch throws) gracefully — no crash, retryable, logged', async () => {
        const warn = vi.fn();
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: {warn}});
        const result = await client.generate('p');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.retryable).toBe(true);
            expect(result.error).toContain('ECONNREFUSED');
        }
        expect(warn).toHaveBeenCalledOnce();
    });

    it('treats a timeout/abort as a retryable failure', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new DOMException('The operation was aborted', 'AbortError');
        }) as unknown as typeof fetch;
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: silentLogger});
        const result = await client.generate('p');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.retryable).toBe(true);
    });

    it('treats an empty 200 response as a retryable failure (no empty summaries stored)', async () => {
        const fetchImpl = jsonFetch(200, {response: '   '});
        const client = new SummaryModelClient(ollamaConfig(), {fetchImpl, logger: silentLogger});
        const result = await client.generate('p');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.retryable).toBe(true);
            expect(result.error).toMatch(/empty/i);
        }
    });
});

describe('SummaryModelClient.generate — anthropic', () => {
    it('extracts text blocks from a successful response', async () => {
        const fetchImpl = jsonFetch(200, {
            content: [
                {type: 'text', text: 'May was strong. '},
                {type: 'text', text: 'Output rose.'},
            ],
        });
        const client = new SummaryModelClient(
            {type: 'anthropic', endpoint: 'https://api.anthropic.com', model_name: 'claude', api_key: 'k'},
            {fetchImpl, logger: silentLogger},
        );
        const result = await client.generate('p');
        expect(result).toEqual({ok: true, text: 'May was strong. Output rose.', model: 'claude'});
        const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect((init as RequestInit).headers).toMatchObject({'x-api-key': 'k'});
    });

    it('fails non-retryably when no api_key is configured', async () => {
        const fetchImpl = jsonFetch(200, {});
        const client = new SummaryModelClient(
            {type: 'anthropic', endpoint: 'https://api.anthropic.com', model_name: 'claude'},
            {fetchImpl, logger: silentLogger},
        );
        const result = await client.generate('p');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.retryable).toBe(false);
        // Must not even attempt the request without a key.
        expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
});

describe('SummaryModelClient.generate — openai', () => {
    it('extracts the first choice message content', async () => {
        const fetchImpl = jsonFetch(200, {choices: [{message: {content: 'Quarterly narrative.'}}]});
        const client = new SummaryModelClient(
            {type: 'openai', endpoint: 'https://api.openai.com', model_name: 'gpt', api_key: 'k'},
            {fetchImpl, logger: silentLogger},
        );
        const result = await client.generate('p');
        expect(result).toEqual({ok: true, text: 'Quarterly narrative.', model: 'gpt'});
        const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect((init as RequestInit).headers).toMatchObject({authorization: 'Bearer k'});
    });
});

describe('createSummaryModelClient', () => {
    it('builds a client for the resolved level', () => {
        const client = createSummaryModelClient(
            {model: {type: 'ollama', model_name: 'base'}, monthly: {model_name: 'big'}},
            'monthly',
        );
        expect(client.modelName).toBe('big');
    });
});
