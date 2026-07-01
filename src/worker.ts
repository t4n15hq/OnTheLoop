import './utils/sentry';
import dotenv from 'dotenv';
import http from 'http';
import logger from './utils/logger';
import { createNotificationWorker } from './jobs/notification.job';

// Load environment variables
dotenv.config();

logger.info('Starting notification worker...');

// Create and start the worker
const worker = createNotificationWorker();
const startedAt = Date.now();
const healthPort = parseInt(process.env.WORKER_HEALTH_PORT || process.env.PORT || '3001', 10);
const healthServer = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
});

healthServer.listen(healthPort, () => {
  logger.info(`Worker health endpoint listening on port ${healthPort}`);
});

logger.info('Notification worker started and ready to process jobs');

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, closing worker gracefully`);
  await worker.close();
  healthServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', async () => {
  await shutdown('SIGTERM');
});

process.on('SIGINT', async () => {
  await shutdown('SIGINT');
});
