import { AppError } from '../../errors.js';
import { sendJson } from '../respond.js';

function idOf(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
  }
  return id;
}

/**
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{ living: object }} services
 */
export function registerLivingRoutes(router, { living }) {
  router.add('GET', '/api/sessions/:id/today', async ({ res, params }) => {
    const page = await living.today(idOf(params.id));
    sendJson(res, 200, page);
  });
}
