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
}

export interface ExpensesConfig {
    import_path?: string;
    subscription_defaults?: SubscriptionDefaultsConfig;
    column_mapping?: ColumnMappingConfig;
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
    type?: string;
    model_name?: string;
    api_key?: string;
}

export interface SummaryPeriodConfig {
    enabled?: boolean;
    auto_generate?: boolean;
    model_name?: string;
}

export interface SummariesConfig {
    enabled?: boolean;
    model?: SummaryModelConfig;
    weekly?: SummaryPeriodConfig;
    monthly?: SummaryPeriodConfig;
    quarterly?: SummaryPeriodConfig;
}

export interface SlackAlertsConfig {
    enabled?: boolean;
    webhook_url?: string;
}

export interface AlertsConfig {
    slack?: SlackAlertsConfig;
    waste_threshold?: number;
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
    dashboard: DashboardConfig;
    teams: TeamConfig[];
}
