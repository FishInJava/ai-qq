import { AppError } from '../../errors.js';
import { readJson, sendJson } from '../respond.js';

const BODY_LIMIT = 16 * 1024;

/**
 * 托盘辅助进程专用；同源校验在 http/index.js 统一做。
 *
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{ admin: object }} services
 */
export function registerAdminRoutes(router, { admin }) {
  router.add('POST', '/api/admin/pause-all', ({ res }) => {
    sendJson(res, 200, admin.pauseAll());
  });

  router.add('POST', '/api/admin/purge', async ({ req, res }) => {
    const body = await readJson(req, BODY_LIMIT);
    if (body?.confirm !== 'DELETE') {
      throw new AppError('purge_confirm_required', '请输入 DELETE 确认清空全部数据', {
        status: 400,
      });
    }
    sendJson(res, 200, admin.purge());
  });

  router.add('POST', '/api/admin/quit', ({ res }) => {
    sendJson(res, 200, { ok: true });
    admin.quit();
  });
}
