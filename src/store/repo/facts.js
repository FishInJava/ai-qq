import { getHandle } from '../handle.js';

/**
 * 对话上下文只取尚未被用掉的当前事实，按最近有效时间倒序。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {number} [limit=5]
 */
export function listPending(store, sessionId, limit = 5) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM facts
      WHERE session_id = ? AND status = 'pending' AND valid_to IS NULL
      ORDER BY valid_from DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, limit);
}

/**
 * 同一 session + subject + key 只允许一条 valid_to 为空的行。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {string} subject
 * @param {string} key
 */
export function findActive(store, sessionId, subject, key) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM facts
      WHERE session_id = ? AND subject = ? AND key = ? AND valid_to IS NULL
      LIMIT 1
    `)
    .get(sessionId, subject, key) ?? null;
}

/**
 * @param {object} store
 * @param {{
 *   sessionId: number,
 *   subject: string,
 *   key: string,
 *   value: string,
 *   status?: string,
 *   validFrom: string,
 *   sourceMsgId?: number | null,
 * }} fact
 * @returns {number}
 */
export function insert(store, fact) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO facts
        (session_id, subject, key, value, status, valid_from, valid_to, source_msg_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `)
    .run(
      fact.sessionId,
      fact.subject,
      fact.key,
      fact.value,
      fact.status ?? 'pending',
      fact.validFrom,
      fact.sourceMsgId ?? null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * 把一条当前事实标记为过期；已经过期的不重复写。
 *
 * @param {object} store
 * @param {number} id
 * @param {string} at
 */
export function close(store, id, at) {
  getHandle(store)
    .prepare('UPDATE facts SET valid_to = ? WHERE id = ? AND valid_to IS NULL')
    .run(at, id);
}

/**
 * 同一个值再次出现时只刷新有效时间，并重新变回待用。
 *
 * @param {object} store
 * @param {number} id
 * @param {string} at
 */
export function touch(store, id, at) {
  getHandle(store)
    .prepare("UPDATE facts SET valid_from = ?, status = 'pending' WHERE id = ?")
    .run(at, id);
}

/**
 * 主动消息提交前复核锚点仍然待用。
 *
 * @param {object} store
 * @param {number} id
 */
export function findById(store, id) {
  return getHandle(store).prepare('SELECT * FROM facts WHERE id = ?').get(id) ?? null;
}

/**
 * 主动消息用掉一条事实后，它从“待用”退场；仍可被关键词检索命中。
 *
 * @param {object} store
 * @param {number} id
 */
export function markDone(store, id) {
  getHandle(store)
    .prepare("UPDATE facts SET status = 'done' WHERE id = ? AND status = 'pending'")
    .run(id);
}

/**
 * 记忆抽屉要看到历史版本，包括已经过期的行。
 *
 * @param {object} store
 * @param {number} sessionId
 */
export function listAll(store, sessionId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM facts
      WHERE session_id = ?
      ORDER BY valid_from DESC, id DESC
    `)
    .all(sessionId);
}

/**
 * 关键词检索包含过期事实；被显式丢掉的记忆不再命中。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {string} pattern
 * @param {number} limit
 */
export function search(store, sessionId, pattern, limit) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM facts
      WHERE session_id = ?
        AND status != 'dropped'
        AND (key LIKE ? OR value LIKE ?)
      ORDER BY valid_from DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, pattern, pattern, limit);
}

/**
 * @param {object} store
 * @param {number} id
 * @returns {number} 删除的行数
 */
export function remove(store, id) {
  const result = getHandle(store).prepare('DELETE FROM facts WHERE id = ?').run(id);
  return Number(result.changes);
}
