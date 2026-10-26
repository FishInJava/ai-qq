import { getHandle } from '../handle.js';

const TABLES = [
  'messages',
  'facts',
  'summaries',
  'life_events',
  'proactive_log',
  'scheduler_state',
  'token_ledger',
  'daily_budget',
  'world_feeds',
  'sessions',
  'characters',
];

/**
 * 清空全部业务数据，保留 schema_version。调用方负责放进 store.tx()。
 * 顺序从子表到父表，避免外键约束；world_feeds 没有外键，最后一起清。
 *
 * @param {object} store
 */
export function purgeAll(store) {
  const handle = getHandle(store);
  for (const table of TABLES) {
    handle.prepare(`DELETE FROM ${table}`).run();
  }
  handle.prepare(`
    DELETE FROM sqlite_sequence
    WHERE name IN (${TABLES.map(() => '?').join(', ')})
  `).run(...TABLES);
}

/**
 * VACUUM INTO 在 WAL 下也能得到一致快照；目标已存在时 SQLite 会报错，
 * 调用方用时间戳保证唯一。
 *
 * @param {object} store
 * @param {string} targetPath
 */
export function backupTo(store, targetPath) {
  const escaped = String(targetPath).replaceAll("'", "''");
  getHandle(store).exec(`VACUUM INTO '${escaped}'`);
}
