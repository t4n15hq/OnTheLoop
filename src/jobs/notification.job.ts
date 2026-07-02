import { Queue, Worker } from 'bullmq';
import redis from '../utils/redis';
import logger from '../utils/logger';
import prisma from '../utils/db';
import { FavoriteService } from '../services/favorite.service';
import { CTAService } from '../services/cta.service';
import { TelegramService, buildPingKeyboard } from '../services/telegram.service';
import EmailService from '../services/email.service';
import { Channel } from '@prisma/client';
import config from '../config';
import { reportError } from '../utils/sentry';
import { hasWalkGeometry } from '../utils/walk-time';

/**
 * "Leave now" phrasing for walk-time-aware pings (#38). Fires at
 * arrival − leadMinutes − walkMinutes, so the rider has `leadMinutes` of runway
 * before they must walk out the door.
 */
function buildLeaveMessage(
  leadMinutes: number,
  favorite: { routeType: string; routeId: string; boardingStopName: string | null; name: string }
): string {
  const route =
    favorite.routeType === 'TRAIN' ? `${favorite.routeId} Line` : `${favorite.routeId} bus`;
  const stop = favorite.boardingStopName || favorite.name;
  const when = leadMinutes > 0 ? `Leave in ${leadMinutes} min` : 'Leave now';
  return `${when} to catch the ${route} at ${stop}.`;
}

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
    // Walk-time-aware pings (#38): when the schedule carries a start location,
    // lead the message with the "leave now" action. Otherwise fall back to the
    // favorite's name exactly as before (backward compatible).
    const title =
      schedule && hasWalkGeometry(schedule)
        ? buildLeaveMessage(schedule.leadMinutes, favorite)
        : favorite.name;
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
        // Attach quick-action buttons (snooze / mute today / next one) so users
        // can act on the ping without opening the app. See TelegramController.
        await TelegramService.sendMessage(user.telegramChatId!, body, {
          parseMode: 'HTML',
          replyMarkup: buildPingKeyboard(favorite.id, scheduleId),
        });
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
          user.id,
          user.email,
          title,
          formatted,
          favorite.boardingStopName || undefined,
          favorite.alightingStopName || undefined
        );
        if (ok) {
          logger.info(`Email notification sent for favorite ${favoriteId} to user ${userId}`);
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
    reportError(error, { job: 'process-notification', userId, favoriteId, scheduleId, kind });
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
    { connection: redis, concurrency: 10 }
  );

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    reportError(err, { queue: NOTIFICATION_QUEUE_NAME, jobId: job?.id, jobName: job?.name });
  });

  return worker;
}

/**
 * Scan active schedules whose effective fire minute matches now and enqueue a
 * job per match. Dedupe is two-layered and safe across multiple replicas:
 *   1. An atomic DB compare-and-swap ({@link FavoriteService.claimSchedule})
 *      guarantees exactly one caller wins the claim for a given minute window.
 *   2. A deterministic BullMQ `jobId` (`${scheduleId}:${windowStart}`) makes a
 *      duplicate enqueue for the same window a no-op at the queue layer.
 * The claim happens BEFORE the enqueue; if the enqueue fails we roll the claim
 * back so the next tick re-delivers instead of leaving it falsely marked (#12).
 */
export async function scheduleNotifications() {
  try {
    const now = new Date();
    // Start of the current minute — the dedupe window shared by concurrent ticks.
    const windowStart = new Date(now);
    windowStart.setSeconds(0, 0);

    const due = await FavoriteService.getDueSchedules(now);

    if (due.length > 0) {
      logger.info(`Found ${due.length} schedule(s) due to fire`);
    } else {
      logger.debug('No schedules due this minute');
    }

    for (const schedule of due) {
      // Atomic compare-and-swap: only the caller that flips lastTriggeredAt for
      // this window may enqueue. Concurrent replicas / re-entrant ticks lose the
      // race, get `false`, and skip — no double-send.
      const claimed = await FavoriteService.claimSchedule(schedule.id, windowStart, now);
      if (!claimed) {
        logger.debug(`Schedule ${schedule.id} already claimed for this window; skipping`);
        continue;
      }

      try {
        await notificationQueue.add(
          'send-notification',
          {
            userId: schedule.userId,
            favoriteId: schedule.favoriteId,
            scheduleId: schedule.id,
            kind: 'SCHEDULED',
          } satisfies NotificationJobData,
          {
            // Deterministic id → BullMQ drops a duplicate enqueue for the same
            // window as a second dedupe layer behind the DB claim.
            jobId: `${schedule.id}:${windowStart.toISOString()}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 500 },
          }
        );
        logger.info(`Queued notification for schedule ${schedule.id} (user ${schedule.userId})`);
      } catch (err) {
        // Enqueue failed after we claimed the window (e.g. Redis down). Roll the
        // claim back so the schedule isn't left marked-but-undelivered.
        logger.error(`Enqueue failed for schedule ${schedule.id}; rolling back claim:`, err);
        await FavoriteService.releaseSchedule(schedule.id, schedule.lastTriggeredAt ?? null);
      }
    }
  } catch (error) {
    reportError(error, { job: 'schedule-notifications' });
  }
}

/** How long a "Snooze 5m" button defers a re-delivery. */
export const SNOOZE_DELAY_MS = 5 * 60 * 1000;

/**
 * Re-deliver a ping after {@link SNOOZE_DELAY_MS} — powers the "Snooze 5m"
 * inline button. A one-off delayed job that reuses the normal notification
 * path (so it still respects mute/quiet-hours at fire time). Not deduped by a
 * window jobId: an explicit snooze is always its own fresh delivery.
 */
export async function enqueueSnoozeNotification(params: {
  userId: string;
  favoriteId: string;
  scheduleId?: string;
}) {
  await notificationQueue.add(
    'send-notification',
    {
      userId: params.userId,
      favoriteId: params.favoriteId,
      scheduleId: params.scheduleId,
      kind: 'SCHEDULED',
    } satisfies NotificationJobData,
    {
      delay: SNOOZE_DELAY_MS,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    }
  );
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
