import { AppError } from '../../errors.js';
import { readJson, sendJson } from '../respond.js';

const BODY_LIMIT = 16 * 1024;
const MAX_TOKEN_LIMIT = 10_000_000;

function idOf(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
  }
  return id;
}

export function registerSessionRoutes(router, { session }) {
  router.add('PATCH', '/api/sessions/:id', async ({ req, res, params }) => {
    const id = idOf(params.id);
    const body = await readJson(req, BODY_LIMIT);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('invalid_session_patch', '请求内容不完整', { status: 400 });
    }

    const keys = Object.keys(body);
    if (keys.length === 0) {
      throw new AppError('invalid_session_patch', '没有要修改的内容', { status: 400 });
    }
    for (const key of keys) {
      if (key !== 'active' && key !== 'token_limit') {
        throw new AppError('invalid_session_patch', `不支持的字段：${key}`, { status: 400 });
      }
    }

    if (body.active !== undefined && typeof body.active !== 'boolean') {
      throw new AppError('invalid_session_patch', 'active 必须是布尔值', { status: 400 });
    }
    if (body.token_limit !== undefined) {
      const limit = Number(body.token_limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOKEN_LIMIT) {
        throw new AppError('invalid_token_limit', '额度上限必须是 1–10,000,000 的整数', {
          status: 400,
        });
      }
    }

    const current = session.getSession(id);

    if (body.active === false && current.state !== 'active') {
      throw new AppError('invalid_state_transition', '只有醒着的会话能切到在忙', { status: 409 });
    }
    if (body.active === true && current.state !== 'paused') {
      throw new AppError('invalid_state_transition', '只有在忙的会话能切回醒着', { status: 409 });
    }

    if (body.active !== undefined) {
      const event = body.active ? 'resume' : 'pause';
      const result = session.transition(id, event);
      if (!result.ok) {
        throw new AppError('invalid_state_transition', '这个状态不能这样切换', { status: 409 });
      }
    }
    if (body.token_limit !== undefined) {
      session.setTokenLimit(id, Number(body.token_limit));
    }

    sendJson(res, 200, { session: session.view(id) });
  });

  router.add('POST', '/api/sessions/:id/refill', async ({ req, res, params }) => {
    const id = idOf(params.id);
    const body = await readJson(req, BODY_LIMIT);
    const amount = Number(body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError('invalid_refill', '续额数量必须是正整数', { status: 400 });
    }
    sendJson(res, 200, session.refill(id, amount));
  });
}
