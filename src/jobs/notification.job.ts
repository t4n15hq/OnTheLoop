import { Queue, Worker } from 'bullmq';
import redis from '../utils/redis';
import logger from '../utils/logger';
import prisma from '../utils/db';
import { FavoriteService } from '../services/favorite.service';
import { CTAService } from '../services/cta.service';
import { TelegramService } from '../services/telegram.service';
import EmailService from '../services/email.service';
import { Channel } from '@prisma/client';
import config from '../config';

const NOTIFICATION_QUEUE_NAME = 'notifications';

/** HH:mm in the configured schedule timezone (default America/Chicago). */
function currentLocalHHmm(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: config.scheduleTimezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour === '24' ? '00' : hour}:${minute}`;
}

/**
 * Returns true if `current` (HH:mm) falls inside the quiet-hours window.
 * Windows that wrap midnight (e.g. 22:00 → 07:00) are supported.
 * End is exclusive: end == current means quiet hours just ended.
 */
function isInQuietWindow(current: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) {
    return current >= start && current < end;
  }
  // Wraps midnight.
  return current >= start || current < end;
}

export const notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
  connection: redis,
});

interface NotificationJobData {
  userId: string;
  favoriteId: string;
  scheduleId?: string;
  /** "SCHEDULED" (default) | "TEST" — logged and used to bypass pause on test. */
  kind?: 'SCHEDULED' | 'TEST';
  /** Channel override. If omitted, uses the schedule's channel field. */
  channel?: Channel;
}

async function recordLog(params: {
  userId: string;
  scheduleId?: string | null;
  channel: 'EMAIL' | 'TELEGRAM';
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  detail?: string;
  kind?: 'SCHEDULED' | 'TEST';
}) {
  try {
    await prisma.notificationLog.create({
      data: {
        userId: params.userId,
        scheduleId: params.scheduleId ?? null,
        channel: params.channel,
        status: params.status,
        detail: params.detail,
        kind: params.kind ?? 'SCHEDULED',
      },
    });
  } catch (err) {
    logger.error('Failed to write notification log:', err);
  }
}

async function processNotification(jobData: NotificationJobData) {
  const { userId, favoriteId, scheduleId, kind = 'SCHEDULED' } = jobData;

  try {
    logger.info(`Processing notification for favorite ${favoriteId} (${kind})`);

    const favorite = await FavoriteService.getFavoriteById(favoriteId, userId);
    if (!favorite) {
      logger.error(`Favorite ${favoriteId} not found`);
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      logger.error(`User ${userId} not found`);
      return;
    }

    // Respect global mute for scheduled deliveries. Tests always go through —
    // the point of a test is to confirm delivery works.
    if (
      kind === 'SCHEDULED' &&
      user.notificationsPausedUntil &&
      user.notificationsPausedUntil > new Date()
    ) {
      const until = user.notificationsPausedUntil.toISOString();
      logger.info(`Skipping: notifications paused until ${until} for user ${userId}`);
      await recordLog({
        userId,
        scheduleId,
        channel: 'EMAIL',
        status: 'SKIPPED',
        detail: `Notifications paused until ${until}`,
        kind,
      });
      return;
    }

    // Recurring quiet hours: skip scheduled deliveries only (tests bypass).
    if (
      kind === 'SCHEDULED' &&
      user.quietHoursStart &&
      user.quietHoursEnd &&
      isInQuietWindow(currentLocalHHmm(), user.quietHoursStart, user.quietHoursEnd)
    ) {
      const reason = `Quiet hours ${user.quietHoursStart}–${user.quietHoursEnd}`;
      logger.info(`Skipping: ${reason} for user ${userId}`);
      await recordLog({
        userId,
        scheduleId,
        channel: 'EMAIL',
        status: 'SKIPPED',
        detail: reason,
        kind,
      });
      return;
    }

    // Figure out which channels to hit.
    const schedule = scheduleId
      ? await prisma.schedule.findUnique({ where: { id: scheduleId } })
      : null;
    const channelPref: Channel = jobData.channel ?? schedule?.channel ?? Channel.AUTO;
    const telegramReady = Boolean(user.telegramChatId && TelegramService.isConfigured());
    const emailReady = Boolean(user.email && user.emailNotifications);

    const shouldSendTelegram =
      telegramReady &&
      (channelPref === Channel.TELEGRAM ||
        channelPref === Channel.BOTH ||
        channelPref === Channel.AUTO);

    // AUTO prefers Telegram when linked; only falls back to email when not.
    const shouldSendEmail =
      emailReady &&
      (channelPref === Channel.EMAIL ||
        channelPref === Channel.BOTH ||
        (channelPref === Channel.AUTO && !telegramReady));

    if (!shouldSendTelegram && !shouldSendEmail) {
      const reason = channelSkipReason(channelPref, telegramReady, emailReady);
      logger.warn(
        `No delivery channel for user ${userId} (favorite ${favoriteId}): ${reason}`
      );
      await recordLog({
        userId,
        scheduleId,
        channel: channelPref === Channel.TELEGRAM ? 'TELEGRAM' : 'EMAIL',
        status: 'SKIPPED',
        detail: reason,
        kind,
      });
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

    if (shouldSendTelegram) {
      try {
        const body = CTAService.formatArrivalsForSMS(arrivals, title);
        await TelegramService.sendMessage(user.telegramChatId!, body);
        logger.info(`Telegram notification sent for favorite ${favoriteId}`);
        await recordLog({ userId, scheduleId, channel: 'TELEGRAM', status: 'SENT', kind });
      } catch (err: any) {
        logger.warn(`Telegram delivery failed for favorite ${favoriteId}:`, err);
        await recordLog({
          userId,
          scheduleId,
          channel: 'TELEGRAM',
          status: 'FAILED',
          detail: err?.message ?? String(err),
          kind,
        });
      }
    }

    if (shouldSendEmail) {
      try {
        const formatted = arrivals.map((a) => ({
          destination: a.destination,
          minutesAway: a.minutesAway.toString(),
        }));
        const ok = await EmailService.sendArrivalNotification(
          user.email,
          title,
          formatted,
          favorite.boardingStopName || undefined,
          favorite.alightingStopName || undefined
        );
        if (ok) {
          logger.info(`Email notification sent for favorite ${favoriteId} to ${user.email}`);
          await recordLog({ userId, scheduleId, channel: 'EMAIL', status: 'SENT', kind });
        } else {
          await recordLog({
            userId,
            scheduleId,
            channel: 'EMAIL',
            status: 'FAILED',
            detail: 'Email service returned false (check EMAIL_USER/EMAIL_PASS)',
            kind,
          });
        }
      } catch (err: any) {
        logger.warn(`Email delivery failed for favorite ${favoriteId}:`, err);
        await recordLog({
          userId,
          scheduleId,
          channel: 'EMAIL',
          status: 'FAILED',
          detail: err?.message ?? String(err),
          kind,
        });
      }
    }
  } catch (error) {
    logger.error(`Error processing notification for favorite ${favoriteId}:`, error);
    throw error;
  }
}

function channelSkipReason(pref: Channel, telegramReady: boolean, emailReady: boolean): string {
  if (pref === Channel.TELEGRAM && !telegramReady) return 'Telegram channel chosen but Telegram not linked';
  if (pref === Channel.EMAIL && !emailReady) return 'Email channel chosen but email notifications disabled';
  if (pref === Channel.BOTH) return 'No channels available: link Telegram or enable email notifications';
  return 'No delivery channel: link Telegram or enable email notifications';
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
 * Scan active schedules whose effective fire minute matches now, enqueue a job
 * per match, and stamp `lastTriggeredAt` to prevent duplicate enqueues in the
 * same minute window.
 */
export async function scheduleNotifications() {
  try {
    const now = new Date();
    const due = await FavoriteService.getDueSchedules(now);

    if (due.length > 0) {
      logger.info(`Found ${due.length} schedule(s) due to fire`);
    } else {
      logger.debug('No schedules due this minute');
    }

    for (const schedule of due) {
      // Stamp BEFORE enqueueing so a concurrent tick / multi-instance deploy
      // can't double-fire.
      await FavoriteService.markScheduleTriggered(schedule.id, now);

      await notificationQueue.add(
        'send-notification',
        {
          userId: schedule.userId,
          favoriteId: schedule.favoriteId,
          scheduleId: schedule.id,
          kind: 'SCHEDULED',
        } satisfies NotificationJobData,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        }
      );
      logger.info(`Queued notification for schedule ${schedule.id} (user ${schedule.userId})`);
    }
  } catch (error) {
    logger.error('Error scheduling notifications:', error);
  }
}

/** Enqueue a one-off test delivery for the given schedule. */
export async function enqueueTestNotification(schedule: {
  id: string;
  userId: string;
  favoriteId: string;
}) {
  await notificationQueue.add(
    'send-notification',
    {
      userId: schedule.userId,
      favoriteId: schedule.favoriteId,
      scheduleId: schedule.id,
      kind: 'TEST',
    } satisfies NotificationJobData,
    {
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    }
  );
}
