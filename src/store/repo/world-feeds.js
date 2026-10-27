import { getHandle } from '../handle.js';

const KIND_ORDER = "CASE kind WHEN 'weather' THEN 0 WHEN 'holiday' THEN 1 ELSE 2 END";

export function listForDay(store, day) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM world_feeds
      WHERE date = ?
      ORDER BY ${KIND_ORDER} ASC, id ASC
    `)
    .all(day);
}

export function insertIfAbsent(store, feed) {
  const result = getHandle(store)
    .prepare(`
      INSERT OR IGNORE INTO world_feeds (date, kind, content, fetched_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(feed.date, feed.kind, feed.content, feed.fetchedAt);
  return Number(result.changes) > 0;
}

export function removeBefore(store, cutoffDay) {
  const result = getHandle(store).prepare('DELETE FROM world_feeds WHERE date < ?').run(cutoffDay);
  return Number(result.changes);
}
