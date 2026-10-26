import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayStamp(day) {
  return day.replaceAll('-', '');
}

function redactValue(key, value) {
  if (/api[_-]?key|authorization|secret/i.test(key) && typeof value === 'string') {
    return `***${value.slice(-4)}`;
  }
  return value;
}

function redact(input, depth = 0) {
  if (depth > 4 || input === null || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redact(item, depth + 1));
  }
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    const redacted = redactValue(key, value);
    output[key] = redacted === value ? redact(value, depth + 1) : redacted;
  }
  return output;
}

function safeJson(value) {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * 自建日志：按本地日分文件，10MB 轮转，保留 7 天；事件另写 events.jsonl。
 *
 * @param {{ dataDir: string, clock: import('../clock/index.js').Clock }} options
 */
export function createLog({ dataDir, clock }) {
  const logDir = path.join(dataDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const eventsPath = path.join(logDir, 'events.jsonl');

  const currentPath = () => path.join(logDir, `app-${dayStamp(clock.localDay())}.log`);

  function cleanupOldLogs() {
    const cutoff = clock.localDay(clock.now() - KEEP_DAYS * DAY_MS).replaceAll('-', '');
    for (const file of readdirSync(logDir)) {
      const match = /^app-(\d{8})(?:-\d+)?\.log$/.exec(file);
      if (!match) {
        continue;
      }
      if (match[1] < cutoff) {
        try {
          unlinkSync(path.join(logDir, file));
        } catch {
          // 清理失败不影响主流程；下次启动继续尝试。
          continue;
        }
      }
    }
  }

  function rotateIfNeeded(file) {
    if (!existsSync(file) || statSync(file).size <= MAX_LOG_BYTES) {
      return;
    }
    let index = 1;
    while (existsSync(`${file}.${index}`)) {
      index += 1;
    }
    renameSync(file, `${file}.${index}`);
  }

  function write(level, message, fields) {
    const file = currentPath();
    const suffix = fields === undefined ? '' : ` ${safeJson(fields)}`;
    appendFileSync(file, `${clock.iso()} ${level.toUpperCase()} ${message}${suffix}\n`, 'utf8');
    rotateIfNeeded(file);
  }

  cleanupOldLogs();

  return {
    dir: logDir,

    /** @param {string} message @param {object} [fields] */
    info(message, fields) {
      write('info', message, fields);
    },

    /** @param {string} message @param {object} [fields] */
    warn(message, fields) {
      write('warn', message, fields);
    },

    /** @param {string} message @param {object} [fields] */
    error(message, fields) {
      write('error', message, fields);
    },

    /**
     * 事件名严格照 PRD 4.2；属性只写 id、长度、耗时、决策原因。
     *
     * @param {string} name
     * @param {object} [props]
     */
    event(name, props = {}) {
      appendFileSync(
        eventsPath,
        `${JSON.stringify({ at: clock.iso(), event: name, ...redact(props) })}\n`,
        'utf8',
      );
    },

    close() {
      // appendFileSync 无缓冲，无需 flush；保留方法给 runtime 统一收尾。
    },
  };
}
