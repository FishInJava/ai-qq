import { getHandle } from '../handle.js';

/**
 * @param {object} store
 * @param {{
 *   sessionId: number,
 *   kind: 'chat' | 'proactive' | 'refill',
 *   amount: number,
 *   estimated?: number,
 *   refType?: string | null,
 *   refId?: number | null,
 *   createdAt: string,
 * }} entry
 * @returns {number}
 */
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

/**
 * 用量抽屉与测试按流水读，不从累加数字反推。
 *
 * @param {object} store
 * @param {number} sessionId
 * @param {number} [limit=100]
 */
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

/**
 * 用量抽屉按半开区间取流水；聚合在 quota 里做，repo 不猜本地日。
 *
 * @param {object} store
 * @param {string} fromIso 含
 * @param {string} toIso 不含
 */
export function listRange(store, fromIso, toIso) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM token_ledger
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at ASC, id ASC
    `)
    .all(fromIso, toIso);
}

/**
 * 最近一次续额时间；没有续过返回 null。
 *
 * @param {object} store
 * @param {number} sessionId
 * @returns {string | null}
 */
export function lastRefillAt(store, sessionId) {
  const row = getHandle(store)
    .prepare(`
      SELECT MAX(created_at) AS at FROM token_ledger
      WHERE session_id = ? AND kind = 'refill'
    `)
    .get(sessionId);
  return row?.at ?? null;
}
