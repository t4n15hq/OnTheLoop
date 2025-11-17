import { Queue, Worker } from 'bullmq';
import redis from '../utils/redis';
import logger from '../utils/logger';
import { FavoriteService } from '../services/favorite.service';
import { CTAService } from '../services/cta.service';
import { SMSService } from '../services/sms.service';
import EmailService from '../services/email.service';
import { AuthService } from '../services/auth.service';

const NOTIFICATION_QUEUE_NAME = 'notifications';

// Create queue
export const notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
  connection: redis,
});

interface NotificationJobData {
  userId: string;
  favoriteId: string;
  phoneNumber: string;
}

/**
 * Process notification job
 */
async function processNotification(jobData: NotificationJobData) {
  const { userId, favoriteId, phoneNumber } = jobData;

  try {
    logger.info(`Processing notification for favorite ${favoriteId}`);

    // Get favorite details
    const favorite = await FavoriteService.getFavoriteById(favoriteId, userId);

    if (!favorite) {
      logger.error(`Favorite ${favoriteId} not found`);
      return;
    }

    // Fetch arrivals based on route type
    let arrivals;
    let title;

    if (favorite.routeType === 'TRAIN') {
      if (!favorite.stationId) {
        logger.error(`Train favorite ${favoriteId} missing stationId`);
        return;
      }

      arrivals = await CTAService.getTrainArrivals(
        favorite.stationId,
        favorite.routeId
      );
      title = favorite.name;
    } else {
      // BUS
      if (!favorite.stopId) {
        logger.error(`Bus favorite ${favoriteId} missing stopId`);
        return;
      }

      arrivals = await CTAService.getBusPredictions(
        favorite.stopId,
        favorite.routeId
      );
      title = favorite.name;
    }

    // Get user to check for email
    const user = await AuthService.getUserByPhone(phoneNumber);

    // Send SMS (if Twilio is configured and working)
    try {
      const message = CTAService.formatArrivalsForSMS(arrivals, title);
      await SMSService.sendSMS(phoneNumber, message);
      logger.info(`SMS notification sent for favorite ${favoriteId} to ${phoneNumber}`);
    } catch (smsError) {
      logger.warn(`Failed to send SMS for favorite ${favoriteId}:`, smsError);
    }

    // Send Email (if user has email configured)
    if (user?.email) {
      try {
        const formattedArrivals = arrivals.map(a => ({
          destination: a.destination,
          minutesAway: a.minutesAway.toString(),
        }));

        await EmailService.sendArrivalNotification(
          user.email,
          title,
          formattedArrivals,
          favorite.boardingStopName || undefined,
          favorite.alightingStopName || undefined
        );
        logger.info(`Email notification sent for favorite ${favoriteId} to ${user.email}`);
      } catch (emailError) {
        logger.warn(`Failed to send email for favorite ${favoriteId}:`, emailError);
      }
    }
  } catch (error) {
    logger.error(`Error processing notification for favorite ${favoriteId}:`, error);
    throw error;
  }
}

/**
 * Create notification worker
 */
export function createNotificationWorker() {
  const worker = new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      await processNotification(job.data);
    },
    {
      connection: redis,
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} failed:`, err);
  });

  return worker;
}

/**
 * Schedule notifications based on user schedules
 * This should be called periodically (e.g., every minute) to check for due notifications
 */
export async function scheduleNotifications() {
  try {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}`;
    const dayOfWeek = now.getDay();

    logger.debug(`Checking schedules for ${time}, day ${dayOfWeek}`);

    // Get all schedules that should run now
    const schedules = await FavoriteService.getSchedulesByTime(time, dayOfWeek);

    logger.info(`Found ${schedules.length} schedules to process`);

    // Queue notification jobs
    for (const schedule of schedules) {
      await notificationQueue.add(
        'send-notification',
        {
          userId: schedule.userId,
          favoriteId: schedule.favoriteId,
          phoneNumber: schedule.user.phoneNumber,
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        }
      );

      logger.info(
        `Queued notification for user ${schedule.userId}, favorite ${schedule.favoriteId}`
      );
    }
  } catch (error) {
    logger.error('Error scheduling notifications:', error);
  }
}
