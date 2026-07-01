// Sentry error reporting. No-op when SENTRY_DSN is unset so local/dev builds
// don't need the env var. Import this at the top of the process entrypoint
// BEFORE anything else so instrumentation hooks attach correctly.
import * as Sentry from '@sentry/node';
import logger from './logger';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Only sample traces if explicitly configured; errors are always captured.
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
      ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
      : 0,
  });
}

export { Sentry };
export const sentryEnabled = Boolean(dsn);

export function reportError(err: unknown, ctx?: Record<string, unknown>) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message, ctx);
  if (sentryEnabled) {
    Sentry.captureException(err, { extra: ctx });
  }
}
