import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueAdd = vi.fn().mockResolvedValue(undefined);
const callOrder: string[] = [];

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: (...args: unknown[]) => {
      callOrder.push('queue.add');
      return queueAdd(...args);
    },
  })),
  Worker: vi.fn(),
}));

vi.mock('../utils/redis', () => ({ default: {} }));
vi.mock('../utils/db', () => ({ default: {} }));
vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/cta.service', () => ({ CTAService: {} }));
vi.mock('../services/telegram.service', () => ({
  TelegramService: { isConfigured: () => false, sendMessage: vi.fn() },
}));
vi.mock('../services/email.service', () => ({ default: { sendArrivalNotification: vi.fn() } }));

const getDueSchedules = vi.fn();
const markScheduleTriggered = vi.fn().mockImplementation(async () => {
  callOrder.push('markScheduleTriggered');
});

vi.mock('../services/favorite.service', () => ({
  FavoriteService: {
    getDueSchedules: (...args: unknown[]) => getDueSchedules(...args),
    markScheduleTriggered: (...args: unknown[]) => markScheduleTriggered(...args),
    getFavoriteById: vi.fn(),
  },
}));

describe('scheduleNotifications idempotency', () => {
  beforeEach(() => {
    queueAdd.mockClear();
    getDueSchedules.mockReset();
    markScheduleTriggered.mockClear();
    callOrder.length = 0;
  });

  it('stamps lastTriggeredAt BEFORE enqueuing, so a concurrent tick cannot double-fire', async () => {
    getDueSchedules.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', favoriteId: 'f1' },
    ]);

    const { scheduleNotifications } = await import('./notification.job');
    await scheduleNotifications();

    expect(markScheduleTriggered).toHaveBeenCalledTimes(1);
    expect(markScheduleTriggered).toHaveBeenCalledWith('s1', expect.any(Date));
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['markScheduleTriggered', 'queue.add']);
  });

  it('enqueues one job per due schedule, stamping each before its enqueue', async () => {
    getDueSchedules.mockResolvedValueOnce([
      { id: 'a', userId: 'u', favoriteId: 'fa' },
      { id: 'b', userId: 'u', favoriteId: 'fb' },
      { id: 'c', userId: 'u', favoriteId: 'fc' },
    ]);

    const { scheduleNotifications } = await import('./notification.job');
    await scheduleNotifications();

    expect(markScheduleTriggered).toHaveBeenCalledTimes(3);
    expect(queueAdd).toHaveBeenCalledTimes(3);

    // For every queue.add in the sequence, the immediately preceding event
    // must be a markScheduleTriggered.
    for (let i = 0; i < callOrder.length; i++) {
      if (callOrder[i] === 'queue.add') {
        expect(callOrder[i - 1]).toBe('markScheduleTriggered');
      }
    }
  });

  it('does nothing when no schedules are due', async () => {
    getDueSchedules.mockResolvedValueOnce([]);

    const { scheduleNotifications } = await import('./notification.job');
    await scheduleNotifications();

    expect(markScheduleTriggered).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('swallows scheduler errors so a single bad tick does not kill the loop', async () => {
    getDueSchedules.mockRejectedValueOnce(new Error('db unreachable'));

    const { scheduleNotifications } = await import('./notification.job');
    await expect(scheduleNotifications()).resolves.toBeUndefined();
  });
});
