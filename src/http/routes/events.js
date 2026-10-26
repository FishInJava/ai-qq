import { openSse, sendSse } from '../sse.js';

const TOPICS = new Set(['message', 'state', 'quota', 'tick', 'import']);

/**
 * 全局事件流。业务模块只 emit，这里负责转成 SSE。
 *
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{ bus: object }} services
 */
export function registerEventRoutes(router, { bus }) {
  router.add('GET', '/api/events', ({ req, res }) => {
    let closed = false;
    const unsubscribe = bus.subscribe((topic, payload) => {
      if (closed || !TOPICS.has(topic)) {
        return;
      }
      sendSse(res, topic, payload);
    });

    openSse(res);
    res.write(': connected\n\n');

    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    };

    req.on('close', close);
    res.on('close', close);
  });
}
