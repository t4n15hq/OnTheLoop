/**
 * Action-button callbacks (#50): Save this route / Set an alert / Refresh.
 *
 * The real callback-data parser and the real in-memory action-context store are
 * kept (only the network client is stubbed), so these tests exercise the actual
 * token round-trip: stash a context, feed the button's callback_data, assert the
 * handler resolves it and does the right thing — creating a favorite, editing
 * the message, or no-opping gracefully.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const getUserByTelegramChatId = vi.fn();
vi.mock('../services/auth.service', () => ({
  AuthService: {
    getUserByTelegramChatId: (...a: unknown[]) => getUserByTelegramChatId(...a),
  },
}));

const createFavorite = vi.fn();
vi.mock('../services/favorite.service', () => ({
  FavoriteService: {
    createFavorite: (...a: unknown[]) => createFavorite(...a),
    getFavoriteById: vi.fn(),
  },
}));

vi.mock('../services/cta.service', () => ({ CTAService: {} }));
vi.mock('../jobs/notification.job', () => ({ enqueueSnoozeNotification: vi.fn() }));

const assistantAnswer = vi.hoisted(() => vi.fn());
vi.mock('../services/assistant', () => ({ answer: assistantAnswer }));

vi.mock('../config', () => ({
  default: {
    telegram: { webhookSecret: '', botToken: 't', botUsername: 'b' },
    google: { geminiApiKey: '' },
    scheduleTimezone: 'America/Chicago',
    publicUrl: 'https://ontheloop.test',
  },
}));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Keep the real callback-data parser, context store, and keyboard builder; stub
// only the network client (sendMessage / editMessageText / answerCallbackQuery).
const sendMessage = vi.fn();
const editMessageText = vi.fn();
const answerCallbackQuery = vi.fn();
vi.mock('../services/telegram.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/telegram.service')>();
  return {
    ...actual,
    TelegramService: {
      sendMessage: (...a: unknown[]) => sendMessage(...a),
      editMessageText: (...a: unknown[]) => editMessageText(...a),
      answerCallbackQuery: (...a: unknown[]) => answerCallbackQuery(...a),
    },
  };
});

import { putActionContext } from '../services/telegram.service';

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

async function tapButton(data: string, messageId = 7): Promise<void> {
  const { TelegramController } = await import('./telegram.controller');
  await TelegramController.handleWebhook(
    makeReq({
      callback_query: {
        id: 'cb',
        message: { chat: { id: 123 }, message_id: messageId },
        data,
      },
    }),
    makeRes()
  );
}

const busCtx = {
  query: 'next 60 bus',
  routeType: 'BUS' as const,
  routeId: '60',
  routeName: 'Blue Island/26th',
  stopId: '5',
  stopName: 'Racine',
  direction: 'Eastbound',
};

describe('TelegramController assistant action buttons (#50)', () => {
  beforeEach(() => {
    getUserByTelegramChatId.mockReset().mockResolvedValue({ id: 'u1', telegramChatId: '123' });
    createFavorite.mockReset().mockResolvedValue({ id: 'f1', name: 'Blue Island/26th' });
    assistantAnswer.mockReset();
    sendMessage.mockReset().mockResolvedValue(undefined);
    editMessageText.mockReset().mockResolvedValue(undefined);
    answerCallbackQuery.mockReset().mockResolvedValue(undefined);
  });

  it('Save creates a favorite from the resolved bus route/stop', async () => {
    const token = putActionContext(busCtx);
    await tapButton(`sv|${token}`);

    expect(createFavorite).toHaveBeenCalledTimes(1);
    const data = createFavorite.mock.calls[0][0];
    expect(data).toMatchObject({
      userId: 'u1',
      routeType: 'BUS',
      routeId: '60',
      stopId: '5',
      boardingStopId: '5',
      boardingStopName: 'Racine',
      direction: 'Eastbound',
      name: 'Blue Island/26th',
    });
    expect(data.stationId).toBeUndefined();
    expect(sendMessage).toHaveBeenCalled();
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toContain('Saved');
  });

  it('Save maps a train route onto stationId, not stopId', async () => {
    const token = putActionContext({
      ...busCtx,
      routeType: 'TRAIN',
      routeId: 'Red',
      routeName: 'Red Line',
      stopId: 'station-9',
      stopName: 'Belmont',
      direction: '1',
    });
    await tapButton(`sv|${token}`);

    const data = createFavorite.mock.calls[0][0];
    expect(data.routeType).toBe('TRAIN');
    expect(data.stationId).toBe('station-9');
    expect(data.stopId).toBeUndefined();
    expect(data.boardingStopId).toBe('station-9');
  });

  it('Save no-ops gracefully on an unknown/expired token', async () => {
    await tapButton('sv|doesnotexist');
    expect(createFavorite).not.toHaveBeenCalled();
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toContain('expired');
  });

  it('Save no-ops when the chat is not linked', async () => {
    getUserByTelegramChatId.mockResolvedValue(null);
    const token = putActionContext(busCtx);
    await tapButton(`sv|${token}`);
    expect(createFavorite).not.toHaveBeenCalled();
    expect(String(sendMessage.mock.calls.at(-1)?.[1]).toLowerCase()).toContain('linked');
  });

  it('Set an alert replies with a deep link to the web app', async () => {
    const token = putActionContext(busCtx);
    await tapButton(`al|${token}`);
    expect(createFavorite).not.toHaveBeenCalled();
    const text = String(sendMessage.mock.calls.at(-1)?.[1]);
    expect(text).toContain('https://ontheloop.test');
    expect(text).toContain('Blue Island/26th');
  });

  it('Refresh re-runs the stored query and edits the same message', async () => {
    assistantAnswer.mockResolvedValue({
      query: 'next 60 bus',
      answer: '🚌 Route 60 Eastbound — refreshed',
      realTimeArrivals: {
        route: '60',
        routeName: 'Blue Island/26th',
        stops: [{ stopName: 'Racine', stopId: '5', direction: 'Eastbound', arrivals: [] }],
      },
    });

    const token = putActionContext(busCtx);
    await tapButton(`rf|${token}`, 42);

    expect(assistantAnswer).toHaveBeenCalledWith({ query: 'next 60 bus', userId: 'u1' });
    expect(editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, msgId, text, opts] = editMessageText.mock.calls[0];
    expect(chatId).toBe('123');
    expect(msgId).toBe(42);
    expect(text).toBe('🚌 Route 60 Eastbound — refreshed');
    // A concrete route still carries fresh action buttons.
    expect(opts).toHaveProperty('replyMarkup');
  });
});
