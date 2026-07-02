import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Feed: injected per test -------------------------------------------------
const getActiveOutages = vi.fn();
vi.mock('../services/accessibility.service', () => ({
  AccessibilityService: { getActiveOutages: (...a: unknown[]) => getActiveOutages(...a) },
}));

// --- Prisma: control which opted-in users come back --------------------------
const userFindMany = vi.fn();
vi.mock('../utils/db', () => ({
  default: { user: { findMany: (...a: unknown[]) => userFindMany(...a) } },
}));

// --- Redis: SET NX dedup (OK = first time, null = already sent) ---------------
const redisSet = vi.fn();
const redisDel = vi.fn();
vi.mock('../utils/redis', () => ({
  default: {
    set: (...a: unknown[]) => redisSet(...a),
    del: (...a: unknown[]) => redisDel(...a),
  },
}));

// --- Telegram ----------------------------------------------------------------
const sendMessage = vi.fn();
const isConfigured = vi.fn(() => true);
vi.mock('../services/telegram.service', () => ({
  TelegramService: {
    isConfigured: () => isConfigured(),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
  },
  escapeHtml: (s: string) => s,
}));

// --- Quiet hours: controlled per test ----------------------------------------
const isQuietNow = vi.fn(() => false);
vi.mock('../utils/quiet-hours', () => ({ isQuietNow: (...a: unknown[]) => isQuietNow(...a) }));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/sentry', () => ({ reportError: vi.fn() }));

const OUTAGE = {
  id: '900:40530',
  alertId: '900',
  stationId: '40530',
  stationName: 'Diversey',
  equipment: 'ELEVATOR' as const,
  headline: 'Elevator out',
  shortDescription: 'Elevator to platform is out.',
  url: 'https://cta.example/900',
};

const savedUser = {
  id: 'u1',
  telegramChatId: 'chat-1',
  quietHoursStart: null,
  quietHoursEnd: null,
  favorites: [
    { stationId: '40530', boardingStopId: null, alightingStopId: null },
  ],
};

describe('scanAccessibilityAlerts', () => {
  beforeEach(() => {
    getActiveOutages.mockReset().mockResolvedValue([OUTAGE]);
    userFindMany.mockReset().mockResolvedValue([savedUser]);
    redisSet.mockReset().mockResolvedValue('OK'); // first time by default
    redisDel.mockReset().mockResolvedValue(1);
    sendMessage.mockReset().mockResolvedValue(undefined);
    isConfigured.mockReset().mockReturnValue(true);
    isQuietNow.mockReset().mockReturnValue(false);
  });

  it('pushes one Telegram alert when a saved station elevator goes out', async () => {
    const { scanAccessibilityAlerts } = await import('./accessibility.job');
    await scanAccessibilityAlerts();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe('chat-1');
    expect(body).toContain('Diversey');
    expect(opts).toEqual({ parseMode: 'HTML' });
  });

  it('only ever queries users who opted in (accessibilityAlerts: true)', async () => {
    const { scanAccessibilityAlerts } = await import('./accessibility.job');
    await scanAccessibilityAlerts();

    const where = (userFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.accessibilityAlerts).toBe(true);
  });

  it('dedupes: a second scan of the same outage does NOT push again', async () => {
    // First scan claims the key (OK); a later scan sees it already set (null).
    redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const { scanAccessibilityAlerts } = await import('./accessibility.job');
    await scanAccessibilityAlerts();
    await scanAccessibilityAlerts();

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('suppresses when the toggle is off (no opted-in users returned)', async () => {
    userFindMany.mockResolvedValue([]); // the WHERE filter excludes toggled-off users

    const { scanAccessibilityAlerts } = await import('./accessibility.job');
    await scanAccessibilityAlerts();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('suppresses when the outage is not at a saved station', async () => {
    userFindMany.mockResolvedValue([
      { ...savedUser, favorites: [{ stationId: '99999', boardingStopId: null, alightingStopId: null }] },
    ]);

    const { scanAccessibilityAlerts } = await import('./accessibility.job');
    await scanAccessibilityAlerts();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('respects quiet hours', async () => {
    isQuietNow.mockReturnValue(true);

    const { scanAccessibilityAlerts } = await import('./accessibility.job');
    await scanAccessibilityAlerts();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('releases the dedup claim when delivery fails so a later tick retries', async () => {
    sendMessage.mockRejectedValueOnce(new Error('telegram down'));

    const { scanAccessibilityAlerts } = await import('./accessibility.job');
    await scanAccessibilityAlerts();

    expect(redisDel).toHaveBeenCalledTimes(1);
  });
});
