/**
 * In-flight request coalescing. When N callers ask for the same thing in the
 * same tick, they should share one upstream call instead of firing N parallel
 * ones. Entries are deleted as soon as the promise settles so later callers
 * don't receive stale results.
 */
export function createCoalescer<T>() {
  const inflight = new Map<string, Promise<T>>();

  async function withCoalescing(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = factory().finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  return { withCoalescing, size: () => inflight.size };
}
