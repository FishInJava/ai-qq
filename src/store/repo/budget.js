import { getHandle } from '../handle.js';

export function usedOn(store, date, sessionId) {
  const row = getHandle(store)
    .prepare('SELECT used FROM daily_budget WHERE date = ? AND session_id = ?')
    .get(date, sessionId);
  return Number(row?.used ?? 0);
}

export function globalUsedOn(store, date) {
  const row = getHandle(store)
    .prepare('SELECT COALESCE(SUM(used), 0) AS used FROM daily_budget WHERE date = ?')
    .get(date);
  return Number(row?.used ?? 0);
}

export function increment(store, date, sessionId, amount = 1) {
  getHandle(store)
    .prepare(`
      INSERT INTO daily_budget (date, session_id, used)
      VALUES (?, ?, ?)
      ON CONFLICT (date, session_id) DO UPDATE SET used = used + excluded.used
    `)
    .run(date, sessionId, amount);
}
