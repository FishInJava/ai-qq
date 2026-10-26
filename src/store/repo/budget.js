import { getHandle } from '../handle.js';

/**
 * 某天某会话已用的主动消息数。
 *
 * @param {object} store
 * @param {string} date 本地日 YYYY-MM-DD
 * @param {number} sessionId
 * @returns {number}
 */
export function usedOn(store, date, sessionId) {
  const row = getHandle(store)
    .prepare('SELECT used FROM daily_budget WHERE date = ? AND session_id = ?')
    .get(date, sessionId);
  return Number(row?.used ?? 0);
}

/**
 * 某天全局已用的主动消息数。
 *
 * @param {object} store
 * @param {string} date
 * @returns {number}
 */
export function globalUsedOn(store, date) {
  const row = getHandle(store)
    .prepare('SELECT COALESCE(SUM(used), 0) AS used FROM daily_budget WHERE date = ?')
    .get(date);
  return Number(row?.used ?? 0);
}

/**
 * @param {object} store
 * @param {string} date
 * @param {number} sessionId
 * @param {number} [amount=1]
 */
export function increment(store, date, sessionId, amount = 1) {
  getHandle(store)
    .prepare(`
      INSERT INTO daily_budget (date, session_id, used)
      VALUES (?, ?, ?)
      ON CONFLICT (date, session_id) DO UPDATE SET used = used + excluded.used
    `)
    .run(date, sessionId, amount);
}
