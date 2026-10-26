import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';

/** @typedef {typeof DEFAULT_CONFIG} CompanionConfig */

export const DEFAULT_CONFIG = Object.freeze({
  server: { port: 3000, host: '127.0.0.1' },
  llm: {
    base_url: '',
    api_key: '',
    chat_model: '',
    utility_model: '',
    chat_timeout_ms: 30000,
    utility_timeout_ms: 10000,
    context_budget: 8000,
    proactive_context_budget: 2000,
  },
  schedule: {
    tick_min: 20,
    tick_max: 40,
    hard_trigger_hours: 6,
    cooldown_min: 15,
    willingness_threshold: 0.6,
    ignored_multiplier: 1.5,
  },
  budget: { daily_global: 5, per_session: 2 },
  quota: { default_token_limit: 500000, warn_ratio: 0.7 },
  living: { life_event_time: '09:00', feeds_time: '08:30', city: null },
  runtime: { cold_start_proactive: false, autostart: true, test_hooks: false },
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (!isPlainObject(override)) {
    return base;
  }
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      mergeConfig(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function validateConfig(config) {
  if (config.server.host !== '127.0.0.1') {
    throw new AppError('config_invalid', '服务只能监听 127.0.0.1，请修正配置文件', { status: 500 });
  }
  if (!Number.isInteger(config.server.port) || config.server.port < 0 || config.server.port > 65535) {
    throw new AppError('config_invalid', '端口必须是 0–65535 的整数', { status: 500 });
  }
  if (config.runtime.test_hooks !== true && config.runtime.test_hooks !== false) {
    throw new AppError('config_invalid', 'runtime.test_hooks 必须是布尔值', { status: 500 });
  }
}

/**
 * 首次启动生成配置；已有配置只补默认值，不删除未知字段。
 *
 * @param {{ dataDir: string }} options
 * @returns {{ config: CompanionConfig, configPath: string }}
 */
export function loadConfig({ dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  let fileConfig = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new AppError('config_invalid', '配置文件不是有效的 JSON，请修正后重启', { cause: err });
    }
    if (!isPlainObject(fileConfig)) {
      throw new AppError('config_invalid', '配置文件顶层必须是一个对象', { status: 500 });
    }
  }

  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), fileConfig);
  validateConfig(config);

  if (!existsSync(configPath)) {
    writeJsonAtomic(configPath, config);
  }

  return { config, configPath };
}

/**
 * 先写临时文件再替换；Windows 下 rename 覆盖已存在文件会失败，退回直接写。
 *
 * @param {string} target
 * @param {unknown} value
 */
export function writeJsonAtomic(target, value) {
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, target);
  } catch {
    // Windows 下目标已存在时 rename 会失败；直接覆盖并清理临时文件。
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    rmSync(tmp, { force: true });
  }
}

function maskApiKey(value) {
  if (typeof value !== 'string' || value === '') {
    return '';
  }
  return `****${value.slice(-4)}`;
}

function invalid(message) {
  return new AppError('config_invalid', message, { status: 400 });
}

function assertKnownKeys(patch, defaults, prefix = '') {
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(defaults, key)) {
      throw invalid(`未知配置项：${prefix}${key}`);
    }
    if (isPlainObject(defaults[key]) && !isPlainObject(value)) {
      throw invalid(`${prefix}${key} 必须是一个对象`);
    }
    if (isPlainObject(value) && isPlainObject(defaults[key])) {
      assertKnownKeys(value, defaults[key], `${prefix}${key}.`);
    }
  }
}

function assertBoolean(value, name) {
  if (value !== true && value !== false) {
    throw invalid(`${name} 必须是布尔值`);
  }
}

function assertString(value, name, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw invalid(`${name} 必须是字符串`);
  }
}

function assertInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${name} 必须是 ${min}–${max} 的整数`);
  }
}

function assertNumber(value, name, min, max = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(`${name} 必须是 ${min}–${max} 之间的数字`);
  }
}

function assertHhmm(value, name) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw invalid(`${name} 必须是 HH:mm`);
  }
}

/**
 * PUT /api/config 的字段级校验；失败一律 400，不写盘。
 *
 * @param {object} config
 */
function validateUpdate(config) {
  if (config.server.host !== '127.0.0.1') {
    throw invalid('服务只能监听 127.0.0.1');
  }
  assertInteger(config.server.port, 'server.port', 0, 65535);

  assertString(config.llm.base_url, 'llm.base_url');
  assertString(config.llm.api_key, 'llm.api_key');
  assertString(config.llm.chat_model, 'llm.chat_model');
  assertString(config.llm.utility_model, 'llm.utility_model');
  assertInteger(config.llm.chat_timeout_ms, 'llm.chat_timeout_ms', 1, 600000);
  assertInteger(config.llm.utility_timeout_ms, 'llm.utility_timeout_ms', 1, 600000);
  assertInteger(config.llm.context_budget, 'llm.context_budget', 1, 1000000);
  assertInteger(config.llm.proactive_context_budget, 'llm.proactive_context_budget', 1, 1000000);

  assertNumber(config.schedule.tick_min, 'schedule.tick_min', 1);
  assertNumber(config.schedule.tick_max, 'schedule.tick_max', 1);
  if (config.schedule.tick_max < config.schedule.tick_min) {
    throw invalid('schedule.tick_max 不能小于 tick_min');
  }
  assertNumber(config.schedule.hard_trigger_hours, 'schedule.hard_trigger_hours', 1);
  assertNumber(config.schedule.cooldown_min, 'schedule.cooldown_min', 0);
  assertNumber(config.schedule.willingness_threshold, 'schedule.willingness_threshold', 0, 1);
  assertNumber(config.schedule.ignored_multiplier, 'schedule.ignored_multiplier', 1);

  assertInteger(config.budget.daily_global, 'budget.daily_global', 0, 1000);
  assertInteger(config.budget.per_session, 'budget.per_session', 0, 1000);
  assertInteger(config.quota.default_token_limit, 'quota.default_token_limit', 1, 10000000);
  assertNumber(config.quota.warn_ratio, 'quota.warn_ratio', 0, 1);

  assertHhmm(config.living.life_event_time, 'living.life_event_time');
  assertHhmm(config.living.feeds_time, 'living.feeds_time');
  if (config.living.city !== null && typeof config.living.city !== 'string') {
    throw invalid('living.city 必须是字符串或 null');
  }

  assertBoolean(config.runtime.cold_start_proactive, 'runtime.cold_start_proactive');
  assertBoolean(config.runtime.autostart, 'runtime.autostart');
  assertBoolean(config.runtime.test_hooks, 'runtime.test_hooks');
}

/**
 * 配置读写服务：GET 只给脱敏视图，PUT 只接受已知字段并原子落盘。
 *
 * @param {{ config: object, configPath: string, log?: object }} options
 */
export function createConfigService({ config, configPath, log }) {
  function view() {
    const snapshot = structuredClone(config);
    snapshot.llm.api_key = maskApiKey(config.llm.api_key);
    return snapshot;
  }

  function update(patch) {
    if (!isPlainObject(patch)) {
      throw invalid('配置必须是一个对象');
    }
    assertKnownKeys(patch, DEFAULT_CONFIG);

    const normalized = structuredClone(patch);
    if (isPlainObject(normalized.llm) && normalized.llm.api_key === '') {
      delete normalized.llm.api_key;
    }

    const merged = mergeConfig(structuredClone(config), normalized);
    validateUpdate(merged);

    const restartRequired = merged.server.port !== config.server.port
      || merged.runtime.test_hooks !== config.runtime.test_hooks;

    try {
      writeJsonAtomic(configPath, merged);
    } catch (err) {
      throw new AppError('config_save_failed', '配置没能保存，请检查数据目录权限', {
        status: 500,
        cause: err,
      });
    }

    for (const key of Object.keys(merged)) {
      config[key] = merged[key];
    }
    log?.info('config_updated', { restart_required: restartRequired });

    return { config: view(), restart_required: restartRequired };
  }

  return { view, update };
}
