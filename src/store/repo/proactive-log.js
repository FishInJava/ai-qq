import { getHandle } from '../handle.js';

/**
 * 主动消息留痕：内容 + 前 8 字指纹。V1.0 不靠它拦截重复，只用于抽屉与后续版本。
 *
 * @param {object} store
 * @param {{ sessionId: number, content: string, fingerprint: string, createdAt: string }} entry
 * @returns {number}
 */
export function insert(store, entry) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO proactive_log (session_id, content, fingerprint, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(entry.sessionId, entry.content, entry.fingerprint, entry.createdAt);
  return Number(result.lastInsertRowid);
}

/**
 * @param {object} store
 * @param {number} sessionId
 * @param {number} [limit=20]
 */
export function listRecent(store, sessionId, limit = 20) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM proactive_log
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, limit);
}
