/**
 * 进程内单向广播。业务模块 emit，http 订阅后转 SSE。
 * 监听器抛错不打断其他监听器；错误交给组合根记录。
 *
 * @param {{ onError?: (err: unknown, topic: string) => void }} [options]
 */
export function createBus({ onError = () => {} } = {}) {
  const listeners = new Set();

  return {
    /**
     * @param {string} topic message | state | quota | tick | import | log
     * @param {unknown} payload
     */
    emit(topic, payload) {
      for (const listener of [...listeners]) {
        try {
          listener(topic, payload);
        } catch (err) {
          onError(err, topic);
        }
      }
    },

    /**
     * @param {(topic: string, payload: unknown) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      listeners.clear();
    },
  };
}
