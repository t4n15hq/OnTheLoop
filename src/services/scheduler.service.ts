import { scheduleNotifications } from '../jobs/notification.job';
import logger from '../utils/logger';

let schedulerTimeout: NodeJS.Timeout | null = null;
let running = false;
let stopped = false;

/**
 * Start the notification scheduler.
 *
 * We aim to fire once per clock minute, near the :00-second mark, so a schedule
 * for 08:45 is evaluated promptly (not at 08:45:52 or 08:46:01). `setInterval`
 * drifts — this self-corrects by computing the delay to the next minute boundary
 * after every tick and using a single-flight guard so a slow DB round-trip
 * can't cause overlapping runs.
 */
export function startScheduler() {
  if (schedulerTimeout) {
    logger.warn('Scheduler already running');
    return;
  }

  stopped = false;
  logger.info('Starting notification scheduler');

  const tick = async () => {
    if (stopped) return;
    if (running) {
      // Prior tick hasn't finished — skip this one, it'll pick up on the next minute.
      logger.warn('Scheduler tick skipped (previous run still in flight)');
    } else {
      running = true;
      try {
        await scheduleNotifications();
      } catch (err) {
        logger.error('Scheduler tick failed:', err);
      } finally {
        running = false;
      }
    }
    if (!stopped) {
      schedulerTimeout = setTimeout(tick, msToNextMinute());
    }
  };

  // Run once immediately so schedules enabled right now still fire this minute,
  // then align to the minute boundary.
  schedulerTimeout = setTimeout(tick, 0);
  logger.info('Notification scheduler started');
}

export function stopScheduler() {
  stopped = true;
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
    logger.info('Notification scheduler stopped');
  }
}

/** Milliseconds until the next :00-second mark, plus a 200ms safety margin. */
function msToNextMinute(): number {
  const now = new Date();
  return 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 200;
}
