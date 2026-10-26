import { stateWord } from '../session/state.js';

function summarize(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact === '') {
    return null;
  }
  return compact.length > 60 ? `${compact.slice(0, 60)}…` : compact;
}

/**
 * 角色库只组装视图，不写库；状态词与额度分别来自 session / quota。
 *
 * @param {{
 *   store: object,
 *   quota: { remainingToday: (sessionId: number) => number },
 * }} options
 */
export function createLibrary({ store, quota }) {
  function list({ q = '' } = {}) {
    const query = typeof q === 'string' ? q.trim() : '';
    const rows = store.sessions.listWithCharacters({ q: query });

    return {
      cards: rows.map((row) => {
        const state = row.state ?? 'unstarted';
        return {
          id: row.character_id,
          session_id: row.session_id,
          name: row.name,
          compat: row.compat,
          state,
          state_word: stateWord(state),
          today_remaining: quota.remainingToday(row.session_id),
          last_message: summarize(row.last_message),
          unread: 0,
          avatar_url: row.avatar_path ? `/api/cards/${row.character_id}/avatar` : null,
        };
      }),
    };
  }

  return { list };
}
