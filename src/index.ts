// MUST be imported first so Sentry.init() runs before express and other
// instrumented modules load. No-op when SENTRY_DSN isn't set.
import { Sentry, sentryEnabled } from './utils/sentry';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import config from './config';
import { validateConfig } from './config/validate';
import logger from './utils/logger';
import { startScheduler, stopScheduler } from './services/scheduler.service';
import { createNotificationWorker, notificationQueue } from './jobs/notification.job';
import { apiLimiter } from './middleware/rate-limit.middleware';
import prisma from './utils/db';
import redis, { cacheRedis } from './utils/redis';

// Import routes
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import favoriteRoutes from './routes/favorite.routes';
import telegramRoutes from './routes/telegram.routes';
import ctaRoutes from './routes/cta.routes';
import emailRoutes from './routes/email.routes';

validateConfig();

const app = express();

// Must match the actual proxy hops. Default false prevents spoofed
// X-Forwarded-For from bypassing express-rate-limit when directly exposed.
app.set('trust proxy', config.trustProxy);

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"], // Allow images from external sources just in case
        connectSrc: ["'self'", "https://lapi.transitchicago.com", "http://lapi.transitchicago.com", "http://www.ctabustracker.com"], // Allow connections to CTA APIs if frontend calls them directly (though it shouldn't)
        upgradeInsecureRequests: [], // We now serve over a live HTTPS domain — upgrade any http subresource loads.
        // NOTE: scriptSrc still allows 'unsafe-inline'. Removing it requires moving the
        // inline onclick=/<script> out of index.html; deferred to #8 (frontend modularization).
      },
    },
}));

// CORS allowlist. Only our own public origin and local dev servers may make
// cross-origin browser requests; everything else is rejected. Credentials are
// off because the SPA authenticates with a bearer token, not cookies.
const allowedOrigins = [config.publicUrl, 'http://localhost:3000', 'http://localhost:3100'];
app.use(cors({
  origin: (origin, cb) =>
    (!origin || allowedOrigins.includes(origin)) ? cb(null, true) : cb(new Error('Not allowed by CORS')),
  credentials: false,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Health check
app.get('/health', async (_req, res) => {
  try {
    await Promise.all([
      cacheRedis.ping(),
      prisma.$queryRaw`SELECT 1`,
    ]);
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', timestamp: new Date().toISOString() });
  }
});

// Blanket per-IP cap on all /api/* traffic. Auth routes stack their own
// tighter limits on top. Telegram's webhook is skipped inside apiLimiter.
app.use('/api', apiLimiter);

// Routes - Order matters! More specific routes must come before catch-all routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/telegram', telegramRoutes); // bot webhook + setup (no JWT)
app.use('/api/email', emailRoutes); // one-click unsubscribe (no JWT)
app.use('/api/cta', ctaRoutes);
app.use('/api', favoriteRoutes);  // Catch-all for /api/* (requires auth)

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Sentry error handler — must come before our own error handler.
// No-op when SENTRY_DSN isn't set.
Sentry.setupExpressErrorHandler(app);

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = config.port;
let notificationWorker: ReturnType<typeof createNotificationWorker> | null = null;

const server = app.listen(PORT, () => {
  logger.info(`CTA Track API server started on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`Schedule timezone: ${config.scheduleTimezone}`);
  if (sentryEnabled) logger.info('Sentry error reporting enabled');

  startScheduler();

  // By default, run the BullMQ worker inside the API process so that a
  // single-process deploy ("npm start") actually delivers notifications.
  // Set RUN_WORKER_IN_PROCESS=false when scaling out with a dedicated
  // worker container (e.g. `npm run worker`) to avoid double-processing.
  if (config.runWorkerInProcess) {
    notificationWorker = createNotificationWorker();
    logger.info('Notification worker running in-process');
  } else {
    logger.info('RUN_WORKER_IN_PROCESS=false — expecting a separate worker process');
  }
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully`);
  stopScheduler();
  const hardExit = setTimeout(() => process.exit(1), 10_000);
  hardExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await notificationWorker?.close();
  await notificationQueue.close();
  await prisma.$disconnect();
  await Promise.allSettled([redis.quit(), cacheRedis.quit()]);
  clearTimeout(hardExit);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
