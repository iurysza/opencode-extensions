/**
 * Serial runner per key. Tasks for one key run one at a time in submission order; different
 * keys never share state or wait for each other. A failing task does not block later ones.
 */
export function keyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const next = previous.then(task, task);
      const tail = next.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return next;
    },
    /** Keys with queued or running work. */
    active: (): readonly string[] => [...tails.keys()],
  };
}
