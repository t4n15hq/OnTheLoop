import crypto from 'crypto';
import config from '../config';

// One-click, no-login unsubscribe tokens.
//
// The token is a stateless HMAC over the userId, signed with the app secret.
// It carries no session and can't be forged without the secret, so it's safe
// to embed in an email `List-Unsubscribe` header and footer link.

function secret(): string {
  return config.jwt.secret;
}

/** Deterministic HMAC-SHA256 of the userId, hex-encoded. */
export function generateUnsubscribeToken(userId: string): string {
  return crypto.createHmac('sha256', secret()).update(userId).digest('hex');
}

/** Timing-safe check that `token` is the valid signature for `userId`. */
export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  if (!userId || !token) return false;
  const expected = generateUnsubscribeToken(userId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  // timingSafeEqual throws on length mismatch, so guard first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
