import { getHandle } from '../handle.js';

const KIND_ORDER = "CASE kind WHEN 'weather' THEN 0 WHEN 'holiday' THEN 1 ELSE 2 END";

/**
 * 某本地日已抓到的世界信息；一天内每类最多一条（UNIQUE(date, kind)）。
 *
 * @param {object} store
 * @param {string} day
 */
export function listForDay(store, day) {
  return getHandle(store)
    .prepare(`
      SELECT * FROM world_feeds
      WHERE date = ?
      ORDER BY ${KIND_ORDER} ASC, id ASC
    `)
    .all(day);
}

/**
 * 幂等写入：当天同类已存在时忽略，返回是否真的插入。
 *
 * @param {object} store
 * @param {{ date: string, kind: string, content: string, fetchedAt: string }} feed
 * @returns {boolean}
 */
export function insertIfAbsent(store, feed) {
  const result = getHandle(store)
    .prepare(`
      INSERT OR IGNORE INTO world_feeds (date, kind, content, fetched_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(feed.date, feed.kind, feed.content, feed.fetchedAt);
  return Number(result.changes) > 0;
}

/**
 * 启动清理：只保留最近 90 天。
 *
 * @param {object} store
 * @param {string} cutoffDay YYYY-MM-DD（含当天保留）
 * @returns {number}
 */
export function removeBefore(store, cutoffDay) {
  const result = getHandle(store).prepare('DELETE FROM world_feeds WHERE date < ?').run(cutoffDay);
  return Number(result.changes);
}
