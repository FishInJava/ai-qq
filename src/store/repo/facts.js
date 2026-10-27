import { getHandle } from '../handle.js';

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

export function findActive(store, sessionId, subject, key) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM facts
      WHERE session_id = ? AND subject = ? AND key = ? AND valid_to IS NULL
      LIMIT 1
    `)
    .get(sessionId, subject, key) ?? null;
}

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

export function close(store, id, at) {
  getHandle(store)
    .prepare('UPDATE facts SET valid_to = ? WHERE id = ? AND valid_to IS NULL')
    .run(at, id);
}

export function touch(store, id, at) {
  getHandle(store)
    .prepare("UPDATE facts SET valid_from = ?, status = 'pending' WHERE id = ?")
    .run(at, id);
}

export function findById(store, id) {
  return getHandle(store).prepare('SELECT * FROM facts WHERE id = ?').get(id) ?? null;
}

export function markDone(store, id) {
  getHandle(store)
    .prepare("UPDATE facts SET status = 'done' WHERE id = ? AND status = 'pending'")
    .run(id);
}

export function listAll(store, sessionId) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM facts
      WHERE session_id = ?
      ORDER BY valid_from DESC, id DESC
    `)
    .all(sessionId);
}

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

export function remove(store, id) {
  const result = getHandle(store).prepare('DELETE FROM facts WHERE id = ?').run(id);
  return Number(result.changes);
}
