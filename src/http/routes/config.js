import { AppError } from '../../errors.js';
import { readJson, sendJson } from '../respond.js';

const BODY_LIMIT = 64 * 1024;

/**
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{ configService: object }} services
 */
export function registerConfigRoutes(router, { configService }) {
  router.add('GET', '/api/config', ({ res }) => {
    sendJson(res, 200, { config: configService.view() });
  });

  router.add('PUT', '/api/config', async ({ req, res }) => {
    const body = await readJson(req, BODY_LIMIT);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('config_invalid', '配置必须是一个对象', { status: 400 });
    }
    sendJson(res, 200, configService.update(body));
  });
}
