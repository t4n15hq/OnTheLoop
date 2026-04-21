import { describe, it, expect } from 'vitest';
import { createCoalescer } from './coalesce';

describe('createCoalescer', () => {
  it('concurrent calls with the same key share one upstream call', async () => {
    const { withCoalescing } = createCoalescer<string>();
    let calls = 0;

    const factory = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 'result';
    };

    const [a, b, c] = await Promise.all([
      withCoalescing('k', factory),
      withCoalescing('k', factory),
      withCoalescing('k', factory),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe('result');
    expect(b).toBe('result');
    expect(c).toBe('result');
  });

  it('different keys do not share', async () => {
    const { withCoalescing } = createCoalescer<string>();
    let calls = 0;

    const factory = async (tag: string) => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return tag;
    };

    const [a, b] = await Promise.all([
      withCoalescing('a', () => factory('a')),
      withCoalescing('b', () => factory('b')),
    ]);

    expect(calls).toBe(2);
    expect(a).toBe('a');
    expect(b).toBe('b');
  });

  it('inflight entry is cleared after settle so a later caller triggers a fresh upstream', async () => {
    const { withCoalescing, size } = createCoalescer<number>();
    let calls = 0;

    const factory = async () => {
      calls++;
      return calls;
    };

    const first = await withCoalescing('k', factory);
    expect(first).toBe(1);
    expect(size()).toBe(0);

    const second = await withCoalescing('k', factory);
    expect(second).toBe(2);
    expect(calls).toBe(2);
  });

  it('a rejected factory clears the inflight entry and does not poison future calls', async () => {
    const { withCoalescing, size } = createCoalescer<string>();
    let calls = 0;

    const failing = async () => {
      calls++;
      throw new Error('boom');
    };

    await expect(withCoalescing('k', failing)).rejects.toThrow('boom');
    expect(size()).toBe(0);

    const succeeding = async () => {
      calls++;
      return 'ok';
    };

    const result = await withCoalescing('k', succeeding);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('concurrent callers all see the same rejection when the factory fails', async () => {
    const { withCoalescing } = createCoalescer<string>();
    let calls = 0;

    const failing = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('upstream failed');
    };

    const results = await Promise.allSettled([
      withCoalescing('k', failing),
      withCoalescing('k', failing),
      withCoalescing('k', failing),
    ]);

    expect(calls).toBe(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
    }
  });
});
