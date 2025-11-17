import dotenv from 'dotenv';
import logger from './utils/logger';
import { createNotificationWorker } from './jobs/notification.job';

// Load environment variables
dotenv.config();

logger.info('Starting notification worker...');

// Create and start the worker
const worker = createNotificationWorker();

logger.info('Notification worker started and ready to process jobs');

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing worker gracefully');
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing worker gracefully');
  await worker.close();
  process.exit(0);
});
