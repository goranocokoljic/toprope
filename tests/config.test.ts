import { describe, it, expect } from 'vitest';
import path from 'path';
import { loadConfig } from '../src/config/loader';

const fixtures = path.resolve(__dirname, 'fixtures');

describe('loadConfig', () => {
    it('loads and returns a valid config file', () => {
        const config = loadConfig(path.join(fixtures, 'minimal-config.yaml'));
        expect(config.server.port).toBe(9090);
        expect(config.server.host).toBe('127.0.0.1');
        expect(config.storage.type).toBe('sqlite');
    });

    it('merges loaded config with defaults', () => {
        const config = loadConfig(path.join(fixtures, 'minimal-config.yaml'));
        expect(config.alerts.waste_threshold).toBe(14);
        expect(config.expenses.subscription_defaults?.copilot_business).toBe(19);
    });

    it('loads the main toprope.config.yaml successfully', () => {
        const configPath = path.resolve(process.cwd(), 'toprope.config.yaml');
        const config = loadConfig(configPath);
        expect(config.server.port).toBe(8080);
        expect(config.teams).toHaveLength(2);
    });

    it('throws a clear error when port is not a number', () => {
        expect(() => loadConfig(path.join(fixtures, 'invalid-config.yaml'))).toThrow(/Invalid config/);
    });

    it('throws when config file does not exist', () => {
        expect(() => loadConfig('/nonexistent/path/config.yaml')).toThrow(/not found/);
    });
});
