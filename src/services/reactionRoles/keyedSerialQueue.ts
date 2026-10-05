export function createKeyedSerialQueue() {
  const queues = new Map<string, Promise<void>>();

  return {
    enqueue(key: string, operation: () => Promise<void>): Promise<void> {
      const previous = queues.get(key) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(operation)
        .finally(() => {
          if (queues.get(key) === current) {
            queues.delete(key);
          }
        });
      queues.set(key, current);
      return current;
    },

    get size(): number {
      return queues.size;
    }
  };
}
