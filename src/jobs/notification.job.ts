import { Queue, Worker } from 'bullmq';
import redis from '../utils/redis';
import logger from '../utils/logger';
import prisma from '../utils/db';
import { FavoriteService } from '../services/favorite.service';
import { CTAService } from '../services/cta.service';
import { TelegramService } from '../services/telegram.service';
import EmailService from '../services/email.service';

const NOTIFICATION_QUEUE_NAME = 'notifications';

export const notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
  connection: redis,
});

interface NotificationJobData {
  userId: string;
  favoriteId: string;
}

async function processNotification(jobData: NotificationJobData) {
  const { userId, favoriteId } = jobData;

  try {
    logger.info(`Processing notification for favorite ${favoriteId}`);

    const favorite = await FavoriteService.getFavoriteById(favoriteId, userId);
    if (!favorite) {
      logger.error(`Favorite ${favoriteId} not found`);
      return;
    }

    let arrivals;
    const title = favorite.name;

    if (favorite.routeType === 'TRAIN') {
      if (!favorite.stationId) {
        logger.error(`Train favorite ${favoriteId} missing stationId`);
        return;
      }
      arrivals = await CTAService.getTrainArrivals(
        favorite.stationId,
        favorite.routeId,
        favorite.direction || undefined
      );
    } else {
      if (!favorite.stopId) {
        logger.error(`Bus favorite ${favoriteId} missing stopId`);
        return;
      }
      arrivals = await CTAService.getBusPredictions(
        favorite.stopId,
        favorite.routeId,
        3,
        favorite.direction || undefined
      );
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      logger.error(`User ${userId} not found`);
      return;
    }

    let delivered = false;

    // Primary channel: Telegram (if linked)
    if (user.telegramChatId && TelegramService.isConfigured()) {
      try {
        const body = CTAService.formatArrivalsForSMS(arrivals, title);
        await TelegramService.sendMessage(user.telegramChatId, body);
        delivered = true;
        logger.info(`Telegram notification sent for favorite ${favoriteId} to chat ${user.telegramChatId}`);
      } catch (err) {
        logger.warn(`Telegram delivery failed for favorite ${favoriteId}:`, err);
      }
    }

    // Secondary channel: email, if the user opted in (and has one on file)
    if (user.email && user.emailNotifications) {
      try {
        const formatted = arrivals.map((a) => ({
          destination: a.destination,
          minutesAway: a.minutesAway.toString(),
        }));
        await EmailService.sendArrivalNotification(
          user.email,
          title,
          formatted,
          favorite.boardingStopName || undefined,
          favorite.alightingStopName || undefined
        );
        delivered = true;
        logger.info(`Email notification sent for favorite ${favoriteId} to ${user.email}`);
      } catch (err) {
        logger.warn(`Email delivery failed for favorite ${favoriteId}:`, err);
      }
    }

    if (!delivered) {
      logger.warn(
        `No delivery channel for user ${userId} (favorite ${favoriteId}). ` +
        `Link Telegram or enable email notifications.`
      );
    }
  } catch (error) {
    logger.error(`Error processing notification for favorite ${favoriteId}:`, error);
    throw error;
  }
}

export function createNotificationWorker() {
  const worker = new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      await processNotification(job.data);
    },
    { connection: redis }
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
 * Scan active schedules for the current time and enqueue jobs.
 * Called once a minute by the scheduler.
 */
export async function scheduleNotifications() {
  try {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dayOfWeek = now.getDay();

    logger.debug(`Checking schedules for ${time}, day ${dayOfWeek}`);

    const schedules = await FavoriteService.getSchedulesByTime(time, dayOfWeek);
    logger.info(`Found ${schedules.length} schedules to process`);

    for (const schedule of schedules) {
      await notificationQueue.add(
        'send-notification',
        {
          userId: schedule.userId,
          favoriteId: schedule.favoriteId,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        }
      );
      logger.info(`Queued notification for user ${schedule.userId}, favorite ${schedule.favoriteId}`);
    }
  } catch (error) {
    logger.error('Error scheduling notifications:', error);
  }
}
