import { getHandle } from '../handle.js';

/**
 * 角色卡只经 repo 读写；业务模块拿不到 db。
 *
 * @param {object} store
 * @param {string} hash
 */
export function findByHash(store, hash) {
  return getHandle(store)
    .prepare('SELECT * FROM characters WHERE source_hash = ?')
    .get(hash) ?? null;
}

/**
 * @param {object} store
 * @param {number} id
 */
export function findById(store, id) {
  return getHandle(store)
    .prepare('SELECT * FROM characters WHERE id = ?')
    .get(id) ?? null;
}

/**
 * @param {object} store
 * @param {{
 *   name: string,
 *   cardJson: string,
 *   extensionsJson: string | null,
 *   compat: string,
 *   avatarPath: string | null,
 *   cardSourcePath: string | null,
 *   sourceHash: string,
 *   importedAt: string,
 * }} card
 * @returns {number}
 */
export function insert(store, card) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO characters
        (name, card_json, extensions_json, compat, avatar_path, card_source_path, source_hash, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      card.name,
      card.cardJson,
      card.extensionsJson,
      card.compat,
      card.avatarPath,
      card.cardSourcePath,
      card.sourceHash,
      card.importedAt,
    );
  return Number(result.lastInsertRowid);
}

/**
 * 覆盖导入只更新卡面，不动会话与记录。
 *
 * @param {object} store
 * @param {number} id
 * @param {{
 *   name: string,
 *   cardJson: string,
 *   extensionsJson: string | null,
 *   compat: string,
 *   avatarPath: string | null,
 *   cardSourcePath: string | null,
 *   sourceHash: string,
 *   importedAt: string,
 * }} card
 */
export function update(store, id, card) {
  getHandle(store)
    .prepare(`
      UPDATE characters
      SET name = ?, card_json = ?, extensions_json = ?, compat = ?,
          avatar_path = ?, card_source_path = ?, source_hash = ?, imported_at = ?
      WHERE id = ?
    `)
    .run(
      card.name,
      card.cardJson,
      card.extensionsJson,
      card.compat,
      card.avatarPath,
      card.cardSourcePath,
      card.sourceHash,
      card.importedAt,
      id,
    );
}

/**
 * @param {object} store
 * @param {number} id
 */
export function remove(store, id) {
  getHandle(store).prepare('DELETE FROM characters WHERE id = ?').run(id);
}
