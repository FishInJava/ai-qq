const handles = new WeakMap();

/**
 * 只允许 store 内部（含 repo/*）拿数据库句柄。业务模块拿不到。
 *
 * @param {object} store
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function setHandle(store, db) {
  handles.set(store, db);
}

/**
 * @param {object} store
 */
export function deleteHandle(store) {
  handles.delete(store);
}

/**
 * @param {object} store
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function getHandle(store) {
  const db = handles.get(store);
  if (!db) {
    throw new Error('store handle 不存在：业务模块不应直接拿数据库句柄');
  }
  return db;
}
