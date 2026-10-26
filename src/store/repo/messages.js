import { getHandle } from '../handle.js';

/**
 * @param {object} store
 * @param {number} sessionId
 */
export function lastForSession(store, sessionId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .get(sessionId) ?? null;
}

/**
 * 最近一条指定角色的消息时间；用于判断续额后的“好转”是否还没被下一句消费。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {'user' | 'char' | 'system_note'} role
 * @returns {string | null}
 */
export function lastCreatedAtForRole(store, sessionId, role) {
  const row = getHandle(store)
    .prepare(`
      SELECT created_at FROM messages
      WHERE session_id = ? AND role = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .get(sessionId, role);
  return row?.created_at ?? null;
}

/**
 * @param {object} store
 * @param {number} sessionId
 * @param {{ before?: number, limit?: number }} [options]
 */
export function listForSession(store, sessionId, { before = null, limit = 50 } = {}) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND (? IS NULL OR id < ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, before, before, limit);
}

/**
 * 记忆抽取只读本轮涉及的几条消息。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {number[]} ids
 */
export function listByIds(store, sessionId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => '?').join(', ');
  return getHandle(store)
    .prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND id IN (${placeholders})
      ORDER BY id ASC
    `)
    .all(sessionId, ...ids);
}

/**
 * 摘要按 id 向后取，返回时间正序。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {number} afterId
 */
export function listAfter(store, sessionId, afterId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND id > ?
      ORDER BY id ASC
    `)
    .all(sessionId, afterId);
}

/**
 * @param {object} store
 * @param {{
 *   sessionId: number,
 *   role: string,
 *   content: string,
 *   isProactive?: number,
 *   anchorType?: string | null,
 *   anchorId?: number | null,
 *   bubbleIndex?: number | null,
 *   tokens?: number | null,
 *   estimated?: number,
 *   incomplete?: number,
 *   styleFlags?: string | null,
 *   createdAt: string,
 * }} message
 * @returns {number}
 */
export function insert(store, message) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO messages
        (session_id, role, content, is_proactive, anchor_type, anchor_id,
         bubble_index, tokens, estimated, incomplete, style_flags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      message.sessionId,
      message.role,
      message.content,
      message.isProactive ?? 0,
      message.anchorType ?? null,
      message.anchorId ?? null,
      message.bubbleIndex ?? null,
      message.tokens ?? null,
      message.estimated ?? 0,
      message.incomplete ?? 0,
      message.styleFlags ?? null,
      message.createdAt,
    );
  return Number(result.lastInsertRowid);
}
