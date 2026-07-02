/**
 * Live-updating arrivals board (#53).
 *
 * After answering with arrivals, the user can tap "🔴 Live" to turn the reply
 * into a departure board that `editMessageText`s the SAME message every ~30s
 * with fresh arrivals, auto-expiring after a bounded window (~5 min). A "Stop"
 * button ends it early.
 *
 * Implemented as short-lived BullMQ *delayed* jobs (not a repeatable) that
 * self-reschedule: each tick edits the message and enqueues the next tick, until
 * it hits the hard expiry or finds the board deactivated (stopped). This keeps
 * the chain to at most one pending job per board, so nothing orphans after
 * stop/expiry. A Redis flag (TTL = the window) is the source of truth for
 * "is this board still live", and doubles as the auto-expiry backstop.
 *
 * All external effects go through {@link LiveBoardDeps} so the tick, start, and
 * stop logic are unit-testable with fakes (BullMQ/Redis/Telegram mocked).
 */
import { Queue, Worker } from 'bullmq';
import redis from '../utils/redis';
import logger from '../utils/logger';
import { CTAService } from '../services/cta.service';
import { TelegramService, buildLiveBoardKeyboard } from '../services/telegram.service';
import { reportError } from '../utils/sentry';
import type { FormattedArrival } from '../types/cta.types';

const LIVE_BOARD_QUEUE_NAME = 'telegram-live-board';

/** Edit cadence. ~30s respects Telegram's edit rate limits comfortably. */
export const LIVE_BOARD_TICK_MS = 30_000;
/** Auto-expiry window. The board stops refreshing after this. */
export const LIVE_BOARD_WINDOW_MS = 5 * 60_000;

export interface LiveBoardJobData {
  chatId: string;
  messageId: number;
  routeType: 'BUS' | 'TRAIN';
  routeId: string;
  routeName: string;
  stopId: string;
  stopName: string;
  direction: string;
  /** Epoch ms after which the board stops refreshing (hard expiry). */
  expiresAt: number;
  /** 1-based tick counter — makes each scheduled tick's jobId unique. */
  tick: number;
}

export const liveBoardQueue = new Queue(LIVE_BOARD_QUEUE_NAME, { connection: redis });

/** Redis key marking a board as live. Deleted on stop; TTL-expires on window end. */
function activeKey(chatId: string, messageId: number): string {
  return `tg:live:${chatId}:${messageId}`;
}

function tickJobId(chatId: string, messageId: number, tick: number): string {
  return `live:${chatId}:${messageId}:${tick}`;
}

export interface LiveBoardDeps {
  getArrivals(data: LiveBoardJobData): Promise<FormattedArrival[]>;
  editMessage(chatId: string, messageId: number, text: string, replyMarkup?: unknown): Promise<void>;
  scheduleTick(data: LiveBoardJobData, delayMs: number): Promise<void>;
  isActive(chatId: string, messageId: number): Promise<boolean>;
  markActive(chatId: string, messageId: number, ttlMs: number): Promise<void>;
  clearActive(chatId: string, messageId: number): Promise<void>;
}

export const defaultLiveBoardDeps: LiveBoardDeps = {
  getArrivals: (data) =>
    data.routeType === 'TRAIN'
      ? CTAService.getTrainArrivals(data.stopId, data.routeId, data.direction || undefined)
      : CTAService.getBusPredictions(data.stopId, data.routeId, 3, data.direction || undefined),
  editMessage: (chatId, messageId, text, replyMarkup) =>
    TelegramService.editMessageText(chatId, messageId, text, { parseMode: 'HTML', replyMarkup }),
  scheduleTick: async (data, delayMs) => {
    await liveBoardQueue.add('tick', data, {
      delay: delayMs,
      jobId: tickJobId(data.chatId, data.messageId, data.tick),
      removeOnComplete: true,
      removeOnFail: true,
    });
  },
  isActive: async (chatId, messageId) =>
    (await redis.exists(activeKey(chatId, messageId))) === 1,
  markActive: async (chatId, messageId, ttlMs) => {
    await redis.set(activeKey(chatId, messageId), '1', 'PX', ttlMs);
  },
  clearActive: async (chatId, messageId) => {
    await redis.del(activeKey(chatId, messageId));
  },
};

/** Render the live board body (running). */
export function formatLiveBoard(
  data: Pick<LiveBoardJobData, 'routeName' | 'stopName' | 'expiresAt'>,
  arrivals: FormattedArrival[],
  now: number
): string {
  const title = data.routeName ? `${data.routeName} · ${data.stopName}` : data.stopName;
  const board = CTAService.formatArrivalsForSMS(arrivals, `🔴 LIVE · ${title}`);
  const remainingMin = Math.max(0, Math.ceil((data.expiresAt - now) / 60_000));
  return `${board}\n\n<i>Auto-updating every 30s — stops in ~${remainingMin} min.</i>`;
}

/** Render the final board body (expired). No Stop button is attached. */
export function formatLiveBoardEnded(
  data: Pick<LiveBoardJobData, 'routeName' | 'stopName'>,
  arrivals: FormattedArrival[]
): string {
  const title = data.routeName ? `${data.routeName} · ${data.stopName}` : data.stopName;
  const board = CTAService.formatArrivalsForSMS(arrivals, `⏹ ${title} · live ended`);
  return `${board}\n\n<i>Live updates ended. Tap 🔴 Live again for fresh times.</i>`;
}

export interface LiveBoardTickResult {
  rescheduled: boolean;
  reason: 'stopped' | 'expired' | 'ticked';
}

/**
 * One board tick. Returns what it did (useful for tests):
 *   - stopped:  board was deactivated (Stop tapped) → exit, no edit, no reschedule.
 *   - expired:  past the hard window → finalize the message (drops Stop button), stop.
 *   - ticked:   refreshed arrivals in place, kept the Stop button, scheduled next tick.
 */
export async function runLiveBoardTick(
  data: LiveBoardJobData,
  deps: LiveBoardDeps = defaultLiveBoardDeps,
  now: number = Date.now()
): Promise<LiveBoardTickResult> {
  const { chatId, messageId } = data;

  // Stopped early: the stop handler already updated the UI. Just exit.
  if (!(await deps.isActive(chatId, messageId))) {
    return { rescheduled: false, reason: 'stopped' };
  }

  // Hard window expiry: finalize the board and don't reschedule.
  if (now >= data.expiresAt) {
    await deps.clearActive(chatId, messageId);
    let arrivals: FormattedArrival[] = [];
    try {
      arrivals = await deps.getArrivals(data);
    } catch (err) {
      logger.warn(`Live board final fetch failed for chat ${chatId}:`, err);
    }
    await deps.editMessage(chatId, messageId, formatLiveBoardEnded(data, arrivals));
    return { rescheduled: false, reason: 'expired' };
  }

  // Normal tick: refresh in place, keep the Stop button, schedule the next tick.
  let arrivals: FormattedArrival[] = [];
  try {
    arrivals = await deps.getArrivals(data);
  } catch (err) {
    logger.warn(`Live board fetch failed for chat ${chatId}:`, err);
  }
  await deps.editMessage(
    chatId,
    messageId,
    formatLiveBoard(data, arrivals, now),
    buildLiveBoardKeyboard()
  );
  await deps.scheduleTick({ ...data, tick: data.tick + 1 }, LIVE_BOARD_TICK_MS);
  return { rescheduled: true, reason: 'ticked' };
}

export interface StartLiveBoardParams {
  chatId: string;
  messageId: number;
  routeType: 'BUS' | 'TRAIN';
  routeId: string;
  routeName: string;
  stopId: string;
  stopName: string;
  direction: string;
}

/**
 * Begin a live board for an already-sent board message: mark it active (with a
 * TTL == the window, so it auto-expires even if the process dies) and enqueue
 * the first tick.
 */
export async function startLiveBoard(
  params: StartLiveBoardParams,
  deps: LiveBoardDeps = defaultLiveBoardDeps,
  now: number = Date.now()
): Promise<void> {
  // TTL runs a couple ticks past the hard window so the expiry tick wins the
  // race and finalizes the board (dropping the Stop button) before the flag
  // vanishes. The flag is only a backstop for orphaned boards if a process dies.
  await deps.markActive(
    params.chatId,
    params.messageId,
    LIVE_BOARD_WINDOW_MS + 2 * LIVE_BOARD_TICK_MS
  );
  const data: LiveBoardJobData = { ...params, expiresAt: now + LIVE_BOARD_WINDOW_MS, tick: 1 };
  await deps.scheduleTick(data, LIVE_BOARD_TICK_MS);
}

/**
 * Stop a board early (Stop button). Clears the active flag so the one pending
 * tick self-terminates within a cycle (no orphaned jobs), and edits the message
 * to drop the Stop button.
 */
export async function stopLiveBoard(
  chatId: string,
  messageId: number,
  deps: LiveBoardDeps = defaultLiveBoardDeps
): Promise<void> {
  await deps.clearActive(chatId, messageId);
  await deps.editMessage(chatId, messageId, '<i>Live updates stopped.</i>');
}

export function createLiveBoardWorker(): Worker {
  const worker = new Worker(
    LIVE_BOARD_QUEUE_NAME,
    async (job) => {
      await runLiveBoardTick(job.data as LiveBoardJobData);
    },
    { connection: redis, concurrency: 20 }
  );

  worker.on('failed', (job, err) => {
    reportError(err, { queue: LIVE_BOARD_QUEUE_NAME, jobId: job?.id });
  });

  return worker;
}
