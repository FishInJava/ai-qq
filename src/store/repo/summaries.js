import { getHandle } from '../handle.js';

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

export function listAll(store, sessionId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM summaries
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `)
    .all(sessionId);
}

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
