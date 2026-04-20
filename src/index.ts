import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import config from './config';
import logger from './utils/logger';
import { startScheduler, stopScheduler } from './services/scheduler.service';
import { createNotificationWorker } from './jobs/notification.job';

// Import routes
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import favoriteRoutes from './routes/favorite.routes';
import telegramRoutes from './routes/telegram.routes';
import ctaRoutes from './routes/cta.routes';

const app = express();

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
        upgradeInsecureRequests: null, // Disable auto-upgrade to HTTPS since we don't have an SSL certificate yet
      },
    },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes - Order matters! More specific routes must come before catch-all routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/telegram', telegramRoutes); // bot webhook + setup (no JWT)
app.use('/api/cta', ctaRoutes);
app.use('/api', favoriteRoutes);  // Catch-all for /api/* (requires auth)

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = config.port;

const server = app.listen(PORT, () => {
  logger.info(`CTA Track API server started on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`Schedule timezone: ${config.scheduleTimezone}`);

  startScheduler();

  // By default, run the BullMQ worker inside the API process so that a
  // single-process deploy ("npm start") actually delivers notifications.
  // Set RUN_WORKER_IN_PROCESS=false when scaling out with a dedicated
  // worker container (e.g. `npm run worker`) to avoid double-processing.
  if (config.runWorkerInProcess) {
    createNotificationWorker();
    logger.info('Notification worker running in-process');
  } else {
    logger.info('RUN_WORKER_IN_PROCESS=false — expecting a separate worker process');
  }
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully`);
  stopScheduler();
  server.close(() => process.exit(0));
  // Hard-exit fallback if close hangs.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
