import { getHandle } from '../handle.js';

/**
 * @param {object} store
 * @param {{
 *   characterId: number,
 *   state: string,
 *   tokenLimit: number,
 *   createdAt: string,
 * }} session
 * @returns {number}
 */
export function insert(store, session) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO sessions (character_id, state, token_limit, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(session.characterId, session.state, session.tokenLimit, session.createdAt);
  return Number(result.lastInsertRowid);
}

/**
 * @param {object} store
 * @param {number} id
 */
export function findById(store, id) {
  return getHandle(store)
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) ?? null;
}

/**
 * @param {object} store
 * @param {number} characterId
 */
export function findByCharacterId(store, characterId) {
  return getHandle(store)
    .prepare('SELECT * FROM sessions WHERE character_id = ?')
    .get(characterId) ?? null;
}

/**
 * 角色库列表：角色 + 会话 + 最近一条消息。
 * 排序按最近对话；没有对话时退回会话创建时间。
 *
 * @param {object} store
 * @param {{ q?: string }} [options]
 */
export function listWithCharacters(store, { q = '' } = {}) {
  return getHandle(store)
    .prepare(`
      SELECT
        c.id AS character_id,
        c.name,
        c.compat,
        c.avatar_path,
        c.imported_at,
        s.id AS session_id,
        s.state,
        s.token_limit,
        s.token_used,
        s.created_at AS session_created_at,
        m.content AS last_message,
        m.created_at AS last_message_at
      FROM characters c
      LEFT JOIN sessions s ON s.character_id = c.id
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages
        WHERE session_id = s.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      WHERE ? = '' OR instr(lower(c.name), lower(?)) > 0
      ORDER BY COALESCE(m.created_at, s.created_at, c.imported_at) DESC, c.id DESC
    `)
    .all(q, q);
}

/**
 * 只允许 unstarted → active；重复调用由调用方按幂等处理。
 *
 * @param {object} store
 * @param {number} id
 * @param {number} tokenLimit
 * @returns {number} 受影响行数
 */
export function start(store, id, tokenLimit) {
  const result = getHandle(store)
    .prepare(`
      UPDATE sessions
      SET state = 'active', token_limit = ?
      WHERE id = ? AND state = 'unstarted'
    `)
    .run(tokenLimit, id);
  return Number(result.changes);
}

/**
 * @param {object} store
 * @param {number} id
 * @param {string} state
 */
export function setState(store, id, state) {
  getHandle(store)
    .prepare('UPDATE sessions SET state = ? WHERE id = ?')
    .run(state, id);
}

/**
 * 只改上限；是否转 dormant 由状态机判断，repo 不替业务做迁移。
 *
 * @param {object} store
 * @param {number} id
 * @param {number} tokenLimit
 */
export function setTokenLimit(store, id, tokenLimit) {
  getHandle(store)
    .prepare('UPDATE sessions SET token_limit = ? WHERE id = ?')
    .run(tokenLimit, id);
}

/**
 * 暂停断层只在恢复后的下一次生成前有效；生成成功或不足 2h 都写 NULL。
 *
 * @param {object} store
 * @param {number} id
 * @param {number | null} hours
 */
export function setPauseGap(store, id, hours) {
  getHandle(store)
    .prepare('UPDATE sessions SET pause_gap_hours = ? WHERE id = ?')
    .run(hours, id);
}

/**
 * @param {object} store
 * @param {number} id
 * @param {string} at UTC ISO8601
 */
export function markUserMessage(store, id, at) {
  getHandle(store)
    .prepare(`
      UPDATE sessions
      SET last_user_msg_at = ?,
          consecutive_ignored = 0,
          cold_start_silenced = 0,
          hard_dedup_until = NULL
      WHERE id = ?
    `)
    .run(at, id);
}

/**
 * 台阶 / 喊累之后收住：用户再开口时 `markUserMessage` 会清掉。
 *
 * @param {object} store
 * @param {number} id
 * @param {string | null} at
 */
export function setHardDedup(store, id, at) {
  getHandle(store)
    .prepare('UPDATE sessions SET hard_dedup_until = ? WHERE id = ?')
    .run(at, id);
}

/**
 * 冷启动沉默：重启后不主动开口，直到用户先说话（R1，可在配置里打开主动）。
 *
 * @param {object} store
 */
export function silenceColdStart(store) {
  getHandle(store)
    .prepare("UPDATE sessions SET cold_start_silenced = 1 WHERE state = 'active'")
    .run();
}

/**
 * 单个会话的重启自环：状态不变，只置冷启动沉默。
 *
 * @param {object} store
 * @param {number} id
 */
export function silenceColdStartFor(store, id) {
  getHandle(store)
    .prepare('UPDATE sessions SET cold_start_silenced = 1 WHERE id = ?')
    .run(id);
}

/**
 * 主动消息成功落库后写最后开口时间；`consecutive_ignored` 的清零留给用户回复路径。
 *
 * @param {object} store
 * @param {number} id
 * @param {string} at
 */
export function markProactive(store, id, at) {
  getHandle(store)
    .prepare('UPDATE sessions SET last_proactive_at = ? WHERE id = ?')
    .run(at, id);
}

/**
 * 预算竞争失败方记一次“没被听见”，供调度意愿公式使用。
 *
 * @param {object} store
 * @param {number} id
 */
export function bumpIgnored(store, id) {
  getHandle(store)
    .prepare('UPDATE sessions SET consecutive_ignored = consecutive_ignored + 1 WHERE id = ?')
    .run(id);
}

/**
 * 对话用量只加不减；返回更新后的会话行。
 *
 * @param {object} store
 * @param {number} id
 * @param {number} amount
 */
export function addTokens(store, id, amount) {
  getHandle(store)
    .prepare('UPDATE sessions SET token_used = token_used + ? WHERE id = ?')
    .run(amount, id);
  return findById(store, id);
}

/**
 * 启动补齐时遍历所有会话；顺序稳定，便于日志与测试。
 *
 * @param {object} store
 */
export function listAll(store) {
  return getHandle(store).prepare('SELECT * FROM sessions ORDER BY id ASC').all();
}

/**
 * @param {object} store
 * @param {number} id
 * @param {number} flagged 0 | 1
 */
export function setQuotaFlag(store, id, flagged) {
  getHandle(store)
    .prepare('UPDATE sessions SET quota70_flagged = ? WHERE id = ?')
    .run(flagged, id);
}

/**
 * 删除会话会级联清掉消息、记忆、生活事件、预算与流水。
 *
 * @param {object} store
 * @param {number} id
 */
export function remove(store, id) {
  getHandle(store).prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
