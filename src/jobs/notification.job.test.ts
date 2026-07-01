import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- BullMQ: capture enqueues (args + options) ---------------------------
const queueAdd = vi.fn();
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: (...args: unknown[]) => queueAdd(...args),
  })),
  Worker: vi.fn(),
}));

// --- Prisma: the atomic claim (updateMany) + rollback (update) -----------
// The real FavoriteService.claimSchedule / releaseSchedule run against these,
// so the compare-and-swap is exercised for real; we just control what the DB
// "returns" (count 1 = claim won, count 0 = lost the race).
const updateMany = vi.fn();
const scheduleUpdate = vi.fn();
vi.mock('../utils/db', () => ({
  default: {
    schedule: {
      updateMany: (...args: unknown[]) => updateMany(...args),
      update: (...args: unknown[]) => scheduleUpdate(...args),
    },
  },
}));

vi.mock('../utils/redis', () => ({ default: {} }));
vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/cta.service', () => ({ CTAService: {} }));
vi.mock('../services/telegram.service', () => ({
  TelegramService: { isConfigured: () => false, sendMessage: vi.fn() },
}));
vi.mock('../services/email.service', () => ({ default: { sendArrivalNotification: vi.fn() } }));

// Keep the REAL FavoriteService (so claimSchedule / releaseSchedule actually
// hit the mocked prisma above), but stub the candidate query so each test can
// inject a fixed "due" list.
const getDueSchedules = vi.fn();
const getFavoriteById = vi.fn();
vi.mock('../services/favorite.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/favorite.service')>();
  (actual.FavoriteService as unknown as Record<string, unknown>).getDueSchedules = (
    ...args: unknown[]
  ) => getDueSchedules(...args);
  (actual.FavoriteService as unknown as Record<string, unknown>).getFavoriteById = (
    ...args: unknown[]
  ) => getFavoriteById(...args);
  return actual;
});

describe('scheduleNotifications atomic claim', () => {
  beforeEach(() => {
    queueAdd.mockReset().mockResolvedValue(undefined);
    updateMany.mockReset();
    scheduleUpdate.mockReset().mockResolvedValue({});
    getDueSchedules.mockReset();
    getFavoriteById.mockReset();
  });

  it('two concurrent runs on the same window enqueue exactly ONE job', async () => {
    // Both ticks see the same schedule as due...
    getDueSchedules.mockResolvedValue([
      { id: 's1', userId: 'u1', favoriteId: 'f1', lastTriggeredAt: null },
    ]);
    // ...but only the first claim flips the row (count 1); the loser gets 0.
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const { scheduleNotifications } = await import('./notification.job');
    await Promise.all([scheduleNotifications(), scheduleNotifications()]);

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(queueAdd).toHaveBeenCalledTimes(1);

    // Deterministic, window-scoped jobId is the second dedupe layer.
    const opts = queueAdd.mock.calls[0][2] as { jobId?: string };
    expect(opts.jobId).toMatch(/^s1:.+Z$/);
  });

  it('does not enqueue when the claim is lost (count 0)', async () => {
    getDueSchedules.mockResolvedValue([
      { id: 's3', userId: 'u', favoriteId: 'f', lastTriggeredAt: new Date() },
    ]);
    updateMany.mockResolvedValueOnce({ count: 0 });

    const { scheduleNotifications } = await import('./notification.job');
    await scheduleNotifications();

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('enqueue failure does not leave the schedule marked delivered (rolls the claim back)', async () => {
    getDueSchedules.mockResolvedValue([
      { id: 's2', userId: 'u', favoriteId: 'f', lastTriggeredAt: null },
    ]);
    updateMany.mockResolvedValueOnce({ count: 1 }); // claim wins
    queueAdd.mockRejectedValueOnce(new Error('redis down')); // enqueue fails

    const { scheduleNotifications } = await import('./notification.job');
    await expect(scheduleNotifications()).resolves.toBeUndefined();

    expect(queueAdd).toHaveBeenCalledTimes(1);
    // Rollback restores the previous lastTriggeredAt (null) so the next tick retries.
    expect(scheduleUpdate).toHaveBeenCalledWith({
      where: { id: 's2' },
      data: { lastTriggeredAt: null },
    });
  });

  it('does nothing when no schedules are due', async () => {
    getDueSchedules.mockResolvedValue([]);

    const { scheduleNotifications } = await import('./notification.job');
    await scheduleNotifications();

    expect(updateMany).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('swallows scheduler errors so a single bad tick does not kill the loop', async () => {
    getDueSchedules.mockRejectedValueOnce(new Error('db unreachable'));

    const { scheduleNotifications } = await import('./notification.job');
    await expect(scheduleNotifications()).resolves.toBeUndefined();
  });
});
