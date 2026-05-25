export interface CopilotMetricsBreakdown {
    editor?: string;
    language?: string;
    model?: string;
    suggestions_count?: number;
    acceptances_count?: number;
    lines_suggested?: number;
    lines_accepted?: number;
    active_users?: number;
}

export interface CopilotUserMetrics {
    login: string;
    date: string;
    total_suggestions_count: number;
    total_acceptances_count: number;
    total_lines_suggested: number;
    total_lines_accepted: number;
    total_active_chat_count: number;
    total_chat_insertion_events: number;
    total_chat_copy_events: number;
    breakdown?: CopilotMetricsBreakdown[];
}

export interface CopilotSeat {
    login: string;
    created_at: string;
    updated_at: string;
    pending_cancellation_date: string | null;
    last_activity_at: string | null;
    last_activity_editor: string | null;
    plan_type: string;
    assignee: {login: string};
    assigning_team?: {name: string} | null;
}

export interface CopilotSeatsResponse {
    total_seats: number;
    seats: CopilotSeat[];
}

export interface CopilotClientConfig {
    org: string;
    token: string;
    baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const RATE_LIMIT_MAX_RETRIES = 3;

function parseNextLinkUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match?.[1] ?? null;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(header: string | null, attempt: number): number {
    if (!header) return 60_000 * (attempt + 1);
    const seconds = parseFloat(header);
    return !isNaN(seconds) && seconds >= 0 ? Math.ceil(seconds) * 1000 : 60_000 * (attempt + 1);
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
            lastError = new Error(`GitHub API server error ${res.status} for ${url}`);
            if (attempt < retries) {
                await sleep(1_000 * (attempt + 1));
                attempt++;
                continue;
            }
            throw lastError;
        }

        if (!res.ok) {
            throw new Error(`GitHub API error ${res.status} for ${url}: ${await res.text()}`);
        }

        return res;
    }

    throw lastError ?? new Error(`Request failed after ${retries} retries: ${url}`);
}

export class CopilotClient {
    private readonly org: string;
    private readonly headers: Record<string, string>;
    private readonly baseUrl: string;

    constructor(config: CopilotClientConfig) {
        this.org = config.org;
        this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        this.headers = {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    async getMetrics(since?: string, until?: string): Promise<CopilotUserMetrics[]> {
        const params = new URLSearchParams();
        if (since) params.set('since', since);
        if (until) params.set('until', until);
        const query = params.toString() ? `?${params.toString()}` : '';
        const initialUrl = `${this.baseUrl}/orgs/${this.org}/copilot/metrics${query}`;

        const allMetrics: CopilotUserMetrics[] = [];
        let nextUrl: string | null = initialUrl;

        while (nextUrl) {
            const res = await fetchWithRetry(nextUrl, this.headers);
            const page = (await res.json()) as CopilotUserMetrics[];
            allMetrics.push(...page);
            nextUrl = parseNextLinkUrl(res.headers.get('link'));
        }

        return allMetrics;
    }

    async getSeats(): Promise<CopilotSeat[]> {
        const seats: CopilotSeat[] = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const url = `${this.baseUrl}/orgs/${this.org}/copilot/billing/seats?per_page=${perPage}&page=${page}`;
            const res = await fetchWithRetry(url, this.headers);
            const data = (await res.json()) as CopilotSeatsResponse;

            if (!data.seats || data.seats.length === 0) break;
            seats.push(...data.seats);

            if (data.seats.length < perPage) break;
            page++;
        }

        return seats;
    }
}
