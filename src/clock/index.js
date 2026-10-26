const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseHhmm(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm));
  if (!match) {
    throw new TypeError(`时间格式必须是 HH:mm，收到：${hhmm}`);
  }
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * 本地日期字符串 → 当天零点 epoch ms；非法日期返回 NaN。
 * 只在这里把 YYYY-MM-DD 换成本地时区，别处不要自己拼 Date。
 *
 * @param {string} day
 * @returns {number}
 */
function localDayStartMs(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!match) {
    return Number.NaN;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const value = new Date(year, month - 1, date, 0, 0, 0, 0);
  if (
    value.getFullYear() !== year
    || value.getMonth() !== month - 1
    || value.getDate() !== date
  ) {
    return Number.NaN;
  }
  return value.getTime();
}

/**
 * 全仓唯一时间源。生产实现注入 Date.now，测试实现注入可推进的假时钟。
 *
 * @param {{ now?: () => number }} [options]
 */
export function createClock({ now = () => Date.now() } = {}) {
  const timers = new Map();
  let timerSeq = 1;

  return {
    /** @returns {number} epoch ms */
    now,

    /**
     * @param {number} [ms]
     * @returns {string} UTC ISO8601，入库唯一格式
     */
    iso(ms = now()) {
      return new Date(ms).toISOString();
    },

    /**
     * 本地日界只在这里换算。
     *
     * @param {number} [ms]
     * @returns {string} YYYY-MM-DD
     */
    localDay(ms = now()) {
      const date = new Date(ms);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    },

    /**
     * 本地日零点；非法日期返回 NaN，由调用方决定报什么错。
     *
     * @param {string} day YYYY-MM-DD
     * @returns {number}
     */
    startOfLocalDay(day) {
      return localDayStartMs(day);
    },

    /**
     * 本地日的下一天零点；用于半开区间 [from, to)。
     *
     * @param {string} day YYYY-MM-DD
     * @returns {number}
     */
    nextLocalDayStart(day) {
      const start = localDayStartMs(day);
      if (!Number.isFinite(start)) {
        return Number.NaN;
      }
      const value = new Date(start);
      value.setDate(value.getDate() + 1);
      return value.getTime();
    },

    /**
     * UTC ISO8601 → epoch ms；非法输入返回 NaN。
     *
     * @param {string} iso
     * @returns {number}
     */
    parseIso(iso) {
      return Date.parse(iso);
    },

    /**
     * UTC ISO8601 → 本地日；非法输入返回 null。
     *
     * @param {string} iso
     * @returns {string | null}
     */
    localDayOfIso(iso) {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) {
        return null;
      }
      const date = new Date(ms);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    },

    /**
     * UTC ISO8601 → 本地 HH:mm；非法输入返回 null。
     * 页面只渲染这个字符串，不自己算时间（硬规则 1）。
     *
     * @param {string} iso
     * @returns {string | null}
     */
    localClockText(iso) {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) {
        return null;
      }
      const date = new Date(ms);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    },
    /**
     * @param {number} [ms]
     * @returns {number} 当日本地分钟数（08:30 → 510）
     */
    localTimeMinutes(ms = now()) {
      const date = new Date(ms);
      return date.getHours() * 60 + date.getMinutes();
    },

    /**
     * 距下一次本地 hh:mm 的毫秒数；今天已过则算到明天。
     *
     * @param {string} hhmm
     * @param {number} [ms]
     * @returns {number}
     */
    untilNext(hhmm, ms = now()) {
      const { hours, minutes } = parseHhmm(hhmm);
      const target = new Date(ms);
      target.setHours(hours, minutes, 0, 0);
      let delta = target.getTime() - ms;
      if (delta <= 0) {
        delta += DAY_MS;
      }
      return delta;
    },

    /**
     * 生产实现用 setTimeout；测试实现可换成可控堆。
     *
     * @param {() => void} fn
     * @param {number} ms
     * @returns {number}
     */
    setTimer(fn, ms) {
      const id = timerSeq;
      timerSeq += 1;
      const handle = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.set(id, handle);
      return id;
    },

    /** @param {number} id */
    clearTimer(id) {
      const handle = timers.get(id);
      if (handle !== undefined) {
        clearTimeout(handle);
        timers.delete(id);
      }
    },

    clearAllTimers() {
      for (const handle of timers.values()) {
        clearTimeout(handle);
      }
      timers.clear();
    },
  };
}

/** 生产时钟：系统时间 + 真实 setTimeout。 */
export const systemClock = createClock();
