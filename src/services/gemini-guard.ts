/**
 * Assistant load protection for Gemini (issue #58).
 *
 * Every Gemini entry point in the app routes through {@link guardedGemini},
 * which layers four protections around a single logical Gemini operation:
 *
 *   1. Redis cache (short TTL) keyed on the normalized query — a repeat of the
 *      same query within the TTL costs ZERO Gemini calls. Only the
 *      Gemini-*derived* parts are cached here (intent parse, directions text,
 *      endpoint resolution); live CTA arrivals are always fetched fresh by the
 *      assistant pipeline and never pass through this cache.
 *   2. In-flight coalescing (the shared `createCoalescer`) — N simultaneous
 *      identical queries share ONE upstream call.
 *   3. A process-wide concurrency semaphore with a bounded queue
 *      (`GEMINI_MAX_CONCURRENCY`, default 15). Excess callers wait; if the queue
 *      is also full the call rejects fast with {@link GeminiSaturatedError} so
 *      the caller can degrade gracefully instead of blocking the event loop.
 *   4. A per-call timeout + a simple circuit breaker so a wedged/erroring
 *      Gemini stops being hammered.
 *
 * An invocation counter is incremented once per operation that gets *past* the
 * cache + coalescer (i.e. a call that really would hit Gemini). It increments in
 * GEMINI_MOCK mode too, so tests and the load-test script can assert exactly how
 * many real Gemini calls WOULD have happened.
 *
 * ponytail: per-instance semaphore first. The cap is per Node process. When the
 * web tier scales to many instances the upgrade path is a Redis-backed
 * distributed limiter (e.g. a token bucket in `cacheRedis`); the call sites do
 * not change, only the `Semaphore` implementation swaps out.
 *
 * Note on composite operations: `getTransitSuggestion` / `parseRouteConfig` fire
 * a few underlying Gemini network calls, but they are guarded as ONE logical
 * operation (one counter increment, one semaphore slot). This is deliberate: it
 * keeps counting at the query altitude the acceptance criteria talk about and
 * avoids any nested-semaphore self-deadlock. Worst-case concurrent network calls
 * are therefore a small constant multiple of the cap, still tightly bounded.
 */
import { CacheService } from './cache.service';
import { createCoalescer } from '../utils/coalesce';
import logger from '../utils/logger';

// ────────────────────────────────────────────────────────────────────────────
// Config (env, read once at load).
// ────────────────────────────────────────────────────────────────────────────
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Max Gemini operations in flight per process. */
export const GEMINI_MAX_CONCURRENCY = intFromEnv('GEMINI_MAX_CONCURRENCY', 15);
/** Max operations allowed to WAIT for a slot before we shed load. */
export const GEMINI_MAX_QUEUE = intFromEnv('GEMINI_MAX_QUEUE', 100);
/** Short TTL for the Gemini-derived answer/parse cache. */
export const GEMINI_CACHE_TTL_SECONDS = intFromEnv('GEMINI_CACHE_TTL_SECONDS', 60);
/** Consecutive failures before the breaker opens. */
const BREAKER_THRESHOLD = intFromEnv('GEMINI_BREAKER_THRESHOLD', 5);
/** How long the breaker stays open once tripped. */
const BREAKER_COOLDOWN_MS = intFromEnv('GEMINI_BREAKER_COOLDOWN_MS', 30_000);

/** True when Gemini is mocked. Read dynamically so tests can toggle it. */
export function isGeminiMock(): boolean {
  return process.env.GEMINI_MOCK === '1';
}

// ────────────────────────────────────────────────────────────────────────────
// Errors.
// ────────────────────────────────────────────────────────────────────────────
export class GeminiSaturatedError extends Error {
  constructor(message = 'Gemini concurrency limit reached') {
    super(message);
    this.name = 'GeminiSaturatedError';
  }
}

export class GeminiUnavailableError extends Error {
  constructor(message = 'Gemini circuit breaker open') {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bounded semaphore. Grants up to `max` slots; queues up to `maxQueue` waiters;
// rejects further callers with GeminiSaturatedError (load shedding).
// ────────────────────────────────────────────────────────────────────────────
export type Release = () => void;

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number, private readonly maxQueue: number) {}

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  acquire(): Promise<Release> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new GeminiSaturatedError());
    }
    return new Promise<Release>((resolve) => {
      this.queue.push(() => resolve(this.makeRelease()));
    });
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Transfer the slot straight to the next waiter — `active` is unchanged.
        next();
      } else {
        this.active--;
      }
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Circuit breaker.
// ────────────────────────────────────────────────────────────────────────────
class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      logger.warn(
        `Gemini circuit breaker OPEN for ${BREAKER_COOLDOWN_MS}ms after ${this.consecutiveFailures} failures`
      );
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Module state.
// ────────────────────────────────────────────────────────────────────────────
let semaphore = new Semaphore(GEMINI_MAX_CONCURRENCY, GEMINI_MAX_QUEUE);
const breaker = new CircuitBreaker();
const coalescer = createCoalescer<unknown>();

let invocationCount = 0;

/** Total Gemini operations that got past cache + coalescing (real or mocked). */
export function getGeminiInvocationCount(): number {
  return invocationCount;
}

/** Reset the invocation counter (tests / load-test setup). */
export function resetGeminiInvocationCount(): void {
  invocationCount = 0;
}

/** Live semaphore stats (tests / metrics). */
export function geminiSemaphoreStats(): { active: number; queued: number } {
  return { active: semaphore.activeCount, queued: semaphore.queueLength };
}

/**
 * Swap in a differently-sized semaphore. Intended for tests that need to prove
 * the concurrency cap with a small, deterministic limit.
 */
export function setGeminiConcurrencyForTests(max: number, maxQueue = 1_000): void {
  semaphore = new Semaphore(max, maxQueue);
  breaker.reset();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface GuardedGeminiOptions<T> {
  /** Cache/coalesce key. Callers build it from the normalized query. */
  cacheKey: string;
  /** Cache TTL in seconds. */
  ttlSeconds?: number;
  /** Per-call timeout for the real Gemini work. */
  timeoutMs: number;
  /** Deterministic result when GEMINI_MOCK=1 (still counted + cached). */
  mock: () => T;
  /** The real Gemini work. Only invoked when not mocked. */
  run: () => Promise<T>;
}

/**
 * Run a Gemini operation behind cache + coalescing + concurrency cap + timeout
 * + circuit breaker. Throws {@link GeminiSaturatedError} / {@link
 * GeminiUnavailableError} (or the underlying error / a timeout) so the caller
 * can degrade gracefully. Never caches null/undefined.
 */
export async function guardedGemini<T>(opts: GuardedGeminiOptions<T>): Promise<T> {
  const { cacheKey, timeoutMs, mock, run } = opts;
  const ttlSeconds = opts.ttlSeconds ?? GEMINI_CACHE_TTL_SECONDS;

  // 1. Cache — a hit costs no Gemini call and no counter increment.
  const cached = await CacheService.get<T>(cacheKey);
  if (cached !== null && cached !== undefined) {
    return cached;
  }

  // 2. Coalesce identical in-flight calls so they share one execution.
  const result = await coalescer.withCoalescing(cacheKey, async () => {
    // Re-check the cache: an earlier coalesced call may have populated it.
    const again = await CacheService.get<T>(cacheKey);
    if (again !== null && again !== undefined) {
      return again;
    }

    // Past cache + coalescing → this is a real (or would-be) Gemini invocation.
    invocationCount++;

    if (isGeminiMock()) {
      // Optional artificial latency keeps the coalescing window open under the
      // load-test's synchronous burst; defaults to 0 for tests/production.
      const latency = intFromEnv('GEMINI_MOCK_LATENCY_MS', 0);
      if (latency > 0) await delay(latency);
      const value = mock();
      if (value !== null && value !== undefined) {
        await CacheService.set(cacheKey, value, ttlSeconds);
      }
      return value;
    }

    if (breaker.isOpen()) {
      throw new GeminiUnavailableError();
    }

    // 3. Concurrency cap. acquire() rejects (GeminiSaturatedError) when the
    //    bounded queue is full — we never hold a slot we did not get.
    const release = await semaphore.acquire();
    try {
      // 4. Timeout around the real work.
      const value = await withTimeout(run(), timeoutMs, cacheKey);
      breaker.recordSuccess();
      if (value !== null && value !== undefined) {
        await CacheService.set(cacheKey, value, ttlSeconds);
      }
      return value;
    } catch (err) {
      breaker.recordFailure();
      throw err;
    } finally {
      release();
    }
  });

  return result as T;
}

/** Normalize a query for stable cache/coalesce keys. */
export function normalizeGeminiQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Build a namespaced cache key from a normalized query. */
export function geminiCacheKey(namespace: string, query: string): string {
  return `gemini:${namespace}:${normalizeGeminiQuery(query)}`;
}
