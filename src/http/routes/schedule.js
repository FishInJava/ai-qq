import { AppError } from '../../errors.js';
import { readJson, sendJson } from '../respond.js';

const BODY_LIMIT = 16 * 1024;
const TRIGGERS = new Set(['timer', 'hard', 'manual']);

function idOf(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
  }
  return id;
}

/**
 * 调度留痕只读接口；测试 tick 只在 `runtime.test_hooks === true` 时挂载。
 *
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{ schedule: object, config: object }} services
 */
export function registerScheduleRoutes(router, { schedule, config }) {
  router.add('GET', '/api/sessions/:id/debug/ticks', ({ res, params, url }) => {
    const limitRaw = url.searchParams.get('limit');
    const rows = schedule.ticks(idOf(params.id), limitRaw === null ? undefined : Number(limitRaw));
    sendJson(res, 200, { ticks: rows });
  });

  if (config.runtime?.test_hooks !== true) {
    return;
  }

  router.add('POST', '/api/test/tick', async ({ req, res }) => {
    const body = await readJson(req, BODY_LIMIT);
    const trigger = typeof body?.trigger === 'string' ? body.trigger : 'manual';
    if (!TRIGGERS.has(trigger)) {
      throw new AppError('trigger_invalid', '触发方式不对', { status: 400 });
    }
    const decision = await schedule.runTick(idOf(body?.session_id), trigger);
    sendJson(res, 200, decision);
  });
}
