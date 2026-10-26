import { sendJson } from '../respond.js';

/**
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{ quota: object }} services
 */
export function registerUsageRoutes(router, { quota }) {
  router.add('GET', '/api/usage', ({ res, url }) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    sendJson(res, 200, quota.usage({
      from: from ?? undefined,
      to: to ?? undefined,
    }));
  });
}
