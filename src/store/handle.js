const handles = new WeakMap();

export function setHandle(store, db) {
  handles.set(store, db);
}

export function deleteHandle(store) {
  handles.delete(store);
}

export function getHandle(store) {
  const db = handles.get(store);
  if (!db) {
    throw new Error('store handle 不存在：业务模块不应直接拿数据库句柄');
  }
  return db;
}
