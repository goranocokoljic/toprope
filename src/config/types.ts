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

export interface ExpensesConfig {
    import_path?: string;
    subscription_defaults?: SubscriptionDefaultsConfig;
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
    admin_password?: string;
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
