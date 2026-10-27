import { getHandle } from '../handle.js';

export function insert(store, session) {
  const result = getHandle(store)
    .prepare(`
      INSERT INTO sessions (character_id, state, token_limit, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(session.characterId, session.state, session.tokenLimit, session.createdAt);
  return Number(result.lastInsertRowid);
}

export function findById(store, id) {
  return getHandle(store)
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) ?? null;
}

export function findByCharacterId(store, characterId) {
  return getHandle(store)
    .prepare('SELECT * FROM sessions WHERE character_id = ?')
    .get(characterId) ?? null;
}

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

export function setState(store, id, state) {
  getHandle(store)
    .prepare('UPDATE sessions SET state = ? WHERE id = ?')
    .run(state, id);
}

export function setTokenLimit(store, id, tokenLimit) {
  getHandle(store)
    .prepare('UPDATE sessions SET token_limit = ? WHERE id = ?')
    .run(tokenLimit, id);
}

export function setPauseGap(store, id, hours) {
  getHandle(store)
    .prepare('UPDATE sessions SET pause_gap_hours = ? WHERE id = ?')
    .run(hours, id);
}

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

export function setHardDedup(store, id, at) {
  getHandle(store)
    .prepare('UPDATE sessions SET hard_dedup_until = ? WHERE id = ?')
    .run(at, id);
}

export function silenceColdStart(store) {
  getHandle(store)
    .prepare(`
      UPDATE sessions
      SET cold_start_silenced = 1
      WHERE state = 'active'
        AND last_user_msg_at IS NULL
        AND last_proactive_at IS NULL
    `)
    .run();
}

export function reconcileColdStart(store) {
  const handle = getHandle(store);
  handle.prepare(`
    UPDATE sessions
    SET cold_start_silenced = 1
    WHERE state = 'active'
      AND last_user_msg_at IS NULL
      AND last_proactive_at IS NULL
  `).run();
  handle.prepare(`
    UPDATE sessions
    SET cold_start_silenced = 0
    WHERE state = 'active'
      AND (last_user_msg_at IS NOT NULL OR last_proactive_at IS NOT NULL)
  `).run();
}

export function silenceColdStartFor(store, id) {
  getHandle(store)
    .prepare(`
      UPDATE sessions
      SET cold_start_silenced = 1
      WHERE id = ?
        AND last_user_msg_at IS NULL
        AND last_proactive_at IS NULL
    `)
    .run(id);
}

export function markProactive(store, id, at) {
  getHandle(store)
    .prepare('UPDATE sessions SET last_proactive_at = ? WHERE id = ?')
    .run(at, id);
}

export function bumpIgnored(store, id) {
  getHandle(store)
    .prepare('UPDATE sessions SET consecutive_ignored = consecutive_ignored + 1 WHERE id = ?')
    .run(id);
}

export function addTokens(store, id, amount) {
  getHandle(store)
    .prepare('UPDATE sessions SET token_used = token_used + ? WHERE id = ?')
    .run(amount, id);
  return findById(store, id);
}

export function listAll(store) {
  return getHandle(store).prepare('SELECT * FROM sessions ORDER BY id ASC').all();
}

export function setQuotaFlag(store, id, flagged) {
  getHandle(store)
    .prepare('UPDATE sessions SET quota70_flagged = ? WHERE id = ?')
    .run(flagged, id);
}

export function remove(store, id) {
  getHandle(store).prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
