import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// In-memory cache so cache hits/misses are deterministic and network-free.
const store = new Map<string, unknown>();
vi.mock('./cache.service', () => ({
  CacheService: {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  },
}));
vi.mock('../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  guardedGemini,
  Semaphore,
  GeminiSaturatedError,
  getGeminiInvocationCount,
  resetGeminiInvocationCount,
  setGeminiConcurrencyForTests,
  GEMINI_MAX_CONCURRENCY,
} from './gemini-guard';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  store.clear();
  resetGeminiInvocationCount();
  setGeminiConcurrencyForTests(GEMINI_MAX_CONCURRENCY); // resets breaker + semaphore
  delete process.env.GEMINI_MOCK;
});

afterEach(() => {
  delete process.env.GEMINI_MOCK;
});

describe('Semaphore', () => {
  it('never exceeds the concurrency cap under a burst', async () => {
    const sem = new Semaphore(3, 1_000);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const release = await sem.acquire();
        active++;
        peak = Math.max(peak, active);
        await delay(3);
        active--;
        release();
      })
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // sanity: work really did overlap
  });

  it('rejects with GeminiSaturatedError when the queue is full', async () => {
    const sem = new Semaphore(1, 0);
    const release = await sem.acquire(); // take the only slot
    await expect(sem.acquire()).rejects.toBeInstanceOf(GeminiSaturatedError);
    release();
  });
});

describe('guardedGemini — coalescing', () => {
  it('shares one execution across N simultaneous identical calls', async () => {
    let runs = 0;
    const run = vi.fn(async () => {
      runs++;
      await delay(20); // hold the inflight window open across the burst
      return 'result';
    });

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        guardedGemini<string>({
          cacheKey: 'gemini:test:same',
          ttlSeconds: 60,
          timeoutMs: 1_000,
          mock: () => 'mock',
          run,
        })
      )
    );

    expect(results.every((r) => r === 'result')).toBe(true);
    expect(runs).toBe(1);
    expect(getGeminiInvocationCount()).toBe(1);
  });
});

describe('guardedGemini — caching', () => {
  it('serves a repeat within TTL from cache with zero further invocations', async () => {
    const run = vi.fn(async () => 'cached-value');

    const first = await guardedGemini<string>({
      cacheKey: 'gemini:test:cache',
      ttlSeconds: 60,
      timeoutMs: 1_000,
      mock: () => 'mock',
      run,
    });
    const second = await guardedGemini<string>({
      cacheKey: 'gemini:test:cache',
      ttlSeconds: 60,
      timeoutMs: 1_000,
      mock: () => 'mock',
      run,
    });

    expect(first).toBe('cached-value');
    expect(second).toBe('cached-value');
    expect(run).toHaveBeenCalledTimes(1);
    expect(getGeminiInvocationCount()).toBe(1);
  });

  it('does not cache null results', async () => {
    const run = vi.fn(async () => null);

    await guardedGemini<string | null>({
      cacheKey: 'gemini:test:null',
      ttlSeconds: 60,
      timeoutMs: 1_000,
      mock: () => null,
      run,
    });
    await guardedGemini<string | null>({
      cacheKey: 'gemini:test:null',
      ttlSeconds: 60,
      timeoutMs: 1_000,
      mock: () => null,
      run,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(getGeminiInvocationCount()).toBe(2);
  });
});

describe('guardedGemini — mock mode', () => {
  it('short-circuits to the mock, never calls run, but still counts', async () => {
    process.env.GEMINI_MOCK = '1';
    const run = vi.fn(async () => 'real');

    const value = await guardedGemini<string>({
      cacheKey: 'gemini:test:mock',
      ttlSeconds: 60,
      timeoutMs: 1_000,
      mock: () => 'mocked',
      run,
    });

    expect(value).toBe('mocked');
    expect(run).not.toHaveBeenCalled();
    expect(getGeminiInvocationCount()).toBe(1);
  });
});

describe('guardedGemini — saturation', () => {
  it('rejects with GeminiSaturatedError instead of blocking when saturated', async () => {
    setGeminiConcurrencyForTests(1, 0); // one slot, no queue

    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // First call holds the only slot until we release it.
    const first = guardedGemini<string>({
      cacheKey: 'gemini:test:sat-a',
      ttlSeconds: 60,
      timeoutMs: 5_000,
      mock: () => 'mock',
      run: async () => {
        await firstDone;
        return 'a';
      },
    });

    // Give the first call a tick to acquire the slot.
    await delay(5);

    // Second call (different key → not coalesced) must shed load.
    await expect(
      guardedGemini<string>({
        cacheKey: 'gemini:test:sat-b',
        ttlSeconds: 60,
        timeoutMs: 5_000,
        mock: () => 'mock',
        run: async () => 'b',
      })
    ).rejects.toBeInstanceOf(GeminiSaturatedError);

    releaseFirst();
    await expect(first).resolves.toBe('a');
  });
});

describe('guardedGemini — timeout', () => {
  it('rejects when the real work exceeds the timeout', async () => {
    await expect(
      guardedGemini<string>({
        cacheKey: 'gemini:test:timeout',
        ttlSeconds: 60,
        timeoutMs: 10,
        mock: () => 'mock',
        run: async () => {
          await delay(200);
          return 'too-slow';
        },
      })
    ).rejects.toThrow(/timed out/);
  });
});
