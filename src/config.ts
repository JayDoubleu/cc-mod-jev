import { DEFAULT_MODEL, OPENROUTER_DECISIONS_URL } from './openrouter.ts';

export type LogSink = 'transcript' | 'debug';

export type Config = {
  apiKey?: string;
  model: string;
  baseUrl: string;
  goal?: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  minPairChars: number;
  truncateHeadChars: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  compactAtPercent: number;
  minReductionRatio: number;
  gate: boolean;
  gateTools: string[];
  gateMinChars: number;
  gateThreshold: number;
  gateHeadChars: number;
  gateTailChars: number;
  log: LogSink;
};

export const DEFAULT_CONFIG: Config = {
  model: DEFAULT_MODEL,
  baseUrl: OPENROUTER_DECISIONS_URL,
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  minPairChars: 300,
  truncateHeadChars: 300,
  maxStateTokens: 20000,
  maxRequestTokens: 28000,
  compactAtPercent: 60,
  minReductionRatio: 0.2,
  gate: false,
  gateTools: ['Bash'],
  gateMinChars: 8000,
  gateThreshold: 0.3,
  gateHeadChars: 2500,
  gateTailChars: 1500,
  log: 'transcript',
};

/** The keys an environment variable may override, `JEV_CONTEXT_<KEY>` or `EVAL_JEV_CONTEXT_<KEY>`. */
export const CONFIG_KEYS = [
  'model',
  'baseUrl',
  'goal',
  'keepThreshold',
  'preserveRecentMessages',
  'minPairChars',
  'truncateHeadChars',
  'maxStateTokens',
  'maxRequestTokens',
  'compactAtPercent',
  'minReductionRatio',
  'gate',
  'gateTools',
  'gateMinChars',
  'gateThreshold',
  'gateHeadChars',
  'gateTailChars',
  'log',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const API_KEY_VARIABLES = ['OPENROUTER_API_KEY', 'EVAL_OPENROUTER_API_KEY'] as const;

export function envName(key: ConfigKey, prefix = ''): string {
  return `${prefix}JEV_CONTEXT_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

/** Every environment variable the plugin reads. */
export function envNames(): string[] {
  const names: string[] = [...API_KEY_VARIABLES];
  for (const key of CONFIG_KEYS) names.push(envName(key), envName(key, 'EVAL_'));
  return names;
}

type Raw = string | number | boolean | readonly string[] | undefined;

function asNumber(value: Raw): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: Raw): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(lowered)) return true;
    if (['0', 'false', 'off', 'no', ''].includes(lowered)) return false;
  }
  return undefined;
}

function asList(value: Raw): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

function asString(value: Raw): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The plugin's configuration: the manifest's `userConfig` values, overridden
 * by `JEV_CONTEXT_*` and then `EVAL_JEV_CONTEXT_*` environment variables (the
 * latter so a plugin eval can configure a run); a variable set to the empty
 * string counts as unset. The API key comes from the
 * `apiKey` option, else `OPENROUTER_API_KEY`, else `EVAL_OPENROUTER_API_KEY`.
 */
export function resolveConfig(
  options: Readonly<Record<string, Raw>>,
  env: Readonly<Record<string, string | undefined>>,
): Config {
  const set = (value: string | undefined): string | undefined =>
    value !== undefined && value.trim() !== '' ? value : undefined;
  const raw = (key: ConfigKey): Raw =>
    set(env[envName(key, 'EVAL_')]) ?? set(env[envName(key)]) ?? options[key];
  const config: Config = { ...DEFAULT_CONFIG, gateTools: [...DEFAULT_CONFIG.gateTools] };
  const apiKey = asString(options.apiKey) ?? asString(env.OPENROUTER_API_KEY) ?? asString(env.EVAL_OPENROUTER_API_KEY);
  if (apiKey) config.apiKey = apiKey;
  config.model = asString(raw('model')) ?? config.model;
  config.baseUrl = asString(raw('baseUrl')) ?? config.baseUrl;
  const goal = asString(raw('goal'));
  if (goal) config.goal = goal;
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'minPairChars',
    'truncateHeadChars',
    'maxStateTokens',
    'maxRequestTokens',
    'compactAtPercent',
    'minReductionRatio',
    'gateMinChars',
    'gateThreshold',
    'gateHeadChars',
    'gateTailChars',
  ] as const) {
    const value = asNumber(raw(key));
    if (value !== undefined) config[key] = value;
  }
  config.gate = asBoolean(raw('gate')) ?? config.gate;
  config.gateTools = asList(raw('gateTools')) ?? config.gateTools;
  const log = asString(raw('log'));
  if (log === 'transcript' || log === 'debug') config.log = log;
  return config;
}

/** The configuration as one line, for `/jev`. */
export function describeConfig(config: Config): string {
  const parts = [
    `model=${config.model}`,
    `key=${config.apiKey ? 'set' : 'MISSING'}`,
    `keepThreshold=${config.keepThreshold}`,
    `preserveRecent=${config.preserveRecentMessages}`,
    `compactAt=${config.compactAtPercent}%`,
    `minReduction=${Math.round(config.minReductionRatio * 100)}%`,
    `gate=${config.gate ? `on(${config.gateTools.join(',')} ≥${config.gateMinChars}ch <${config.gateThreshold})` : 'off'}`,
  ];
  return parts.join(' ');
}
