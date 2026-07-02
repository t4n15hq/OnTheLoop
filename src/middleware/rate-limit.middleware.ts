import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { rateLimitRedis } from '../utils/redis';
import config from '../config';

// The Playwright e2e suite drives many requests from a single CI IP, which would
// otherwise trip these per-IP caps, and it would also couple the tests to Redis
// connection timing at server startup. In the test environment we therefore skip
// rate limiting and fall back to the default in-memory store (no Redis). The
// limiting logic itself is exercised by unit tests, not the e2e suite.
const disableInTest = config.nodeEnv === 'test';

type LimiterOptions = NonNullable<Parameters<typeof rateLimit>[0]>;

// Build a limiter with our shared defaults. In real environments each limiter is
// backed by the bounded Redis client so counts are shared across instances; in
// tests the store is omitted and every request is skipped.
function makeLimiter(prefix: string, options: LimiterOptions) {
  const baseSkip = options.skip;
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    store: disableInTest
      ? undefined
      : new RedisStore({
          prefix,
          sendCommand: (...args: string[]) =>
            rateLimitRedis.call(...(args as [string, ...string[]])) as Promise<any>,
        }),
    skip: (req, res) => (disableInTest ? true : baseSkip ? baseSkip(req, res) : false),
  });
}

// Per-IP caps on auth endpoints. These are the routes an attacker probes
// first: login (credential stuffing), register (mass signup), password
// change (takeover after compromise), telegram/link (cheap token churn).

export const loginLimiter = makeLimiter('rl:login:', {
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

export const registerLimiter = makeLimiter('rl:register:', {
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many signups from this IP. Try again later.' },
});

export const passwordChangeLimiter = makeLimiter('rl:password:', {
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many password changes. Try again later.' },
});

export const telegramLinkLimiter = makeLimiter('rl:telegram-link:', {
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many link attempts. Try again later.' },
});

// Blanket limit across /api/*. Skips the Telegram webhook — that's hit by
// Telegram's servers from a small IP pool and would trip the limit under
// normal load.
export const apiLimiter = makeLimiter('rl:api:', {
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.originalUrl.startsWith('/api/telegram/webhook'),
});

export const aiLimiter = makeLimiter('rl:ai:', {
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many AI requests. Please slow down.' },
});
