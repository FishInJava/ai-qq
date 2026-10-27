import { AppError } from '../../errors.js';
import { sendJson } from '../respond.js';

function idOf(value, code, message) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(code, message, { status: 404 });
  }
  return id;
}

export function registerMemoryRoutes(router, { memory }) {
  router.add('GET', '/api/sessions/:id/memory', ({ res, params }) => {
    const id = idOf(params.id, 'session_not_found', '没有找到这段会话');
    sendJson(res, 200, memory.list(id));
  });

  router.add('DELETE', '/api/memory/facts/:id', ({ res, params }) => {
    const id = idOf(params.id, 'fact_not_found', '没有找到这条记忆');
    if (!memory.removeFact(id)) {
      throw new AppError('fact_not_found', '没有找到这条记忆', { status: 404 });
    }
    sendJson(res, 200, { ok: true });
  });
}
