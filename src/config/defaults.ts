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
        model: {
            type: 'anthropic',
            model_name: 'claude-haiku-4-5-20251001',
        },
        weekly: { enabled: true, auto_generate: true },
        monthly: { enabled: true, auto_generate: true, model_name: 'claude-sonnet-4-20250514' },
        quarterly: { enabled: true, auto_generate: true, model_name: 'claude-sonnet-4-20250514' },
    },
    alerts: {
        slack: { enabled: false },
        waste_threshold: 14,
    },
    dashboard: {
        enabled: true,
        auth: { type: 'basic' },
    },
    teams: [],
};
