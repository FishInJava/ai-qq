import { getHandle } from '../handle.js';

export function listForDay(store, sessionId, day) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM life_events
      WHERE session_id = ? AND event_date = ?
      ORDER BY ordinal ASC, id ASC
    `)
    .all(sessionId, day);
}

export function listUnusedForDay(store, sessionId, day) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM life_events
      WHERE session_id = ? AND event_date = ? AND used_by_msg_id IS NULL
      ORDER BY ordinal ASC, id ASC
    `)
    .all(sessionId, day);
}

export function countForDay(store, sessionId, day) {
  const row = getHandle(store)
    .prepare('SELECT COUNT(*) AS n FROM life_events WHERE session_id = ? AND event_date = ?')
    .get(sessionId, day);
  return Number(row?.n ?? 0);
}

export function insert(store, event) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO life_events (session_id, event_date, ordinal, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(event.sessionId, event.eventDate, event.ordinal, event.content, event.createdAt);
  return Number(result.lastInsertRowid);
}

export function markUsed(store, id, messageId) {
  getHandle(store)
    .prepare('UPDATE life_events SET used_by_msg_id = ? WHERE id = ?')
    .run(messageId, id);
}
