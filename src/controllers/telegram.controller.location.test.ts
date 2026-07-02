/**
 * Phase-2 Telegram features on the webhook:
 *   #51 location sharing → nearest stops via the shared assistant + Save button
 *   #54.1 dynamic saved-routes keyboard (built from the user's own favorites)
 *   #53 Live board start/stop callbacks
 *   #52 inline_query routing
 *
 * Network + job effects are stubbed; the real callback parser, action-context
 * store, and keyboard builders are kept (importOriginal), so the token
 * round-trip and keyboard shapes are exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const getUserByTelegramChatId = vi.fn();
vi.mock('../services/auth.service', () => ({
  AuthService: { getUserByTelegramChatId: (...a: unknown[]) => getUserByTelegramChatId(...a) },
}));

const assistantAnswer = vi.hoisted(() => vi.fn());
vi.mock('../services/assistant', () => ({ answer: assistantAnswer }));

const getUserFavorites = vi.fn();
vi.mock('../services/favorite.service', () => ({
  FavoriteService: {
    getUserFavorites: (...a: unknown[]) => getUserFavorites(...a),
    getFavoriteById: vi.fn(),
    createFavorite: vi.fn(),
  },
}));

const getTrainArrivals = vi.fn();
const getBusPredictions = vi.fn();
const formatArrivalsForSMS = vi.fn(() => 'BOARD');
vi.mock('../services/cta.service', () => ({
  CTAService: {
    getTrainArrivals: (...a: unknown[]) => getTrainArrivals(...a),
    getBusPredictions: (...a: unknown[]) => getBusPredictions(...a),
    formatArrivalsForSMS: (...a: unknown[]) => formatArrivalsForSMS(...a),
  },
}));

vi.mock('../jobs/notification.job', () => ({ enqueueSnoozeNotification: vi.fn() }));

// Live-board job is lazy-imported by the controller; stub start/stop/format.
const startLiveBoard = vi.fn();
const stopLiveBoard = vi.fn();
vi.mock('../jobs/live-board.job', () => ({
  startLiveBoard: (...a: unknown[]) => startLiveBoard(...a),
  stopLiveBoard: (...a: unknown[]) => stopLiveBoard(...a),
  formatLiveBoard: () => 'LIVEBOARD',
  LIVE_BOARD_WINDOW_MS: 300_000,
}));

// Inline builder is lazy-imported by the controller.
const buildInlineResults = vi.fn();
vi.mock('../services/telegram-inline', () => ({
  buildInlineResults: (...a: unknown[]) => buildInlineResults(...a),
}));

vi.mock('../config', () => ({
  default: {
    telegram: { webhookSecret: '', botToken: 't', botUsername: 'b' },
    google: { geminiApiKey: 'test-key' }, // truthy → assistant/location path runs
    scheduleTimezone: 'America/Chicago',
    publicUrl: 'https://ontheloop.test',
  },
}));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Keep the real keyboard builders / callback parser / context store; stub only
// the network client.
const sendMessage = vi.fn();
const sendMessageReturningId = vi.fn();
const editMessageText = vi.fn();
const answerCallbackQuery = vi.fn();
const answerInlineQuery = vi.fn();
vi.mock('../services/telegram.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/telegram.service')>();
  return {
    ...actual,
    TelegramService: {
      sendMessage: (...a: unknown[]) => sendMessage(...a),
      sendMessageReturningId: (...a: unknown[]) => sendMessageReturningId(...a),
      editMessageText: (...a: unknown[]) => editMessageText(...a),
      answerCallbackQuery: (...a: unknown[]) => answerCallbackQuery(...a),
      answerInlineQuery: (...a: unknown[]) => answerInlineQuery(...a),
    },
  };
});

import { putActionContext, buildFavoritesKeyboard } from '../services/telegram.service';

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

async function webhook(body: unknown): Promise<void> {
  const { TelegramController } = await import('./telegram.controller');
  await TelegramController.handleWebhook(makeReq(body), makeRes());
}

beforeEach(() => {
  getUserByTelegramChatId.mockReset();
  assistantAnswer.mockReset();
  getUserFavorites.mockReset().mockResolvedValue([]);
  getTrainArrivals.mockReset().mockResolvedValue([]);
  getBusPredictions.mockReset().mockResolvedValue([]);
  formatArrivalsForSMS.mockClear();
  startLiveBoard.mockReset().mockResolvedValue(undefined);
  stopLiveBoard.mockReset().mockResolvedValue(undefined);
  buildInlineResults.mockReset();
  sendMessage.mockReset().mockResolvedValue(undefined);
  sendMessageReturningId.mockReset().mockResolvedValue(999);
  editMessageText.mockReset().mockResolvedValue(undefined);
  answerCallbackQuery.mockReset().mockResolvedValue(undefined);
  answerInlineQuery.mockReset().mockResolvedValue(undefined);
});

describe('#51 location sharing', () => {
  it('answers a shared location via the assistant (query anchored on the coords) and offers a Save button when a stop resolves', async () => {
    getUserByTelegramChatId.mockResolvedValue({ id: 'u1' });
    assistantAnswer.mockResolvedValue({
      query: 'q',
      answer: 'Nearest station: Belmont (Red Line) — next in 3 min.',
      realTimeArrivals: {
        route: 'Red',
        routeName: 'Red Line',
        stops: [{ stopName: 'Belmont', stopId: '41320', direction: '1', arrivals: [] }],
      },
    });

    await webhook({ message: { message_id: 1, chat: { id: 123 }, location: { latitude: 41.9397, longitude: -87.6531 } } });

    // Assistant queried with the coordinates + the linked user.
    expect(assistantAnswer).toHaveBeenCalledTimes(1);
    const arg = assistantAnswer.mock.calls[0][0] as { query: string; userId: string };
    expect(arg.userId).toBe('u1');
    expect(arg.query).toContain('41.9397');
    expect(arg.query).toContain('-87.6531');

    // Reply is the assistant answer, with the Save/Alert/Refresh/Live buttons.
    const [chatId, text, opts] = sendMessage.mock.calls.at(-1) as [string, string, any];
    expect(chatId).toBe('123');
    expect(text).toBe('Nearest station: Belmont (Red Line) — next in 3 min.');
    expect(opts.replyMarkup.inline_keyboard[0][0].text).toBe('Save this route');
    // #53 Live toggle rides on the same keyboard.
    expect(JSON.stringify(opts.replyMarkup)).toContain('lv|');
  });

  it('prompts an unlinked chat to link instead of calling the assistant', async () => {
    getUserByTelegramChatId.mockResolvedValue(null);
    await webhook({ message: { message_id: 1, chat: { id: 123 }, location: { latitude: 41.9, longitude: -87.6 } } });

    expect(assistantAnswer).not.toHaveBeenCalled();
    expect(String(sendMessage.mock.calls.at(-1)?.[1]).toLowerCase()).toContain('link');
  });
});

describe('#54.1 dynamic saved-routes keyboard', () => {
  it('buildFavoritesKeyboard is derived entirely from favorites (one button per favorite, nothing hardcoded)', () => {
    expect(buildFavoritesKeyboard([])).toBeUndefined();
    const kb = buildFavoritesKeyboard([{ name: 'Morning Red' }, { name: 'Bus 22 home' }, { name: 'Weekend Brown' }]);
    expect(kb?.keyboard).toEqual([
      [{ text: 'Morning Red' }],
      [{ text: 'Bus 22 home' }],
      [{ text: 'Weekend Brown' }],
    ]);
  });

  it('/favorites attaches a keyboard built from the current favorites', async () => {
    getUserByTelegramChatId.mockResolvedValue({ id: 'u1' });
    getUserFavorites.mockResolvedValue([
      { id: 'f1', name: 'Morning Red', routeType: 'TRAIN', stationId: '41320', routeId: 'Red', direction: '1' },
      { id: 'f2', name: 'Bus 22 home', routeType: 'BUS', stopId: '18095', routeId: '22', direction: 'Northbound' },
    ]);

    await webhook({ message: { message_id: 1, chat: { id: 123 }, text: '/favorites' } });

    const opts = sendMessage.mock.calls.at(-1)?.[2] as any;
    expect(opts.replyMarkup.keyboard).toEqual([
      [{ text: 'Morning Red' }],
      [{ text: 'Bus 22 home' }],
    ]);
  });

  it('tapping a saved-route button runs the /next equivalent for that favorite (not the assistant)', async () => {
    getUserByTelegramChatId.mockResolvedValue({ id: 'u1' });
    getUserFavorites.mockResolvedValue([
      { id: 'f2', name: 'Bus 22 home', routeType: 'BUS', stopId: '18095', routeId: '22', direction: 'Northbound' },
    ]);
    getBusPredictions.mockResolvedValue([
      { destination: 'Howard', minutesAway: 4, isApproaching: false, isDelayed: false },
    ]);

    await webhook({ message: { message_id: 1, chat: { id: 123 }, text: 'Bus 22 home' } });

    expect(getBusPredictions).toHaveBeenCalledWith('18095', '22', 3, 'Northbound');
    expect(assistantAnswer).not.toHaveBeenCalled();
    const [, text, opts] = sendMessage.mock.calls.at(-1) as [string, string, any];
    expect(text).toBe('BOARD');
    expect(opts.replyMarkup.keyboard).toEqual([[{ text: 'Bus 22 home' }]]);
  });
});

describe('#53 live board start/stop', () => {
  it('tapping Live sends the initial board and hands off to the live-board job', async () => {
    getUserByTelegramChatId.mockResolvedValue({ id: 'u1' });
    const token = putActionContext({
      query: 'next 60 bus',
      routeType: 'BUS',
      routeId: '60',
      routeName: 'Blue Island/26th',
      stopId: '5',
      stopName: 'Racine',
      direction: 'Eastbound',
    });

    await webhook({
      callback_query: { id: 'cb', message: { chat: { id: 123 }, message_id: 7 }, data: `lv|${token}` },
    });

    // Initial board sent (id captured), then the job scheduled with that id.
    expect(sendMessageReturningId).toHaveBeenCalledTimes(1);
    expect(startLiveBoard).toHaveBeenCalledTimes(1);
    expect(startLiveBoard.mock.calls[0][0]).toMatchObject({
      chatId: '123',
      messageId: 999,
      routeType: 'BUS',
      routeId: '60',
      stopId: '5',
      direction: 'Eastbound',
    });
  });

  it('tapping Stop ends the live board for that exact message', async () => {
    getUserByTelegramChatId.mockResolvedValue({ id: 'u1' });
    await webhook({
      callback_query: { id: 'cb', message: { chat: { id: 123 }, message_id: 55 }, data: 'ls' },
    });
    expect(stopLiveBoard).toHaveBeenCalledWith('123', 55);
  });
});

describe('#52 inline mode routing', () => {
  it('answers an inline_query with the built results (cached, anonymous)', async () => {
    const results = [{ type: 'article', id: 'stn-41320', title: 'Belmont' }];
    buildInlineResults.mockResolvedValue(results);

    await webhook({ inline_query: { id: 'iq1', query: 'Belmont' } });

    expect(buildInlineResults).toHaveBeenCalledWith('Belmont');
    expect(answerInlineQuery).toHaveBeenCalledWith('iq1', results, { cacheTime: 30, isPersonal: false });
    // Inline is anonymous — no account lookup.
    expect(getUserByTelegramChatId).not.toHaveBeenCalled();
  });
});
