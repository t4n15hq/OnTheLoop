import { scheduleNotifications } from '../jobs/notification.job';
import logger from '../utils/logger';

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Start the notification scheduler
 * Checks every minute for scheduled notifications
 */
export function startScheduler() {
  if (schedulerInterval) {
    logger.warn('Scheduler already running');
    return;
  }

  logger.info('Starting notification scheduler');

  // Run immediately
  scheduleNotifications();

  // Run every minute
  schedulerInterval = setInterval(() => {
    scheduleNotifications();
  }, 60 * 1000); // 60 seconds

  logger.info('Notification scheduler started');
}

/**
 * Stop the notification scheduler
 */
export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('Notification scheduler stopped');
  }
}
