import { getHandle } from '../handle.js';

export function insert(store, entry) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO proactive_log (session_id, content, fingerprint, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(entry.sessionId, entry.content, entry.fingerprint, entry.createdAt);
  return Number(result.lastInsertRowid);
}

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
