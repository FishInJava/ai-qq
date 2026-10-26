import { AppError } from '../errors.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TOKEN_LIMIT = 10_000_000;

function statusOf({ warn, exhausted }) {
  if (exhausted) {
    return 'exhausted';
  }
  return warn ? 'warn70' : 'ok';
}

/**
 * 额度模块：主动预算、对话 token 账本、续额与用量聚合。
 * `evaluate` / `usage` 只读；`record` / `raiseLimit` 只写账本，不改会话状态。
 *
 * @param {{
 *   store: object,
 *   clock: import('../clock/index.js').Clock,
 *   config: object,
 * }} options
 */
export function createQuota({ store, clock, config }) {
  /**
   * 全局预算与单角色预算取小；已用超出时归零。
   *
   * @param {number} sessionId
   * @returns {number}
   */
  function remainingToday(sessionId) {
    const day = clock.localDay();
    const globalRemaining = Math.max(
      0,
      config.budget.daily_global - store.budget.globalUsedOn(day),
    );
    const sessionRemaining = Math.max(
      0,
      config.budget.per_session - store.budget.usedOn(day, sessionId),
    );
    return Math.min(globalRemaining, sessionRemaining);
  }

  function requireSession(sessionId) {
    const session = store.sessions.findById(sessionId);
    if (!session) {
      throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
    }
    return session;
  }

  /**
   * @param {number} sessionId
   * @returns {{
   *   used: number,
   *   limit: number,
   *   ratio: number,
   *   warn: boolean,
   *   exhausted: boolean,
   *   status: 'ok' | 'warn70' | 'exhausted',
   * }}
   */
  function evaluate(sessionId) {
    const session = requireSession(sessionId);
    const limit = Math.max(1, Number(session.token_limit));
    const used = Math.max(0, Number(session.token_used));
    const ratio = used / limit;
    const warn = ratio >= config.quota.warn_ratio;
    const exhausted = used >= limit;
    return {
      used,
      limit,
      ratio,
      warn,
      exhausted,
      status: statusOf({ warn, exhausted }),
    };
  }

  /**
   * 记一笔用量。调用方可以把它包在自己的 `store.tx()` 里（本函数不另开事务）。
   * `warnFirst` 只在首次跨过 70% 时为真，用来保证 `quota` 事件只发一次。
   *
   * @param {number} sessionId
   * @param {'chat' | 'proactive' | 'refill'} kind
   * @param {number} amount
   * @param {{ estimated?: number, refType?: string | null, refId?: number | null }} [options]
   */
  function record(sessionId, kind, amount, { estimated = 0, refType = null, refId = null } = {}) {
    const before = requireSession(sessionId);

    const safeAmount = Math.max(0, Math.round(Number(amount) || 0));
    store.sessions.addTokens(sessionId, safeAmount);
    store.tokenLedger.insert({
      sessionId,
      kind,
      amount: safeAmount,
      estimated: estimated ? 1 : 0,
      refType,
      refId,
      createdAt: clock.iso(),
    });

    const quota = evaluate(sessionId);
    let warnFirst = false;
    if (quota.warn && before.quota70_flagged !== 1) {
      store.sessions.setQuotaFlag(sessionId, 1);
      warnFirst = true;
    }

    return { ...quota, warnFirst };
  }

  /**
   * 续额只抬高上限，不复位已用；写一条 refill 流水，金额是本次提高的上限。
   *
   * @param {number} sessionId
   * @param {number} amount
   */
  function raiseLimit(sessionId, amount) {
    const session = requireSession(sessionId);
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) {
      throw new AppError('invalid_refill', '续额数量必须是正整数', { status: 400 });
    }
    const nextLimit = Number(session.token_limit) + value;
    if (nextLimit > MAX_TOKEN_LIMIT) {
      throw new AppError('invalid_refill', '续额后上限超出允许范围', { status: 400 });
    }

    store.sessions.setTokenLimit(session.id, nextLimit);
    store.tokenLedger.insert({
      sessionId: session.id,
      kind: 'refill',
      amount: value,
      estimated: 0,
      refType: null,
      refId: null,
      createdAt: clock.iso(),
    });

    return evaluate(session.id);
  }

  /**
   * @param {string | null | undefined} value
   * @param {string} fallback
   */
  function parseDay(value, fallback) {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
      throw new AppError('invalid_date', '日期格式必须是 YYYY-MM-DD', { status: 400 });
    }
    if (!Number.isFinite(clock.startOfLocalDay(value))) {
      throw new AppError('invalid_date', '日期不存在，请检查后重试', { status: 400 });
    }
    return value;
  }

  /**
   * 用量抽屉：按本地日聚合 + 流水明细 + 当前每个会话的额度头。
   *
   * @param {{ from?: string, to?: string }} [options]
   */
  function usage({ from, to } = {}) {
    const today = clock.localDay();
    const startDay = parseDay(from, today);
    const endDay = parseDay(to, today);
    if (startDay > endDay) {
      throw new AppError('invalid_date_range', '开始日期不能晚于结束日期', { status: 400 });
    }

    const fromMs = clock.startOfLocalDay(startDay);
    const toMs = clock.nextLocalDayStart(endDay);
    const rows = store.tokenLedger.listRange(clock.iso(fromMs), clock.iso(toMs));

    const daily = [];
    const byDay = new Map();
    for (let day = startDay; day <= endDay;) {
      const bucket = { date: day, chat: 0, proactive: 0, refill: 0, total: 0 };
      daily.push(bucket);
      byDay.set(day, bucket);
      const next = clock.localDayOfIso(clock.iso(clock.nextLocalDayStart(day)));
      if (next === null || next <= day) {
        break;
      }
      day = next;
    }

    const entries = rows.map((row) => {
      const date = clock.localDayOfIso(row.created_at) ?? startDay;
      const bucket = byDay.get(date);
      if (bucket && (row.kind === 'chat' || row.kind === 'proactive' || row.kind === 'refill')) {
        bucket[row.kind] += Number(row.amount) || 0;
        if (row.kind !== 'refill') {
          bucket.total += Number(row.amount) || 0;
        }
      }
      return {
        id: row.id,
        session_id: row.session_id,
        kind: row.kind,
        amount: row.amount,
        estimated: row.estimated,
        ref_type: row.ref_type,
        ref_id: row.ref_id,
        created_at: row.created_at,
        date,
      };
    });

    const totals = daily.reduce(
      (sum, bucket) => ({
        chat: sum.chat + bucket.chat,
        proactive: sum.proactive + bucket.proactive,
        refill: sum.refill + bucket.refill,
        total: sum.total + bucket.total,
      }),
      { chat: 0, proactive: 0, refill: 0, total: 0 },
    );

    const sessions = store.sessions.listWithCharacters({ q: '' })
      .filter((row) => row.session_id !== null)
      .map((row) => {
        const limit = Math.max(1, Number(row.token_limit));
        const used = Math.max(0, Number(row.token_used));
        const ratio = used / limit;
        const warn = ratio >= config.quota.warn_ratio;
        const exhausted = used >= limit;
        return {
          session_id: row.session_id,
          character_id: row.character_id,
          name: row.name,
          state: row.state,
          used,
          limit,
          ratio,
          warn,
          exhausted,
          status: statusOf({ warn, exhausted }),
        };
      });

    return {
      from: startDay,
      to: endDay,
      daily,
      totals,
      entries,
      sessions,
    };
  }

  return { remainingToday, evaluate, record, raiseLimit, usage };
}
