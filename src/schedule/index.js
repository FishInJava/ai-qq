import { AppError } from '../errors.js';

const TRIGGERS = new Set(['timer', 'hard', 'manual']);
const MINUTE_MS = 60 * 1000;
const STEP_DOWN_MINUTES = 180;
const TIRED_AFTER_TICKS = 8;
const MAX_TICK_ROWS = 20;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * 15 分钟 → 0，6 小时 → 1，线性。
 *
 * @param {number} minutes
 */
function silenceCurve(minutes) {
  if (!Number.isFinite(minutes)) {
    return 1;
  }
  return clamp01((minutes - 15) / (360 - 15));
}

/**
 * 08–23 为 1；23 点后线性下降，凌晨 2 点到 0，直到早上 8 点。
 *
 * @param {number} minutes 本地分钟数
 */
function timeOfDayFit(minutes) {
  if (minutes >= 8 * 60 && minutes < 23 * 60) {
    return 1;
  }
  if (minutes >= 23 * 60) {
    return Math.max(0, 1 - (minutes - 23 * 60) / 180);
  }
  return Math.max(0, 1 - (minutes + 60) / 180);
}

function startOfLocalDayIso(clock) {
  const now = new Date(clock.now());
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return clock.iso(start.getTime());
}

function nextLocalMidnightIso(clock) {
  const now = new Date(clock.now());
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return clock.iso(next.getTime());
}

function minutesSince(iso, now) {
  if (typeof iso !== 'string' || iso === '') {
    return Number.POSITIVE_INFINITY;
  }
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (now - at) / MINUTE_MS);
}

/**
 * 调度：唯一 tick 实现。剪枝顺序、意愿公式与硬触发都集中在这里，
 * 定时器只负责“到点调用 runTick”，测试用 manual 触发同一个函数。
 *
 * @param {{
 *   store: object,
 *   clock: import('../clock/index.js').Clock,
 *   config: object,
 *   proactive: object,
 *   living?: object,
 *   session?: object,
 *   bus: object,
 *   log?: object,
 *   random?: () => number,
 * }} options
 */
export function createSchedule({
  store,
  clock,
  config,
  proactive,
  living,
  session,
  bus,
  log,
  random = Math.random,
}) {
  const running = new Set();
  const timers = new Map();
  const dailyTimers = new Map();
  const hardAttempts = new Map();
  let started = false;
  let unsubscribe = null;

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

  function minutesSinceUser(session) {
    return minutesSince(session.last_user_msg_at ?? session.created_at, clock.now());
  }

  /**
   * 规则式意愿，不调模型。形状见 spec D-3。
   *
   * @param {object} session
   * @param {string} day
   */
  function computeWillingness(session, day) {
    const minutes = minutesSinceUser(session);
    const pendingFact = store.facts.listPending(session.id, 1).length > 0 ? 1 : 0;
    const used = store.budget.usedOn(day, session.id);
    const perSession = Number(config.budget.per_session) || 0;
    const budgetRoom = perSession > 0 ? Math.max(0, 1 - used / perSession) : 0;
    const unusedEvents = store.lifeEvents.listUnusedForDay(session.id, day).length;
    const eventRoom = Math.min(1, unusedEvents / 3);
    const fit = timeOfDayFit(clock.localTimeMinutes());
    const ignored = Math.min(session.consecutive_ignored ?? 0, 3) / 3;

    return clamp01(
      (0.30 * silenceCurve(minutes))
      + (0.25 * pendingFact)
      + (0.20 * budgetRoom)
      + (0.15 * eventRoom)
      + (0.10 * fit)
      - (0.20 * ignored),
    );
  }

  /**
   * 下次抖动 tick：20–40 分钟；连续被忽略 ≥3 次时 ×1.5。
   *
   * @param {object} session
   */
  function nextTickAt(session) {
    const min = Math.max(1, Number(config.schedule.tick_min) || 20);
    const max = Math.max(min, Number(config.schedule.tick_max) || 40);
    const factor = (session.consecutive_ignored ?? 0) >= 3
      ? (Number(config.schedule.ignored_multiplier) || 1.5)
      : 1;
    const minutes = (min + (random() * (max - min))) * factor;
    return clock.iso(clock.now() + minutes * MINUTE_MS);
  }

  function chooseGuidance(minutes, ticksToday) {
    if (minutes >= STEP_DOWN_MINUTES) {
      return 'step_down';
    }
    if (ticksToday >= TIRED_AFTER_TICKS) {
      return 'tired';
    }
    return null;
  }

  /**
   * 单次 tick：剪枝 → 锚点 → 意愿 → 生成 → 复核 → 提交。
   * 每个分支都写一行 scheduler_state，并广播 tick。
   *
   * @param {number} sessionId
   * @param {'timer' | 'hard' | 'manual'} [trigger]
   * @returns {Promise<object>}
   */
  async function runTick(sessionId, trigger = 'manual') {
    const session = requireSession(sessionId);
    if (!TRIGGERS.has(trigger)) {
      throw new AppError('trigger_invalid', '触发方式不对', { status: 400 });
    }
    if (running.has(session.id)) {
      return {
        sessionId: session.id,
        decision: 'skip',
        reason: 'busy',
        willingness: null,
        trigger,
        at: clock.iso(),
        nextTickAt: null,
      };
    }

    running.add(session.id);
    try {
      const at = clock.iso();
      const day = clock.localDay();
      const willingness = computeWillingness(session, day);
      const plannedNext = nextTickAt(session);

      const finish = (decision, reason, extra = {}) => {
        const { nextTickAt: overrideNext, ...rest } = extra;
        const row = {
          sessionId: session.id,
          decision,
          reason,
          willingness,
          trigger,
          at,
          nextTickAt: overrideNext ?? plannedNext,
          ...rest,
        };
        store.schedulerState.insert({
          sessionId: row.sessionId,
          trigger: row.trigger,
          decision: row.decision,
          decisionReason: row.reason,
          willingness: row.willingness,
          nextTickAt: row.nextTickAt,
          createdAt: row.at,
        });
        bus.emit('tick', row);
        return row;
      };

      if (session.state !== 'active') {
        return finish('skip', 'state_not_active');
      }
      if (session.cold_start_silenced === 1) {
        return finish('skip', 'cold_start');
      }

      const gateResult = proactive.gate(session.id);
      if (!gateResult.ok) {
        return finish('skip', gateResult.reason);
      }

      if (session.hard_dedup_until && Date.parse(session.hard_dedup_until) > clock.now()) {
        return finish('skip', 'silenced');
      }

      const cooldownFactor = (session.consecutive_ignored ?? 0) >= 3
        ? (Number(config.schedule.ignored_multiplier) || 1.5)
        : 1;
      const cooldown = (Number(config.schedule.cooldown_min) || 0) * cooldownFactor;
      const minutes = minutesSinceUser(session);
      if (trigger !== 'hard' && minutes < cooldown) {
        return finish('skip', 'too_soon');
      }

      const anchors = proactive.buildAnchors(session.id);
      if (anchors.length === 0) {
        return finish('skip', 'no_anchor');
      }

      const rawThreshold = Number(config.schedule.willingness_threshold);
      const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 0.6;
      if (willingness < threshold) {
        return finish('skip', 'low_willingness');
      }

      const ticksToday = store.schedulerState.countSince(session.id, startOfLocalDayIso(clock));
      const guidance = chooseGuidance(minutes, ticksToday);

      let generated;
      try {
        generated = await proactive.generate(session.id, anchors, { guidance });
      } catch (err) {
        log?.warn('schedule_generate_failed', {
          session_id: session.id,
          code: err?.code ?? 'unknown',
          message: err?.message ?? String(err),
        });
        return finish('skip', 'llm_error');
      }
      if (!generated.ok) {
        return finish('skip', generated.reason);
      }

      let committed;
      try {
        committed = proactive.commit(session.id, generated, generated.anchor);
      } catch (err) {
        log?.warn('schedule_commit_failed', {
          session_id: session.id,
          code: err?.code ?? 'unknown',
          message: err?.message ?? String(err),
        });
        return finish('skip', 'llm_error');
      }
      if (!committed.ok) {
        return finish('skip', committed.reason);
      }

      if (committed.quota?.exhausted && session?.transition) {
        session.transition(session.id, 'exhaust');
      }

      let next = plannedNext;
      if (guidance !== null) {
        next = nextLocalMidnightIso(clock);
        store.sessions.setHardDedup(session.id, next);
      }

      return finish('send', 'send', {
        nextTickAt: next,
        messageIds: committed.messageIds,
        guidance,
      });
    } finally {
      running.delete(session.id);
    }
  }

  /**
   * 抽屉“调度”页签：最近 20 次 tick。
   *
   * @param {number} sessionId
   * @param {number} [limit]
   */
  function ticks(sessionId, limit = MAX_TICK_ROWS) {
    const session = requireSession(sessionId);
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested)
      ? Math.min(MAX_TICK_ROWS, Math.max(1, Math.trunc(requested)))
      : MAX_TICK_ROWS;
    return store.schedulerState.listRecent(session.id, safeLimit);
  }

  /**
   * 只读意愿值，供测试与抽屉排查；生产决策仍在 runTick 内。
   *
   * @param {number} sessionId
   */
  function willingness(sessionId) {
    const session = requireSession(sessionId);
    return computeWillingness(session, clock.localDay());
  }

  function disarm(sessionId) {
    const entry = timers.get(sessionId);
    if (!entry) {
      return;
    }
    clock.clearTimer(entry.tick);
    clock.clearTimer(entry.hard);
    timers.delete(sessionId);
  }

  function arm(sessionId) {
    if (!started) {
      return;
    }
    const session = store.sessions.findById(sessionId);
    if (!session || session.state !== 'active') {
      disarm(sessionId);
      return;
    }

    disarm(sessionId);
    const factor = (session.consecutive_ignored ?? 0) >= 3
      ? (Number(config.schedule.ignored_multiplier) || 1.5)
      : 1;
    const min = Math.max(1, Number(config.schedule.tick_min) || 20);
    const max = Math.max(min, Number(config.schedule.tick_max) || 40);
    const minutes = (min + (random() * (max - min))) * factor;

    const fire = (trigger) => {
      if (!started) {
        return;
      }
      const current = store.sessions.findById(sessionId);
      if (!current || current.state !== 'active') {
        disarm(sessionId);
        return;
      }
      if (trigger === 'hard') {
        hardAttempts.set(sessionId, clock.now());
      }
      void runTick(sessionId, trigger)
        .catch((err) => {
          log?.warn('schedule_tick_failed', {
            session_id: sessionId,
            code: err?.code ?? 'unknown',
            message: err?.message ?? String(err),
          });
        })
        .finally(() => {
          if (started) {
            arm(sessionId);
          }
        });
    };

    const tickId = clock.setTimer(() => fire('timer'), Math.max(1, minutes * MINUTE_MS));

    const base = session.last_user_msg_at ?? session.created_at;
    const userAt = Date.parse(base);
    const proactiveAt = Date.parse(session.last_proactive_at ?? '');
    const attemptedAt = hardAttempts.get(sessionId) ?? Number.NEGATIVE_INFINITY;
    const lastOutreach = Math.max(
      Number.isFinite(userAt) ? userAt : 0,
      Number.isFinite(proactiveAt) ? proactiveAt : 0,
      attemptedAt,
    );
    const hardAt = lastOutreach + ((Number(config.schedule.hard_trigger_hours) || 6) * 60 * MINUTE_MS);
    const hardDelay = Math.max(0, hardAt - clock.now());
    const hardId = clock.setTimer(() => fire('hard'), hardDelay);

    timers.set(sessionId, { tick: tickId, hard: hardId });
  }

  function scheduleDaily(key, hhmm, fn) {
    const armDaily = () => {
      if (!started) {
        return;
      }
      const id = clock.setTimer(() => {
        dailyTimers.delete(key);
        if (!started) {
          return;
        }
        void Promise.resolve()
          .then(fn)
          .catch((err) => {
            log?.warn('schedule_daily_failed', {
              job: key,
              message: err?.message ?? String(err),
            });
          })
          .finally(armDaily);
      }, clock.untilNext(hhmm));
      dailyTimers.set(key, id);
    };
    armDaily();
  }

  /**
   * 启动补齐：当日 feeds + 已开始会话的生活事件，幂等，不补历史。
   * 不阻塞 HTTP 启动。
   */
  async function catchUp() {
    if (!living || typeof living.ensureAll !== 'function') {
      return;
    }
    try {
      await living.ensureAll();
    } catch (err) {
      log?.warn('schedule_catchup_failed', {
        message: err?.message ?? String(err),
      });
    }
  }

  /**
   * 生产定时器宿主。测试不启动；测试用 runTick 直接触发。
   */
  function start() {
    if (started) {
      return;
    }
    started = true;

    if (config.runtime?.cold_start_proactive !== true) {
      store.sessions.silenceColdStart();
    }

    unsubscribe = bus.subscribe((topic, payload) => {
      if (topic === 'state' && payload?.session_id) {
        if (payload.state === 'active') {
          arm(payload.session_id);
        } else {
          disarm(payload.session_id);
        }
        return;
      }
      if (topic === 'message' && payload?.message?.role === 'user' && payload.session_id) {
        arm(payload.session_id);
      }
    });

    for (const session of store.sessions.listAll()) {
      if (session.state === 'active') {
        arm(session.id);
      }
    }

    if (living && typeof living.ensureFeeds === 'function') {
      scheduleDaily('feeds', config.living?.feeds_time ?? '08:30', () => living.ensureFeeds());
    }
    if (living && typeof living.ensureEvents === 'function') {
      scheduleDaily('events', config.living?.life_event_time ?? '09:00', () => living.ensureEvents());
    }

    void catchUp();
  }

  function stop() {
    started = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    for (const sessionId of [...timers.keys()]) {
      disarm(sessionId);
    }
    for (const id of dailyTimers.values()) {
      clock.clearTimer(id);
    }
    dailyTimers.clear();
    hardAttempts.clear();
  }

  return { runTick, ticks, willingness, start, stop, catchUp };
}
