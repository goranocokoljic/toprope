// Cursor Analytics API client (Enterprise plan). Service-key authenticated.
//
// Mirrors the Windsurf client shape: a POST endpoint that returns per-user,
// per-day usage rows with cursor-based pagination. The service key is sent in
// the request body (not a header), matching how the Cursor Analytics endpoint
// authenticates and keeping the doctor probe simple.

export interface CursorUserMetrics {
    user_id: string;
    email: string;
    date: string;
    // Tab/autocomplete completions surfaced and accepted.
    autocomplete_shown: number;
    autocomplete_accepted: number;
    // Agent/Composer invocations.
    composer_requests: number;
    // Chat (Ask) messages.
    chat_requests: number;
    // Per-model request counts for the day, e.g. {"gpt-4o": 12, "claude-3.5": 4}.
    models_used?: Record<string, number>;
    // Cost in USD where Cursor derives it; absent on plans that don't expose it.
    estimated_cost?: number;
}

export interface CursorUsageResponse {
    users: CursorUserMetrics[];
    has_more?: boolean;
    next_cursor?: string | null;
}

export interface CursorClientConfig {
    serviceKey: string;
    baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.cursor.com/analytics/v1';
const RATE_LIMIT_MAX_RETRIES = 3;
const RETRY_AFTER_MAX_MS = 60_000;

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(header: string | null, attempt: number): number {
    if (!header) return Math.min(60_000 * (attempt + 1), RETRY_AFTER_MAX_MS);
    const seconds = parseFloat(header);
    const ms = !isNaN(seconds) && seconds >= 0 ? Math.ceil(seconds) * 1000 : 60_000 * (attempt + 1);
    return Math.min(ms, RETRY_AFTER_MAX_MS);
}

async function postWithRetry(
    url: string,
    body: Record<string, unknown>,
    retries = RATE_LIMIT_MAX_RETRIES,
): Promise<Response> {
    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= retries) {
        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body),
            });
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

        if (res.status === 401 || res.status === 403) {
            const text = await res.text();
            throw new Error(`Cursor API permission denied for ${url}: ${text}`);
        }

        if (res.status >= 500) {
            lastError = new Error(`Cursor API server error ${res.status} for ${url}`);
            if (attempt < retries) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw lastError;
        }

        if (!res.ok) {
            throw new Error(`Cursor API error ${res.status} for ${url}: ${await res.text()}`);
        }

        return res;
    }

    throw lastError ?? new Error(`Request failed after ${retries} retries: ${url}`);
}

export class CursorClient {
    private readonly serviceKey: string;
    private readonly baseUrl: string;

    constructor(config: CursorClientConfig) {
        this.serviceKey = config.serviceKey;
        this.baseUrl = config.baseUrl?.replace(/\/$/, '') ?? DEFAULT_BASE_URL;
    }

    async getUserMetrics(startDate: string, endDate: string): Promise<CursorUserMetrics[]> {
        const all: CursorUserMetrics[] = [];
        let cursor: string | null = null;

        do {
            const reqBody: Record<string, unknown> = {
                service_key: this.serviceKey,
                start_date: startDate,
                end_date: endDate,
            };
            if (cursor) reqBody.cursor = cursor;

            const url = `${this.baseUrl}/analytics/users/usage`;
            const res = await postWithRetry(url, reqBody);
            const data = (await res.json()) as CursorUsageResponse;

            all.push(...(data.users ?? []));
            if (data.has_more && !data.next_cursor) {
                throw new Error('Cursor API pagination error: has_more=true but next_cursor is missing');
            }
            cursor = data.has_more ? (data.next_cursor ?? null) : null;
        } while (cursor);

        return all;
    }
}
