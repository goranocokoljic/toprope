export interface ServerConfig {
    port: number;
    host: string;
}

export interface StorageConfig {
    type: 'sqlite';
    sqlite_path: string;
}

export interface ConnectorBaseConfig {
    enabled: boolean;
    sync_interval?: string;
    sync_time?: string;
}

export interface CopilotConnectorConfig extends ConnectorBaseConfig {
    github_org?: string;
    api_token?: string;
}

export interface ClaudeCodeConnectorConfig extends ConnectorBaseConfig {
    org_id?: string;
    api_key?: string;
}

export interface WindsurfConnectorConfig extends ConnectorBaseConfig {
    service_key?: string;
}

export interface CursorConnectorConfig extends ConnectorBaseConfig {
    service_key?: string;
}

export interface GitAnalysisConfig {
    churn_window_hours?: number;
    ai_signature_enabled?: boolean;
}

export interface GitConnectorConfig extends ConnectorBaseConfig {
    provider?: string;
    org?: string;
    api_token?: string;
    repos?: string[];
    analysis?: GitAnalysisConfig;
    // Multi-provider configuration — each entry is a full provider config
    // (GitProviderConfig from providers/types). Using unknown[] here avoids
    // importing provider types into the config layer at load time; the sync
    // orchestrator casts and validates via the provider factory.
    providers?: unknown[];
}

export interface ConnectorsConfig {
    copilot: CopilotConnectorConfig;
    claude_code: ClaudeCodeConnectorConfig;
    windsurf: WindsurfConnectorConfig;
    cursor: CursorConnectorConfig;
    git: GitConnectorConfig;
}

export interface SubscriptionDefaultsConfig {
    copilot_business?: number;
    copilot_enterprise?: number;
    cursor_pro?: number;
    cursor_business?: number;
    claude_code_pro?: number;
    claude_code_max?: number;
    windsurf_pro?: number;
    windsurf_teams?: number;
}

export interface ColumnMappingConfig {
    developer_email?: string;
    tool?: string;
    plan?: string;
    monthly_cost?: string;
    billing_model?: string;
    // Richer import (Task 4.5) — all optional, used when present:
    developer_name?: string; // for name-variant matching when email is absent/unmatched
    amount?: string; // raw charge amount; combined with frequency to derive monthly_cost
    frequency?: string; // recurring/one-time hint (monthly | annual | one-time | …)
    period?: string; // billing-period or charge-date column; normalized for dedup
    currency?: string; // recorded on the charge ledger (no conversion is performed)
}

// A named import profile (Task 4.5). Lets one config import from several expense
// systems (Expensify, SAP Concur, a manual sheet) by selecting a profile whose
// column_mapping matches that system's export.
export interface ImportProfileConfig {
    column_mapping?: ColumnMappingConfig;
    // Billing model assumed for this source when a row carries none — e.g. an
    // expense-reimbursement export (Expensify/Concur) implies `reimbursed`. When
    // applied, the resulting subscription is flagged billing_model_inferred.
    default_billing_model?: string;
    // Charge frequency assumed when a row has no frequency column/value.
    default_frequency?: string;
}

export interface ExpensesConfig {
    import_path?: string;
    subscription_defaults?: SubscriptionDefaultsConfig;
    // Legacy single mapping — still honored as the 'standard' profile's mapping.
    column_mapping?: ColumnMappingConfig;
    // Named profiles, merged over the built-in profiles (standard/expensify/concur).
    import_profiles?: Record<string, ImportProfileConfig>;
}

export interface AggregationScheduleConfig {
    day?: string | number;
    time?: string;
}

export interface AggregationConfig {
    weekly?: AggregationScheduleConfig;
    monthly?: AggregationScheduleConfig;
    quarterly?: AggregationScheduleConfig;
    daily_retention_days?: number;
}

export interface SummaryModelConfig {
    // 'ollama' (default, local) | 'anthropic' | 'openai'.
    type?: string;
    // Base URL of the model endpoint. For ollama this is the local server
    // (default http://localhost:11434); for openai a compatible base URL; for
    // anthropic a gateway/proxy URL (defaults to the official API host).
    endpoint?: string;
    model_name?: string;
    api_key?: string;
}

export interface SummaryPeriodConfig {
    enabled?: boolean;
    auto_generate?: boolean;
    // Per-level model override. Lets weekly stay on a small/local model while
    // monthly+ point at a larger or cloud model (or vice versa).
    model_name?: string;
}

export interface SummariesConfig {
    enabled?: boolean;
    model?: SummaryModelConfig;
    weekly?: SummaryPeriodConfig;
    monthly?: SummaryPeriodConfig;
    quarterly?: SummaryPeriodConfig;
    yearly?: SummaryPeriodConfig;
}

export interface SlackAlertsConfig {
    enabled?: boolean;
    webhook_url?: string;
}

export interface AlertsConfig {
    slack?: SlackAlertsConfig;
    waste_threshold?: number;
}

// Optional end-of-day gentle prompt that nudges developers to self-report. Opt-in
// (disabled by default) and dismissible — never nagging. Posts to the configured
// channels (channel IDs); if none are set the prompt is effectively a no-op.
export interface SlackDailyPromptConfig {
    enabled?: boolean;
    // HH:MM in UTC. Defaults to 16:00 (end-of-day-ish) when omitted.
    time?: string;
    // Slack channel IDs (e.g. "C0123ABCD") to post the prompt into.
    channels?: string[];
}

// Slack bot for self-reporting (Task 4.2). Distinct from `alerts.slack`, which is
// an incoming-webhook for waste alerts — this is a full bot with a slash command
// and interactive forms, authenticated by a bot token + signing secret.
export interface SlackBotConfig {
    enabled?: boolean;
    // Bot user OAuth token (xoxb-…). Used to call views.open / chat.postMessage.
    bot_token?: string;
    // App signing secret. Used to verify every inbound Slack request (HMAC).
    signing_secret?: string;
    daily_prompt?: SlackDailyPromptConfig;
}

export interface DashboardAuthConfig {
    type?: string;
    // Legacy Phase 1 single admin password. Superseded by per-user accounts
    // (Task 2.2) and no longer enforced; retained so old configs still load.
    admin_password?: string;
    // Session lifetime in hours for issued login sessions.
    session_ttl_hours?: number;
    // Set the Secure flag on the session cookie. Enable this whenever the
    // dashboard is reached over HTTPS — including behind a TLS-terminating
    // proxy where the app itself binds loopback/HTTP.
    cookie_secure?: boolean;
}

export interface DashboardConfig {
    enabled?: boolean;
    auth?: DashboardAuthConfig;
}

export interface TeamConfig {
    name: string;
    department?: string;
    manager?: string;
}

export interface GovProxyConfig {
    server: ServerConfig;
    storage: StorageConfig;
    connectors: ConnectorsConfig;
    expenses: ExpensesConfig;
    aggregation: AggregationConfig;
    summaries: SummariesConfig;
    alerts: AlertsConfig;
    slack: SlackBotConfig;
    dashboard: DashboardConfig;
    teams: TeamConfig[];
}
