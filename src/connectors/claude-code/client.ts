export interface ClaudeCodeUsageEntry {
    user_id: string;
    user_email: string;
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    cost_usd: number;
    request_count: number;
    // Claude Code-specific — populated when available
    session_count?: number;
    tool_use_count?: number;
    tool_success_count?: number;
    commits?: number;
    prs_created?: number;
    lines_added?: number;
    lines_removed?: number;
}

export interface ClaudeCodeUsageResponse {
    data: ClaudeCodeUsageEntry[];
    has_more: boolean;
    next_token: string | null;
}

export interface ClaudeCodeClientConfig {
    orgId: string;
    apiKey: string;
    baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const RATE_LIMIT_MAX_RETRIES = 3;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'usage-access-costs-2025-01-15';

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_AFTER_MAX_MS = 60_000;

function parseRetryAfterMs(header: string | null, attempt: number): number {
    if (!header) return Math.min(60_000 * (attempt + 1), RETRY_AFTER_MAX_MS);
    const seconds = parseFloat(header);
    const ms = !isNaN(seconds) && seconds >= 0 ? Math.ceil(seconds) * 1000 : 60_000 * (attempt + 1);
    return Math.min(ms, RETRY_AFTER_MAX_MS);
}

async function fetchWithRetry(
    url: string,
    headers: Record<string, string>,
    retries = RATE_LIMIT_MAX_RETRIES,
): Promise<Response> {
    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= retries) {
        let res: Response;
        try {
            res = await fetch(url, {headers});
        } catch (networkErr) {
            lastError = networkErr instanceof Error ? networkErr : new Error(String(networkErr));
            if (attempt < retries) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw lastError;
        }

        if (res.status === 429) {
            const delayMs = parseRetryAfterMs(res.headers.get('retry-after'), attempt);
            if (attempt < retries) {
                await sleep(delayMs);
                attempt++;
                continue;
            }
            throw new Error(`Rate limit exceeded after ${retries} retries: ${url}`);
        }

        if (res.status >= 500) {
            lastError = new Error(`Anthropic API server error ${res.status} for ${url}`);
            if (attempt < retries) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw lastError;
        }

        if (!res.ok) {
            throw new Error(`Anthropic API error ${res.status} for ${url}: ${await res.text()}`);
        }

        return res;
    }

    throw lastError ?? new Error(`Request failed after ${retries} retries: ${url}`);
}

export class ClaudeCodeClient {
    private readonly orgId: string;
    private readonly headers: Record<string, string>;
    private readonly baseUrl: string;

    constructor(config: ClaudeCodeClientConfig) {
        this.orgId = config.orgId;
        this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        this.headers = {
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': ANTHROPIC_BETA,
            'content-type': 'application/json',
        };
    }

    async getUsage(dateFrom: string, dateTo: string): Promise<ClaudeCodeUsageEntry[]> {
        const all: ClaudeCodeUsageEntry[] = [];
        let nextToken: string | null = null;

        do {
            const params = new URLSearchParams({
                date_from: dateFrom,
                date_to: dateTo,
                limit: '100',
            });
            if (nextToken) params.set('next_token', nextToken);

            const url = `${this.baseUrl}/v1/organizations/${this.orgId}/users/usage?${params.toString()}`;
            const res = await fetchWithRetry(url, this.headers);
            const body = (await res.json()) as ClaudeCodeUsageResponse;

            all.push(...body.data);
            if (body.has_more && !body.next_token) {
                throw new Error('Pagination error: has_more=true but next_token is missing');
            }
            nextToken = body.has_more ? body.next_token : null;
        } while (nextToken);

        return all;
    }
}
