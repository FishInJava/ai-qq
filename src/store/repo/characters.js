import { getHandle } from '../handle.js';

export function findByHash(store, hash) {
  return getHandle(store)
    .prepare('SELECT * FROM characters WHERE source_hash = ?')
    .get(hash) ?? null;
}

export function findById(store, id) {
  return getHandle(store)
    .prepare('SELECT * FROM characters WHERE id = ?')
    .get(id) ?? null;
}

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

export function remove(store, id) {
  getHandle(store).prepare('DELETE FROM characters WHERE id = ?').run(id);
}
