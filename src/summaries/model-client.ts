/**
 * Summary model client (Task 3.7 / #76).
 *
 * A configurable text-generation client for the AI summaries. It defaults to a
 * LOCAL model (Ollama) for privacy: the only thing ever sent to it is the
 * numbers-only payload the input-builder produces (no code, no commit contents,
 * no prompt text from repos), and keeping the default endpoint local guarantees
 * that data never leaves the network.
 *
 * The client is configured per summary level. The base `summaries.model` block
 * sets the provider (ollama | anthropic | openai), endpoint, and default model;
 * each level (weekly/monthly/quarterly/yearly) may override `model_name` so a
 * team can keep weekly on a small/local model while pointing monthly+ at a
 * larger or cloud model. `resolveSummaryModel` performs that merge.
 *
 * Graceful failure is a first-class requirement: an unreachable or erroring
 * endpoint must NOT crash the caller (the summary scheduler). `generate` never
 * throws for an operational failure — it returns a discriminated result with
 * `ok: false`, a message, and a `retryable` flag so the generator can log, skip,
 * and mark the summary not-generated/retryable. The only thrown error is a
 * programming error (an unsupported provider type), which is a config/build bug,
 * not a runtime condition to swallow.
 */

import type {SummariesConfig, SummaryModelConfig} from '../config/types';

/** Provider types the client knows how to talk to. */
export type SummaryModelType = 'ollama' | 'anthropic' | 'openai';

/** The four summary levels — each can override the base model_name. */
export type SummaryLevel = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** Fully-resolved model settings for one level (base merged with the override). */
export interface ResolvedSummaryModel {
    type: SummaryModelType;
    endpoint: string;
    model_name: string;
    api_key?: string;
}

/**
 * Result of a generation attempt. A discriminated union so callers must handle
 * the failure path — `ok: false` carries a human-readable error and whether a
 * later retry could plausibly succeed (network/5xx/timeout = retryable; a 4xx
 * auth/validation error = not, since retrying the same request won't help).
 */
export type SummaryModelResult =
    | {ok: true; text: string; model: string}
    | {ok: false; error: string; retryable: boolean; model: string};

/** Minimal logger surface (matches console); injectable for tests/silence. */
export interface SummaryModelLogger {
    warn: (message: string) => void;
}

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';
const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** Wall-clock cap on a single generation request before it's treated as a failure. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Hard cap on generated length, sized for the longest (yearly) narrative. */
const MAX_OUTPUT_TOKENS = 4_096;

const SUPPORTED_TYPES: readonly SummaryModelType[] = ['ollama', 'anthropic', 'openai'];

function isSupportedType(value: string | undefined): value is SummaryModelType {
    return value !== undefined && (SUPPORTED_TYPES as readonly string[]).includes(value);
}

/**
 * Merge the base `summaries.model` block with a level's override into the
 * concrete settings used for one generation. Only `model_name` is overridable
 * per level (the provider, endpoint, and key are shared); an absent override
 * leaves the base model in place. Falls back to sane defaults so a partial
 * config still resolves: type → ollama, endpoint → the provider's default.
 *
 * Throws if a model_name cannot be determined or the type is unsupported — both
 * are config errors that should surface loudly at setup, not silently skip.
 */
export function resolveSummaryModel(
    summaries: SummariesConfig | undefined,
    level: SummaryLevel,
): ResolvedSummaryModel {
    const base: SummaryModelConfig = summaries?.model ?? {};
    const type = base.type ?? 'ollama';
    if (!isSupportedType(type)) {
        throw new Error(
            `Unsupported summary model type "${type}" (expected one of: ${SUPPORTED_TYPES.join(', ')})`,
        );
    }

    const override = summaries?.[level]?.model_name;
    const modelName = override ?? base.model_name;
    if (!modelName) {
        throw new Error(
            `No model_name configured for summary level "${level}" (set summaries.model.model_name or summaries.${level}.model_name)`,
        );
    }

    return {
        type,
        endpoint: base.endpoint ?? defaultEndpointFor(type),
        model_name: modelName,
        api_key: base.api_key,
    };
}

function defaultEndpointFor(type: SummaryModelType): string {
    switch (type) {
        case 'ollama':
            return DEFAULT_OLLAMA_ENDPOINT;
        case 'openai':
            return DEFAULT_OPENAI_ENDPOINT;
        case 'anthropic':
            return ANTHROPIC_ENDPOINT;
    }
}

/** Strip a single trailing slash so endpoint + path joins don't double up. */
function trimTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

const noopLogger: SummaryModelLogger = {warn: () => undefined};

/**
 * Talks to a configured text-generation endpoint. Construct one per resolved
 * model (i.e. per level) and call `generate(prompt)`. `fetchImpl` is injectable
 * so tests can drive the provider branches without a live server; it defaults to
 * the global fetch.
 */
export class SummaryModelClient {
    private readonly config: ResolvedSummaryModel;
    private readonly fetchImpl: typeof fetch;
    private readonly logger: SummaryModelLogger;

    constructor(
        config: ResolvedSummaryModel,
        options: {fetchImpl?: typeof fetch; logger?: SummaryModelLogger} = {},
    ) {
        this.config = config;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.logger = options.logger ?? noopLogger;
    }

    get modelName(): string {
        return this.config.model_name;
    }

    /**
     * Generate narrative text from a prompt. Returns a result rather than
     * throwing for operational failures (unreachable endpoint, timeout, HTTP
     * error, malformed body) so the scheduler can log + skip + retry later.
     */
    async generate(prompt: string): Promise<SummaryModelResult> {
        const {type, model_name} = this.config;
        try {
            switch (type) {
                case 'ollama':
                    return await this.generateOllama(prompt);
                case 'anthropic':
                    return await this.generateAnthropic(prompt);
                case 'openai':
                    return await this.generateOpenAI(prompt);
            }
        } catch (err) {
            // Any throw from a provider branch (network error, timeout/abort,
            // JSON parse) is operational — convert to a retryable failure.
            const message = err instanceof Error ? err.message : String(err);
            const retryable = true;
            this.logger.warn(
                `Summary model (${type}/${model_name}) request failed: ${message} — skipping, retryable`,
            );
            return {ok: false, error: message, retryable, model: model_name};
        }
    }

    private async fetchJson(
        url: string,
        body: unknown,
        headers: Record<string, string>,
    ): Promise<{res: Response; failure?: SummaryModelResult}> {
        const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: {'content-type': 'application/json', ...headers},
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            // 4xx (except 429) won't be fixed by retrying the same request; 5xx
            // and rate limits are transient.
            const retryable = res.status >= 500 || res.status === 429;
            const text = await safeText(res);
            const error = `HTTP ${res.status} from ${this.config.type} endpoint${text ? `: ${text}` : ''}`;
            this.logger.warn(
                `Summary model (${this.config.type}/${this.config.model_name}) ${error} — skipping${retryable ? ', retryable' : ''}`,
            );
            return {res, failure: {ok: false, error, retryable, model: this.config.model_name}};
        }
        return {res};
    }

    private async generateOllama(prompt: string): Promise<SummaryModelResult> {
        const url = `${trimTrailingSlash(this.config.endpoint)}/api/generate`;
        const {res, failure} = await this.fetchJson(
            url,
            {model: this.config.model_name, prompt, stream: false},
            {},
        );
        if (failure) return failure;

        const body = (await res.json()) as {response?: unknown};
        const text = typeof body.response === 'string' ? body.response.trim() : '';
        return this.textOrEmptyFailure(text);
    }

    private async generateAnthropic(prompt: string): Promise<SummaryModelResult> {
        if (!this.config.api_key) {
            // No key is a config error, not a transient one — not retryable.
            const error = 'No api_key configured for anthropic summary model';
            this.logger.warn(`Summary model (anthropic/${this.config.model_name}) ${error} — skipping`);
            return {ok: false, error, retryable: false, model: this.config.model_name};
        }
        const url = `${trimTrailingSlash(this.config.endpoint || ANTHROPIC_ENDPOINT)}/v1/messages`;
        const {res, failure} = await this.fetchJson(
            url,
            {
                model: this.config.model_name,
                max_tokens: MAX_OUTPUT_TOKENS,
                messages: [{role: 'user', content: prompt}],
            },
            {'x-api-key': this.config.api_key, 'anthropic-version': ANTHROPIC_VERSION},
        );
        if (failure) return failure;

        const body = (await res.json()) as {content?: Array<{type?: string; text?: unknown}>};
        const text = (body.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('')
            .trim();
        return this.textOrEmptyFailure(text);
    }

    private async generateOpenAI(prompt: string): Promise<SummaryModelResult> {
        const url = `${trimTrailingSlash(this.config.endpoint)}/v1/chat/completions`;
        const headers: Record<string, string> = {};
        if (this.config.api_key) headers.authorization = `Bearer ${this.config.api_key}`;
        const {res, failure} = await this.fetchJson(
            url,
            {
                model: this.config.model_name,
                max_tokens: MAX_OUTPUT_TOKENS,
                messages: [{role: 'user', content: prompt}],
            },
            headers,
        );
        if (failure) return failure;

        const body = (await res.json()) as {
            choices?: Array<{message?: {content?: unknown}}>;
        };
        const content = body.choices?.[0]?.message?.content;
        const text = typeof content === 'string' ? content.trim() : '';
        return this.textOrEmptyFailure(text);
    }

    /**
     * A 200 with no usable text is still a failed generation — surface it as a
     * retryable failure rather than storing an empty summary.
     */
    private textOrEmptyFailure(text: string): SummaryModelResult {
        if (text.length === 0) {
            const error = 'Model returned an empty response';
            this.logger.warn(
                `Summary model (${this.config.type}/${this.config.model_name}) ${error} — skipping, retryable`,
            );
            return {ok: false, error, retryable: true, model: this.config.model_name};
        }
        return {ok: true, text, model: this.config.model_name};
    }
}

/** Read a response body as text without throwing (used only for error messages). */
async function safeText(res: Response): Promise<string> {
    try {
        const text = await res.text();
        return text.slice(0, 500);
    } catch {
        return '';
    }
}

/**
 * Convenience factory: resolve the model for a level and construct a client.
 * Most callers (the generator) want exactly this.
 */
export function createSummaryModelClient(
    summaries: SummariesConfig | undefined,
    level: SummaryLevel,
    options: {fetchImpl?: typeof fetch; logger?: SummaryModelLogger} = {},
): SummaryModelClient {
    return new SummaryModelClient(resolveSummaryModel(summaries, level), options);
}
