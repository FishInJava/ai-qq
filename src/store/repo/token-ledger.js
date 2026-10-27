import { getHandle } from '../handle.js';

export function insert(store, entry) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO token_ledger
        (session_id, kind, amount, estimated, ref_type, ref_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      entry.sessionId,
      entry.kind,
      entry.amount,
      entry.estimated ?? 0,
      entry.refType ?? null,
      entry.refId ?? null,
      entry.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function listForSession(store, sessionId, limit = 100) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM token_ledger
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(sessionId, limit);
}

export function listRange(store, fromIso, toIso) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM token_ledger
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at ASC, id ASC
    `)
    .all(fromIso, toIso);
}

export function lastRefillAt(store, sessionId) {
  const row = getHandle(store)
    .prepare(`
      SELECT MAX(created_at) AS at FROM token_ledger
      WHERE session_id = ? AND kind = 'refill'
    `)
    .get(sessionId);
  return row?.at ?? null;
}
