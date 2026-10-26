import { AppError } from '../../errors.js';
import { readJson, sendError, sendJson } from '../respond.js';
import { endSse, openSse, sendSse } from '../sse.js';

const BODY_LIMIT = 16 * 1024;

function sessionId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
  }
  return id;
}

function payloadOf(event) {
  const { type, ...rest } = event;
  return rest;
}

/**
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{ chat: object }} services
 */
export function registerMessageRoutes(router, { chat }) {
  router.add('GET', '/api/sessions/:id/messages', ({ res, params, url }) => {
    const beforeRaw = url.searchParams.get('before');
    const limitRaw = url.searchParams.get('limit');
    const result = chat.history(sessionId(params.id), {
      before: beforeRaw === null ? null : Number(beforeRaw),
      limit: limitRaw === null ? undefined : Number(limitRaw),
    });
    sendJson(res, 200, result);
  });

  router.add('POST', '/api/sessions/:id/messages', async ({ req, res, params }) => {
    const body = await readJson(req, BODY_LIMIT);
    const text = typeof body?.text === 'string' ? body.text : '';
    const iterator = chat.send(sessionId(params.id), text);

    // 第一次 next() 完成所有前置校验与用户消息落库；失败时还能回普通 4xx JSON。
    let first;
    try {
      first = await iterator.next();
    } catch (err) {
      sendError(res, err);
      return;
    }

    if (first.done) {
      sendError(res, new AppError('chat_empty', '她没有说话', { status: 502 }));
      return;
    }

    openSse(res);
    sendSse(res, first.value.type, payloadOf(first.value));

    try {
      for await (const event of iterator) {
        sendSse(res, event.type, payloadOf(event));
      }
    } catch (err) {
      sendSse(res, 'error', {
        code: err instanceof AppError ? err.code : 'internal',
        message: err instanceof AppError ? err.message : '她那边出了点问题，请稍后再试',
      });
    } finally {
      endSse(res);
    }
  });
}
