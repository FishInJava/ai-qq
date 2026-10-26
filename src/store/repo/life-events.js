import { getHandle } from '../handle.js';

/**
 * 某会话某本地日的全部生活事件，按 ordinal 正序。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {string} day YYYY-MM-DD（本地日）
 */
export function listForDay(store, sessionId, day) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM life_events
      WHERE session_id = ? AND event_date = ?
      ORDER BY ordinal ASC, id ASC
    `)
    .all(sessionId, day);
}

/**
 * 今日还没被主动消息用掉的事件，锚点候选从这里来。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {string} day
 */
export function listUnusedForDay(store, sessionId, day) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM life_events
      WHERE session_id = ? AND event_date = ? AND used_by_msg_id IS NULL
      ORDER BY ordinal ASC, id ASC
    `)
    .all(sessionId, day);
}

/**
 * @param {object} store
 * @param {number} sessionId
 * @param {string} day
 * @returns {number}
 */
export function countForDay(store, sessionId, day) {
  const row = getHandle(store)
    .prepare('SELECT COUNT(*) AS n FROM life_events WHERE session_id = ? AND event_date = ?')
    .get(sessionId, day);
  return Number(row?.n ?? 0);
}

/**
 * @param {object} store
 * @param {{
 *   sessionId: number,
 *   eventDate: string,
 *   ordinal: number,
 *   content: string,
 *   createdAt: string,
 * }} event
 * @returns {number}
 */
export function insert(store, event) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO life_events (session_id, event_date, ordinal, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(event.sessionId, event.eventDate, event.ordinal, event.content, event.createdAt);
  return Number(result.lastInsertRowid);
}

/**
 * 主动消息提交时把用掉的事件标记下来，同日不再复用。
 *
 * @param {object} store
 * @param {number} id
 * @param {number} messageId
 */
export function markUsed(store, id, messageId) {
  getHandle(store)
    .prepare('UPDATE life_events SET used_by_msg_id = ? WHERE id = ?')
    .run(messageId, id);
}
