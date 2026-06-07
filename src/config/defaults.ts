import type { GovProxyConfig } from './types';

export const defaultConfig: GovProxyConfig = {
    server: {
        port: 8080,
        host: '0.0.0.0',
    },
    storage: {
        type: 'sqlite',
        sqlite_path: './data/govproxy.db',
    },
    connectors: {
        copilot: { enabled: false, sync_interval: 'daily', sync_time: '02:00' },
        claude_code: { enabled: false, sync_interval: 'daily', sync_time: '02:30' },
        windsurf: { enabled: false, sync_interval: 'daily', sync_time: '03:00' },
        cursor: { enabled: false, sync_interval: 'daily', sync_time: '03:15' },
        git: { enabled: false, sync_interval: 'daily', sync_time: '03:30', repos: [] },
    },
    expenses: {
        import_path: './data/expenses/',
        subscription_defaults: {
            copilot_business: 19,
            copilot_enterprise: 39,
            cursor_pro: 20,
            cursor_business: 40,
            claude_code_pro: 20,
            claude_code_max: 200,
            windsurf_pro: 20,
            windsurf_teams: 40,
        },
    },
    aggregation: {
        weekly: { day: 'monday', time: '04:00' },
        monthly: { day: 1, time: '04:30' },
        quarterly: { time: '05:00' },
        daily_retention_days: 90,
    },
    summaries: {
        enabled: false,
        // Default to a LOCAL model (Ollama) for privacy — the model only ever
        // receives aggregate numbers, and keeping it local guarantees no data
        // leaves the network. The base model_name is the larger, higher-quality
        // local model used for the executive-facing levels (monthly+); see
        // docs/summaries-model.md for the model choice and infra requirements.
        model: {
            type: 'ollama',
            endpoint: 'http://localhost:11434',
            model_name: 'llama3.1:70b',
        },
        // Weekly overrides to a small/fast local model — short, frequent output
        // where quality matters less than turnaround. Monthly/quarterly/yearly
        // inherit the larger base model.
        weekly: { enabled: true, auto_generate: true, model_name: 'llama3.1:8b' },
        monthly: { enabled: true, auto_generate: true },
        quarterly: { enabled: true, auto_generate: true },
        yearly: { enabled: true, auto_generate: false },
    },
    alerts: {
        slack: { enabled: false },
        waste_threshold: 14,
    },
    dashboard: {
        enabled: true,
        auth: { type: 'session', session_ttl_hours: 168, cookie_secure: false },
    },
    teams: [],
};
