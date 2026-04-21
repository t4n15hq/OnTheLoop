import rateLimit from 'express-rate-limit';

// Per-IP caps on auth endpoints. These are the routes an attacker probes
// first: login (credential stuffing), register (mass signup), password
// change (takeover after compromise), telegram/link (cheap token churn).

export const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signups from this IP. Try again later.' },
});

export const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password changes. Try again later.' },
});

export const telegramLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many link attempts. Try again later.' },
});

// Blanket limit across /api/*. Skips the Telegram webhook — that's hit by
// Telegram's servers from a small IP pool and would trip the limit under
// normal load.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.originalUrl.startsWith('/api/telegram/webhook'),
});
