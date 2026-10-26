import { getHandle } from '../handle.js';

/**
 * 最近几条摘要；调用方负责反转成时间正序。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {number} [limit=3]
 */
export function listRecent(store, sessionId, limit = 3) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM summaries
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, limit);
}

/**
 * @param {object} store
 * @param {number} sessionId
 */
export function lastForSession(store, sessionId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM summaries
      WHERE session_id = ?
      ORDER BY to_msg_id DESC, id DESC
      LIMIT 1
    `)
    .get(sessionId) ?? null;
}

/**
 * 记忆抽屉按时间正序展示。
 *
 * @param {object} store
 * @param {number} sessionId
 */
export function listAll(store, sessionId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM summaries
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `)
    .all(sessionId);
}

/**
 * @param {object} store
 * @param {{
 *   sessionId: number,
 *   fromMsgId: number,
 *   toMsgId: number,
 *   content: string,
 *   createdAt: string,
 * }} summary
 * @returns {number}
 */
export function insert(store, summary) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO summaries (session_id, from_msg_id, to_msg_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      summary.sessionId,
      summary.fromMsgId,
      summary.toMsgId,
      summary.content,
      summary.createdAt,
    );
  return Number(result.lastInsertRowid);
}

/**
 * @param {object} store
 * @param {number} sessionId
 * @param {string} pattern
 * @param {number} limit
 */
export function search(store, sessionId, pattern, limit) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM summaries
      WHERE session_id = ? AND content LIKE ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, pattern, limit);
}
