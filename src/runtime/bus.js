export function createBus({ onError = () => {} } = {}) {
  const listeners = new Set();

  return {
    emit(topic, payload) {
      for (const listener of [...listeners]) {
        try {
          listener(topic, payload);
        } catch (err) {
          onError(err, topic);
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      listeners.clear();
    },
  };
}
