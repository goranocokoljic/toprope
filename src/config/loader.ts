import fs from 'fs';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { configSchema } from './schema';
import { defaultConfig } from './defaults';
import type { GovProxyConfig } from './types';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(configSchema);

function expandEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvVars(v)]),
    );
  }
  return value;
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as Array<keyof T>) {
    const overrideVal = override[key];
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}

export function loadConfig(configPath: string): GovProxyConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid config: file must contain a YAML object');
  }

  const expanded = expandEnvVars(parsed) as Record<string, unknown>;
  const merged = deepMerge(defaultConfig as unknown as Record<string, unknown>, expanded);

  const valid = validate(merged);
  if (!valid) {
    const messages = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || '(root)'} ${e.message ?? ''}`)
      .join('\n');
    throw new Error(`Invalid config:\n${messages}`);
  }

  return merged as unknown as GovProxyConfig;
}
