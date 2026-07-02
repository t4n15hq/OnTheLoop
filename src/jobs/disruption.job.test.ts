import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Telegram: capture sends -------------------------------------------------
const sendMessage = vi.fn();
vi.mock('../services/telegram.service', () => ({
  TelegramService: {
    isConfigured: () => true,
    sendMessage: (...args: unknown[]) => sendMessage(...args),
  },
  // Real-enough escaper so message formatting doesn't blow up.
  escapeHtml: (s: string) => s,
}));

// --- Alerts: inject a fixed alert set per test ------------------------------
const getForRoutes = vi.fn();
vi.mock('../services/alerts.service', () => ({
  AlertsService: { getForRoutes: (...args: unknown[]) => getForRoutes(...args) },
}));

// --- Prisma: user.findMany honors the WHERE filter; sentAlert is a stateful
//     in-memory store so a "second tick" really sees the row the first wrote.
const userFindMany = vi.fn();
const sentStore: Array<{ userId: string; alertKey: string }> = [];
const sentAlertFindMany = vi.fn(async (args: any) => {
  const userId = args?.where?.userId;
  const wantedKeys: string[] = args?.where?.alertKey?.in ?? [];
  return sentStore
    .filter((r) => r.userId === userId && wantedKeys.includes(r.alertKey))
    .map((r) => ({ alertKey: r.alertKey }));
});
const sentAlertCreate = vi.fn(async (args: any) => {
  const row = { userId: args.data.userId, alertKey: args.data.alertKey };
  sentStore.push(row);
  return row;
});
vi.mock('../utils/db', () => ({
  default: {
    user: { findMany: (...args: unknown[]) => userFindMany(...args) },
    sentAlert: {
      findMany: (...args: unknown[]) => sentAlertFindMany(...args),
      create: (...args: unknown[]) => sentAlertCreate(...args),
    },
  },
}));

vi.mock('../utils/redis', () => ({ default: {}, cacheRedis: {}, rateLimitRedis: {} }));
vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/sentry', () => ({ reportError: vi.fn() }));

const materialAlert = {
  id: 'a1',
  headline: 'Red Line delayed ~15 min',
  shortDescription: 'Signal problem near Belmont.',
  severityScore: 50,
  majorAlert: true,
  services: [],
};

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    telegramChatId: 'chat-1',
    disruptionAlerts: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    favorites: [{ routeId: 'Red', routeType: 'TRAIN' }],
    ...overrides,
  };
}

describe('pushDisruptionAlerts', () => {
  beforeEach(() => {
    sendMessage.mockReset().mockResolvedValue(undefined);
    getForRoutes.mockReset().mockResolvedValue([materialAlert]);
    userFindMany.mockReset();
    sentAlertFindMany.mockClear();
    sentAlertCreate.mockClear();
    sentStore.length = 0;
  });

  it('pushes a material alert on a saved route once; a second tick does not resend', async () => {
    userFindMany.mockResolvedValue([makeUser()]);

    const { pushDisruptionAlerts } = await import('./disruption.job');

    // First tick: sends and records.
    await pushDisruptionAlerts();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe('chat-1');
    expect(body).toContain('Red Line delayed');
    expect(opts).toEqual({ parseMode: 'HTML' });
    expect(sentAlertCreate).toHaveBeenCalledTimes(1);

    // Second tick: the SentAlert ledger already has it → no resend.
    await pushDisruptionAlerts();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sentAlertCreate).toHaveBeenCalledTimes(1);
  });

  it('suppresses the push during quiet hours', async () => {
    // 00:00–24:00 covers every wall-clock minute regardless of timezone.
    userFindMany.mockResolvedValue([
      makeUser({ quietHoursStart: '00:00', quietHoursEnd: '24:00' }),
    ]);

    const { pushDisruptionAlerts } = await import('./disruption.job');
    await pushDisruptionAlerts();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sentAlertCreate).not.toHaveBeenCalled();
  });

  it('does not push when the user has the disruptionAlerts toggle off', async () => {
    // The mock enforces the WHERE filter the job passes, proving the toggle
    // gates the query: a disruptionAlerts:false user is excluded.
    const allUsers = [makeUser({ disruptionAlerts: false })];
    userFindMany.mockImplementation(async (args: any) => {
      const want = args?.where?.disruptionAlerts;
      return allUsers.filter((u) => want === undefined || u.disruptionAlerts === want);
    });

    const { pushDisruptionAlerts } = await import('./disruption.job');
    await pushDisruptionAlerts();

    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ disruptionAlerts: true }),
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores non-material alerts (e.g. minor elevator notices)', async () => {
    getForRoutes.mockResolvedValue([
      {
        id: 'minor1',
        headline: 'Elevator at Clark/Lake out of service',
        shortDescription: 'Use the escalator.',
        severityScore: 10,
        majorAlert: false,
        services: [],
      },
    ]);
    userFindMany.mockResolvedValue([makeUser()]);

    const { pushDisruptionAlerts } = await import('./disruption.job');
    await pushDisruptionAlerts();

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
