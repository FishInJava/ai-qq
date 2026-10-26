import { getHandle } from '../handle.js';

/**
 * 每次 tick 都留一行：决策、原因、意愿、触发源与下次时间。
 * 抽屉的“调度”页签只读这张表，不从日志反推。
 *
 * @param {object} store
 * @param {{
 *   sessionId: number,
 *   trigger: 'timer' | 'hard' | 'manual',
 *   decision: 'skip' | 'send',
 *   decisionReason: string,
 *   willingness: number | null,
 *   nextTickAt: string | null,
 *   createdAt: string,
 * }} entry
 * @returns {number}
 */
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

/**
 * @param {object} store
 * @param {number} sessionId
 * @param {number} [limit=20]
 */
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

/**
 * 高 tick 日判断只数本本地日内的行。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {string} sinceIso
 */
export function countSince(store, sessionId, sinceIso) {
  const row = getHandle(store)
    .prepare(`
      SELECT COUNT(*) AS n FROM scheduler_state
      WHERE session_id = ? AND created_at >= ?
    `)
    .get(sessionId, sinceIso);
  return Number(row?.n ?? 0);
}
