import { getHandle } from '../handle.js';

export function insert(store, entry) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO scheduler_state
        (session_id, trigger, decision, decision_reason, willingness, next_tick_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      entry.sessionId,
      entry.trigger,
      entry.decision,
      entry.decisionReason,
      entry.willingness ?? null,
      entry.nextTickAt ?? null,
      entry.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function listRecent(store, sessionId, limit = 20) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM scheduler_state
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, limit);
}

export function countSince(store, sessionId, sinceIso) {
  const row = getHandle(store)
    .prepare(`
      SELECT COUNT(*) AS n FROM scheduler_state
      WHERE session_id = ? AND created_at >= ?
    `)
    .get(sessionId, sinceIso);
  return Number(row?.n ?? 0);
}
