/**
 * Live-updating arrivals board (#53). The tick/start/stop logic is exercised
 * through injected {@link LiveBoardDeps} fakes, so no real BullMQ/Redis/Telegram
 * is touched. Module-load side effects (Queue construction, redis import) are
 * mocked the way notification.job.test.ts does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn(),
}));
vi.mock('../utils/redis', () => ({ default: {} }));
vi.mock('../utils/sentry', () => ({ reportError: vi.fn() }));
vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/cta.service', () => ({
  CTAService: { formatArrivalsForSMS: vi.fn((_a: unknown, title: string) => `[${title}]`) },
}));
vi.mock('../services/telegram.service', () => ({
  buildLiveBoardKeyboard: () => ({ inline_keyboard: [[{ text: 'Stop', callback_data: 'ls' }]] }),
  TelegramService: { editMessageText: vi.fn() },
}));

import {
  runLiveBoardTick,
  startLiveBoard,
  stopLiveBoard,
  LIVE_BOARD_TICK_MS,
  LIVE_BOARD_WINDOW_MS,
  type LiveBoardDeps,
  type LiveBoardJobData,
} from './live-board.job';

function makeDeps(): { [K in keyof LiveBoardDeps]: ReturnType<typeof vi.fn> } {
  return {
    getArrivals: vi.fn().mockResolvedValue([]),
    editMessage: vi.fn().mockResolvedValue(undefined),
    scheduleTick: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockResolvedValue(true),
    markActive: vi.fn().mockResolvedValue(undefined),
    clearActive: vi.fn().mockResolvedValue(undefined),
  };
}

const BASE: Omit<LiveBoardJobData, 'expiresAt' | 'tick'> = {
  chatId: '123',
  messageId: 5,
  routeType: 'BUS',
  routeId: '22',
  routeName: 'Route 22',
  stopId: 'stop-1',
  stopName: 'Clark & Belmont',
  direction: 'Northbound',
};

describe('startLiveBoard (#53)', () => {
  it('marks the board active and schedules the first tick', async () => {
    const deps = makeDeps();
    await startLiveBoard(BASE, deps as unknown as LiveBoardDeps, 1_000);

    // TTL is the window plus a small grace so the expiry tick wins the race.
    expect(deps.markActive).toHaveBeenCalledWith('123', 5, LIVE_BOARD_WINDOW_MS + 2 * LIVE_BOARD_TICK_MS);
    expect(deps.scheduleTick).toHaveBeenCalledTimes(1);
    const [data, delay] = deps.scheduleTick.mock.calls[0];
    expect(delay).toBe(LIVE_BOARD_TICK_MS);
    expect(data.tick).toBe(1);
    expect(data.expiresAt).toBe(1_000 + LIVE_BOARD_WINDOW_MS);
  });
});

describe('runLiveBoardTick (#53)', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('refreshes the message in place and schedules the next tick while live', async () => {
    const data: LiveBoardJobData = { ...BASE, expiresAt: 100_000, tick: 1 };
    const res = await runLiveBoardTick(data, deps as unknown as LiveBoardDeps, 5_000);

    expect(res).toEqual({ rescheduled: true, reason: 'ticked' });
    expect(deps.editMessage).toHaveBeenCalledTimes(1);
    // A running board keeps its Stop button (4th arg present).
    expect(deps.editMessage.mock.calls[0][3]).toBeTruthy();
    // Next tick scheduled with an incremented counter.
    expect(deps.scheduleTick).toHaveBeenCalledWith(
      expect.objectContaining({ tick: 2 }),
      LIVE_BOARD_TICK_MS
    );
  });

  it('finalizes and stops (no reschedule) once past the expiry window', async () => {
    const data: LiveBoardJobData = { ...BASE, expiresAt: 5_000, tick: 4 };
    const res = await runLiveBoardTick(data, deps as unknown as LiveBoardDeps, 5_000);

    expect(res).toEqual({ rescheduled: false, reason: 'expired' });
    expect(deps.clearActive).toHaveBeenCalledWith('123', 5);
    expect(deps.scheduleTick).not.toHaveBeenCalled();
    // Final edit drops the Stop button (no 4th arg).
    expect(deps.editMessage).toHaveBeenCalledTimes(1);
    expect(deps.editMessage.mock.calls[0][3]).toBeUndefined();
  });

  it('exits silently when the board was stopped (no edit, no reschedule)', async () => {
    deps.isActive.mockResolvedValue(false);
    const data: LiveBoardJobData = { ...BASE, expiresAt: 100_000, tick: 2 };
    const res = await runLiveBoardTick(data, deps as unknown as LiveBoardDeps, 5_000);

    expect(res).toEqual({ rescheduled: false, reason: 'stopped' });
    expect(deps.editMessage).not.toHaveBeenCalled();
    expect(deps.scheduleTick).not.toHaveBeenCalled();
  });

  it('still ticks (with empty arrivals) if the CTA fetch throws', async () => {
    deps.getArrivals.mockRejectedValue(new Error('CTA down'));
    const data: LiveBoardJobData = { ...BASE, expiresAt: 100_000, tick: 1 };
    const res = await runLiveBoardTick(data, deps as unknown as LiveBoardDeps, 5_000);

    expect(res.rescheduled).toBe(true);
    expect(deps.editMessage).toHaveBeenCalledTimes(1);
    expect(deps.scheduleTick).toHaveBeenCalledTimes(1);
  });
});

describe('stopLiveBoard (#53)', () => {
  it('clears the active flag and edits the message to drop the Stop button', async () => {
    const deps = makeDeps();
    await stopLiveBoard('123', 5, deps as unknown as LiveBoardDeps);

    expect(deps.clearActive).toHaveBeenCalledWith('123', 5);
    expect(deps.editMessage).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, keyboard] = deps.editMessage.mock.calls[0];
    expect(chatId).toBe('123');
    expect(messageId).toBe(5);
    expect(String(text).toLowerCase()).toContain('stopped');
    expect(keyboard).toBeUndefined();
  });
});
