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

export function createClock({ now = () => Date.now() } = {}) {
  const timers = new Map();
  let timerSeq = 1;

  return {
    now,

    iso(ms = now()) {
      return new Date(ms).toISOString();
    },

    localDay(ms = now()) {
      const date = new Date(ms);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    },

    startOfLocalDay(day) {
      return localDayStartMs(day);
    },

    nextLocalDayStart(day) {
      const start = localDayStartMs(day);
      if (!Number.isFinite(start)) {
        return Number.NaN;
      }
      const value = new Date(start);
      value.setDate(value.getDate() + 1);
      return value.getTime();
    },

    parseIso(iso) {
      return Date.parse(iso);
    },

    localDayOfIso(iso) {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) {
        return null;
      }
      const date = new Date(ms);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    },

    localClockText(iso) {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) {
        return null;
      }
      const date = new Date(ms);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    },

    localTimeMinutes(ms = now()) {
      const date = new Date(ms);
      return date.getHours() * 60 + date.getMinutes();
    },

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

export const systemClock = createClock();
