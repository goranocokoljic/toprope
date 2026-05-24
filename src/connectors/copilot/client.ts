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

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
    url: string,
    headers: Record<string, string>,
    retries = RATE_LIMIT_MAX_RETRIES,
): Promise<Response> {
    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= retries) {
        const res = await fetch(url, {headers});

        if (res.status === 429) {
            const retryAfter = res.headers.get('retry-after');
            const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000 * (attempt + 1);
            if (attempt < retries) {
                await sleep(delayMs);
                attempt++;
                continue;
            }
            throw new Error(`Rate limit exceeded after ${retries} retries: ${url}`);
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
        const url = `${this.baseUrl}/orgs/${this.org}/copilot/metrics${query}`;

        const res = await fetchWithRetry(url, this.headers);
        return (await res.json()) as CopilotUserMetrics[];
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
