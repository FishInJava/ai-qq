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

export function backupTo(store, targetPath) {
  const escaped = String(targetPath).replaceAll("'", "''");
  getHandle(store).exec(`VACUUM INTO '${escaped}'`);
}
