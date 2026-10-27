import { getHandle } from '../handle.js';

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

export function listAfter(store, sessionId, afterId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND id > ?
      ORDER BY id ASC
    `)
    .all(sessionId, afterId);
}

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
