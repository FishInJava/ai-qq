import { AppError } from '../errors.js';

export const STATE_WORDS = Object.freeze({
  active: '醒着',
  paused: '在忙',
  dormant: '不方便',
});

const HOUR_MS = 60 * 60 * 1000;
const PAUSE_GAP_MIN_HOURS = 2;
const MAX_TOKEN_LIMIT = 10_000_000;

/**
 * 四值入库，三词出镜：unstarted 不出状态角标。
 *
 * @param {string | null | undefined} state
 * @returns {string | null}
 */
export function stateWord(state) {
  return STATE_WORDS[state] ?? null;
}

/**
 * @param {object} session
 */
export function viewSession(session) {
  return {
    id: session.id,
    character_id: session.character_id,
    state: session.state,
    state_word: stateWord(session.state),
    token_limit: session.token_limit,
    token_used: session.token_used,
  };
}

function parseIso(clock, iso) {
  if (typeof iso !== 'string' || iso === '') {
    return Number.NaN;
  }
  return clock.parseIso(iso);
}

/**
 * 会话状态机唯一入口。迁移只改 `sessions.state`，不碰额度账本。
 *
 * @param {{
 *   store: object,
 *   clock: import('../clock/index.js').Clock,
 *   config: object,
 *   quota: object,
 *   bus: object,
 *   log?: object,
 * }} options
 */
export function createSessionService({ store, clock, config, quota, bus, log }) {
  /** 暂停起点只在进程内；重启后用 last_user_msg_at / created_at 兜底。 */
  const pausedSince = new Map();

  function requireSession(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
    }
    const session = store.sessions.findById(id);
    if (!session) {
      throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
    }
    return session;
  }

  function emitChange(session, event, from, to) {
    log?.info('state_change', {
      session_id: session.id,
      event,
      from,
      to,
    });
    bus.emit('state', {
      session_id: session.id,
      character_id: session.character_id,
      state: to,
      state_word: stateWord(to),
      previous_state: from,
      event,
    });
  }

  function illegal(session, event) {
    log?.warn('state_transition_illegal', {
      session_id: session.id,
      event,
      state: session.state,
    });
    return {
      ok: false,
      reason: 'illegal_transition',
      event,
      from: session.state,
      to: session.state,
      session: viewSession(session),
    };
  }

  function exhausted(session) {
    return Number(session.token_used) >= Number(session.token_limit);
  }

  /**
   * 历史遗留的“额度已耗尽但状态还没转”的会话，在读取时懒迁移。
   *
   * @param {object} session
   * @returns {object}
   */
  function syncExhausted(session) {
    if ((session.state === 'active' || session.state === 'paused') && exhausted(session)) {
      transition(session.id, 'exhaust');
      return store.sessions.findById(session.id) ?? session;
    }
    return session;
  }

  /**
   * @param {number} sessionId
   * @returns {object}
   */
  function getSession(sessionId) {
    return requireSession(sessionId);
  }

  /**
   * @param {number} sessionId
   */
  function view(sessionId) {
    const session = syncExhausted(requireSession(sessionId));
    return viewSession(session);
  }

  /**
   * 对话可生成：active / paused；dormant 与 unstarted 不可。
   *
   * @param {number} sessionId
   */
  function canGenerate(sessionId) {
    const session = syncExhausted(requireSession(sessionId));
    return session.state === 'active' || session.state === 'paused';
  }

  function start(characterId) {
    const card = store.characters.findById(characterId);
    if (!card) {
      throw new AppError('card_not_found', '没有找到这张卡', { status: 404 });
    }

    const session = store.sessions.findByCharacterId(characterId);
    if (!session) {
      throw new AppError('session_not_found', '这个角色还没有会话', { status: 404 });
    }

    const result = transition(session.id, 'start', {
      tokenLimit: config.quota?.default_token_limit ?? 500000,
    });
    if (!result.ok) {
      throw new AppError('session_not_unstarted', '这个会话已经开始过了', { status: 409 });
    }
    return result.session;
  }

  /**
   * @param {number} sessionId
   * @param {'start'|'pause'|'resume'|'exhaust'|'refill'|'restart'|'llm_down'|'llm_up'} event
   * @param {{ tokenLimit?: number }} [ctx]
   */
  function transition(sessionId, event, ctx = {}) {
    const session = requireSession(sessionId);
    const from = session.state;

    if (event === 'start') {
      if (from === 'active') {
        return { ok: true, changed: false, event, from, to: from, session: viewSession(session) };
      }
      if (from !== 'unstarted') {
        return illegal(session, event);
      }
      const tokenLimit = Number.isInteger(ctx.tokenLimit)
        ? ctx.tokenLimit
        : (config.quota?.default_token_limit ?? 500000);
      store.sessions.start(session.id, tokenLimit);
      const next = store.sessions.findById(session.id);
      emitChange(next, event, from, next.state);
      return { ok: true, changed: true, event, from, to: next.state, session: viewSession(next) };
    }

    if (event === 'pause') {
      if (from !== 'active') {
        return illegal(session, event);
      }
      pausedSince.set(session.id, clock.now());
      store.sessions.setState(session.id, 'paused');
      const next = store.sessions.findById(session.id);
      emitChange(next, event, from, next.state);
      return { ok: true, changed: true, event, from, to: next.state, session: viewSession(next) };
    }

    if (event === 'resume') {
      if (from !== 'paused') {
        return illegal(session, event);
      }
      const remembered = pausedSince.get(session.id);
      pausedSince.delete(session.id);
      const lastUserMs = parseIso(clock, session.last_user_msg_at);
      const createdMs = parseIso(clock, session.created_at);
      const baseMs = remembered ?? (Number.isFinite(lastUserMs) ? lastUserMs : createdMs);
      const gapHours = Number.isFinite(baseMs)
        ? Math.max(0, (clock.now() - baseMs) / HOUR_MS)
        : 0;
      store.sessions.setState(session.id, 'active');
      store.sessions.setPauseGap(
        session.id,
        gapHours >= PAUSE_GAP_MIN_HOURS ? gapHours : null,
      );
      const next = store.sessions.findById(session.id);
      emitChange(next, event, from, next.state);
      return { ok: true, changed: true, event, from, to: next.state, session: viewSession(next) };
    }

    if (event === 'exhaust') {
      if (from === 'dormant') {
        return { ok: true, changed: false, event, from, to: from, session: viewSession(session) };
      }
      if (from !== 'active' && from !== 'paused') {
        return illegal(session, event);
      }
      pausedSince.delete(session.id);
      store.sessions.setState(session.id, 'dormant');
      const next = store.sessions.findById(session.id);
      emitChange(next, event, from, next.state);
      return { ok: true, changed: true, event, from, to: next.state, session: viewSession(next) };
    }

    if (event === 'refill') {
      if (from !== 'dormant') {
        return illegal(session, event);
      }
      if (exhausted(session)) {
        log?.warn('state_refill_still_exhausted', {
          session_id: session.id,
          used: session.token_used,
          limit: session.token_limit,
        });
        return {
          ok: false,
          reason: 'still_exhausted',
          event,
          from,
          to: from,
          session: viewSession(session),
        };
      }
      store.sessions.setState(session.id, 'active');
      const next = store.sessions.findById(session.id);
      emitChange(next, event, from, next.state);
      return { ok: true, changed: true, event, from, to: next.state, session: viewSession(next) };
    }

    if (event === 'restart' || event === 'llm_down' || event === 'llm_up') {
      if (event === 'restart') {
        store.sessions.silenceColdStartFor(session.id);
      }
      log?.info('state_change', {
        session_id: session.id,
        event,
        from,
        to: from,
      });
      bus.emit('state', {
        session_id: session.id,
        character_id: session.character_id,
        state: from,
        state_word: stateWord(from),
        previous_state: from,
        event,
      });
      return { ok: true, changed: false, event, from, to: from, session: viewSession(session) };
    }

    log?.warn('state_transition_unknown', { session_id: session.id, event });
    return {
      ok: false,
      reason: 'unknown_event',
      event,
      from,
      to: from,
      session: viewSession(session),
    };
  }

  /**
   * 托盘“暂停所有会话”：active → paused；已耗尽的直接 dormant。
   *
   * @returns {number}
   */
  function pauseAll() {
    let paused = 0;
    for (const session of store.sessions.listAll()) {
      if (session.state !== 'active') {
        continue;
      }
      if (exhausted(session)) {
        transition(session.id, 'exhaust');
        continue;
      }
      const result = transition(session.id, 'pause');
      if (result.ok && result.changed) {
        paused += 1;
      }
    }
    return paused;
  }

  /**
   * 续额只抬高上限并记流水；状态迁移单独走 transition。
   *
   * @param {number} sessionId
   * @param {number} amount
   */
  function refill(sessionId, amount) {
    const session = requireSession(sessionId);
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) {
      throw new AppError('invalid_refill', '续额数量必须是正整数', { status: 400 });
    }
    if (Number(session.token_limit) + value > MAX_TOKEN_LIMIT) {
      throw new AppError('invalid_refill', '续额后上限超出允许范围', { status: 400 });
    }

    const recorded = store.tx(() => {
      const result = quota.raiseLimit(session.id, value);
      if (session.state === 'dormant' && !result.exhausted) {
        transition(session.id, 'refill');
      }
      return result;
    });

    return { session: view(session.id), quota: recorded };
  }

  /**
   * 下一句是否该带“好转”语气：最近一次续额晚于最近一条角色消息。
   *
   * @param {number} sessionId
   */
  function isRecovered(sessionId) {
    const session = requireSession(sessionId);
    const refillAt = store.tokenLedger.lastRefillAt(session.id);
    if (!refillAt) {
      return false;
    }
    const lastCharAt = store.messages.lastCreatedAtForRole(session.id, 'char');
    if (!lastCharAt) {
      return true;
    }
    return refillAt > lastCharAt;
  }

  function clearPauseGap(sessionId) {
    const session = requireSession(sessionId);
    if (session.pause_gap_hours !== null && session.pause_gap_hours !== undefined) {
      store.sessions.setPauseGap(session.id, null);
    }
  }

  /**
   * 改上限；改小到已用以下立即 dormant。抬高上限不自动唤醒，续额走 refill。
   *
   * @param {number} sessionId
   * @param {number} tokenLimit
   */
  function setTokenLimit(sessionId, tokenLimit) {
    const session = requireSession(sessionId);
    const value = Number(tokenLimit);
    if (!Number.isInteger(value) || value < 1 || value > MAX_TOKEN_LIMIT) {
      throw new AppError('invalid_token_limit', '额度上限必须是 1–10,000,000 的整数', {
        status: 400,
      });
    }
    store.sessions.setTokenLimit(session.id, value);
    const next = store.sessions.findById(session.id);
    if ((next.state === 'active' || next.state === 'paused') && exhausted(next)) {
      transition(next.id, 'exhaust');
    }
    return view(session.id);
  }

  return {
    getSession,
    view,
    canGenerate,
    start,
    transition,
    pauseAll,
    refill,
    isRecovered,
    clearPauseGap,
    setTokenLimit,
  };
}
