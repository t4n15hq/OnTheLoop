import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// --- Mocks (mirrors the mocking style of notification.job.test.ts) ---------
const getUserByTelegramChatId = vi.fn();
const pauseNotificationsUntil = vi.fn();
vi.mock('../services/auth.service', () => ({
  AuthService: {
    getUserByTelegramChatId: (...a: unknown[]) => getUserByTelegramChatId(...a),
    pauseNotificationsUntil: (...a: unknown[]) => pauseNotificationsUntil(...a),
  },
}));

const enqueueSnoozeNotification = vi.fn();
vi.mock('../jobs/notification.job', () => ({
  enqueueSnoozeNotification: (...a: unknown[]) => enqueueSnoozeNotification(...a),
}));

const getFavoriteById = vi.fn();
vi.mock('../services/favorite.service', () => ({
  FavoriteService: { getFavoriteById: (...a: unknown[]) => getFavoriteById(...a) },
}));

const getTrainArrivals = vi.fn();
const getBusPredictions = vi.fn();
const formatArrivalsForSMS = vi.fn(() => 'formatted');
vi.mock('../services/cta.service', () => ({
  CTAService: {
    getTrainArrivals: (...a: unknown[]) => getTrainArrivals(...a),
    getBusPredictions: (...a: unknown[]) => getBusPredictions(...a),
    formatArrivalsForSMS: (...a: unknown[]) => formatArrivalsForSMS(...a),
  },
}));

vi.mock('../services/ai-sms.service', () => ({ AISMSService: { processQuery: vi.fn() } }));

vi.mock('../config', () => ({
  default: {
    telegram: { webhookSecret: '', botToken: 't', botUsername: 'b' },
    google: { geminiApiKey: '' },
    scheduleTimezone: 'America/Chicago',
  },
}));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Keep the real callback-data parser / escapeHtml, but stub the network client.
const sendMessage = vi.fn();
const answerCallbackQuery = vi.fn();
vi.mock('../services/telegram.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/telegram.service')>();
  return {
    ...actual,
    TelegramService: {
      sendMessage: (...a: unknown[]) => sendMessage(...a),
      answerCallbackQuery: (...a: unknown[]) => answerCallbackQuery(...a),
    },
  };
});

function makeRes(): Response {
  const res: Partial<Response> = {
    headersSent: false,
    status: vi.fn(function (this: Response) { return this; }) as unknown as Response['status'],
    json: vi.fn(function (this: Response) { return this; }) as unknown as Response['json'],
  };
  return res as Response;
}

function makeReq(body: unknown): Request {
  return { body, header: () => undefined } as unknown as Request;
}

describe('TelegramController callback routing', () => {
  beforeEach(() => {
    getUserByTelegramChatId.mockReset();
    pauseNotificationsUntil.mockReset().mockResolvedValue(undefined);
    enqueueSnoozeNotification.mockReset().mockResolvedValue(undefined);
    getFavoriteById.mockReset();
    getTrainArrivals.mockReset();
    getBusPredictions.mockReset();
    formatArrivalsForSMS.mockClear();
    sendMessage.mockReset().mockResolvedValue(undefined);
    answerCallbackQuery.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mute today sets notificationsPausedUntil to end of the local day', async () => {
    // 2026-07-01 10:00 America/Chicago (CDT, UTC-5) → end of day = 23:59:59.999 CDT.
    vi.setSystemTime(new Date('2026-07-01T15:00:00Z'));
    getUserByTelegramChatId.mockResolvedValue({ id: 'u1', telegramChatId: '123' });

    const { TelegramController } = await import('./telegram.controller');
    await TelegramController.handleWebhook(
      makeReq({ callback_query: { id: 'cb1', message: { chat: { id: 123 } }, data: 'm' } }),
      makeRes()
    );

    expect(answerCallbackQuery).toHaveBeenCalledWith('cb1');
    expect(pauseNotificationsUntil).toHaveBeenCalledTimes(1);
    const [userId, until] = pauseNotificationsUntil.mock.calls[0];
    expect(userId).toBe('u1');
    expect(until).toBeInstanceOf(Date);
    // 23:59:59.999 CDT == 04:59:59.999Z the next day.
    expect((until as Date).toISOString()).toBe('2026-07-02T04:59:59.999Z');
  });

  it('snooze enqueues a delayed re-delivery with the parsed ids', async () => {
    getUserByTelegramChatId.mockResolvedValue({ id: 'u1', telegramChatId: '123' });

    const { TelegramController } = await import('./telegram.controller');
    await TelegramController.handleWebhook(
      makeReq({ callback_query: { id: 'cb2', message: { chat: { id: 123 } }, data: 's|fav1|sched1' } }),
      makeRes()
    );

    expect(enqueueSnoozeNotification).toHaveBeenCalledWith({
      userId: 'u1',
      favoriteId: 'fav1',
      scheduleId: 'sched1',
    });
  });

  it('ignores unknown callback data (no user lookup, no side effects)', async () => {
    const { TelegramController } = await import('./telegram.controller');
    await TelegramController.handleWebhook(
      makeReq({ callback_query: { id: 'cb3', message: { chat: { id: 123 } }, data: 'bogus' } }),
      makeRes()
    );

    expect(answerCallbackQuery).toHaveBeenCalledWith('cb3');
    expect(getUserByTelegramChatId).not.toHaveBeenCalled();
    expect(pauseNotificationsUntil).not.toHaveBeenCalled();
    expect(enqueueSnoozeNotification).not.toHaveBeenCalled();
  });
});
