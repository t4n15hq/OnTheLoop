/**
 * Consolidation guard (#49): the Telegram natural-language path and the web
 * app now share one assistant pipeline (`services/assistant`). These tests pin
 * that contract — for the same query, the bot's reply text is byte-for-byte the
 * `answer()` the web endpoint returns — across the representative branches:
 * route arrivals, a matching favorite, and the malformed / unknown fallback.
 *
 * Both sides are driven through the SAME mocked leaf services, so an accidental
 * fork (e.g. reviving a channel-specific NL impl) makes the strings diverge and
 * fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Leaf services the assistant's `defaultDeps` wire to. Hoisted so both the real
// `answer()` and the controller (which calls `answer()` internally) hit them.
const mocks = vi.hoisted(() => ({
  parseQuery: vi.fn(),
  favoriteFindMany: vi.fn(),
  getTransitSuggestion: vi.fn(),
  getBusRoutes: vi.fn(),
  getBusDirections: vi.fn(),
  getBusStops: vi.fn(),
  getBusPredictions: vi.fn(),
  getTrainArrivals: vi.fn(),
}));

vi.mock('../services/ai-sms.service', () => ({
  AISMSService: { parseQuery: mocks.parseQuery },
}));
vi.mock('../services/gemini-maps.service', () => ({
  GeminiMapsService: { getTransitSuggestion: mocks.getTransitSuggestion },
}));
vi.mock('../services/cta-lookup.service', () => ({
  CTALookupService: {
    getBusRoutes: mocks.getBusRoutes,
    getBusDirections: mocks.getBusDirections,
    getBusStops: mocks.getBusStops,
  },
}));
vi.mock('../services/cta.service', () => ({
  CTAService: {
    getBusPredictions: mocks.getBusPredictions,
    getTrainArrivals: mocks.getTrainArrivals,
    formatArrivalsForSMS: vi.fn(() => 'formatted'),
  },
}));
vi.mock('../utils/db', () => ({
  default: { favorite: { findMany: mocks.favoriteFindMany } },
}));

// Controller-side deps (not the pipeline). Bot NL path only needs the user
// lookup + sendMessage; the rest just have to import cleanly.
const getUserByTelegramChatId = vi.fn();
vi.mock('../services/auth.service', () => ({
  AuthService: {
    getUserByTelegramChatId: (...a: unknown[]) => getUserByTelegramChatId(...a),
  },
}));
vi.mock('../services/favorite.service', () => ({ FavoriteService: {} }));
vi.mock('../jobs/notification.job', () => ({ enqueueSnoozeNotification: vi.fn() }));

const sendMessage = vi.fn();
vi.mock('../services/telegram.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/telegram.service')>();
  return {
    ...actual,
    TelegramService: {
      sendMessage: (...a: unknown[]) => sendMessage(...a),
      answerCallbackQuery: vi.fn(),
    },
  };
});

vi.mock('../config', () => ({
  default: {
    telegram: { webhookSecret: '', botToken: 't', botUsername: 'b' },
    google: { geminiApiKey: 'test-key' }, // truthy → NL path runs
    scheduleTimezone: 'America/Chicago',
    publicUrl: 'https://ontheloop.test',
  },
}));

vi.mock('../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

/** Run the query through the web pipeline directly. */
async function webAnswer(query: string, userId = 'u1'): Promise<string> {
  const { answer } = await import('../services/assistant');
  const result = await answer({ query, userId });
  return result.answer;
}

/** Run the query through the Telegram bot's NL path; return the reply text. */
async function botAnswer(query: string, userId = 'u1'): Promise<string> {
  sendMessage.mockClear();
  getUserByTelegramChatId.mockResolvedValue({ id: userId });
  const { TelegramController } = await import('./telegram.controller');
  await TelegramController.handleWebhook(
    makeReq({ message: { message_id: 1, chat: { id: 123 }, text: query } }),
    makeRes()
  );
  const calls = sendMessage.mock.calls;
  return calls.length ? String(calls[calls.length - 1][1]) : '';
}

describe('Telegram bot and web share one assistant pipeline (#49)', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    getUserByTelegramChatId.mockReset();
    sendMessage.mockReset();
    // Defaults so unrelated branches stay inert.
    mocks.parseQuery.mockResolvedValue({ intent: 'unknown' });
    mocks.favoriteFindMany.mockResolvedValue([]);
    mocks.getTransitSuggestion.mockResolvedValue('AI directions.');
    mocks.getBusRoutes.mockResolvedValue([]);
    mocks.getBusDirections.mockResolvedValue([]);
    mocks.getBusStops.mockResolvedValue([]);
    mocks.getBusPredictions.mockResolvedValue([]);
    mocks.getTrainArrivals.mockResolvedValue([]);
  });

  it('route-arrivals: bot reply equals web answer', async () => {
    mocks.parseQuery.mockResolvedValue({ intent: 'route_arrivals', routeNumber: '60' });
    mocks.getBusRoutes.mockResolvedValue([{ rt: '60', rtnm: 'Blue Island/26th' }]);
    mocks.getBusDirections.mockResolvedValue(['Eastbound']);
    mocks.getBusStops.mockResolvedValue([{ stpid: '5', stpnm: 'Racine' }]);
    mocks.getBusPredictions.mockResolvedValue([
      { destination: 'Downtown', minutesAway: 2, isApproaching: false, isDelayed: false },
    ]);

    const web = await webAnswer('next 60 bus');
    const bot = await botAnswer('next 60 bus');

    expect(bot).toBe(web);
    expect(bot).toContain('🚌 Route 60 Eastbound');
  });

  it('matching favorite: bot reply equals web answer', async () => {
    mocks.favoriteFindMany.mockResolvedValue([
      {
        name: 'Home Express',
        routeType: 'BUS',
        routeId: '22',
        direction: 'Northbound',
        stopId: 'stop-1',
        boardingStopName: 'Clark & Diversey',
      },
    ]);
    mocks.getBusPredictions.mockResolvedValue([
      { destination: 'Howard', minutesAway: 5, isApproaching: false, isDelayed: false },
    ]);

    const web = await webAnswer('when is my Home Express');
    const bot = await botAnswer('when is my Home Express');

    expect(bot).toBe(web);
    expect(bot).toContain('🚌 Home Express');
  });

  it('no-service route: bot reply equals web answer', async () => {
    mocks.parseQuery.mockResolvedValue({ intent: 'route_arrivals', routeNumber: '99' });
    mocks.getBusRoutes.mockResolvedValue([{ rt: '99', rtnm: 'Test Route' }]);
    mocks.getBusDirections.mockResolvedValue(['Northbound']);
    mocks.getBusStops.mockResolvedValue([{ stpid: '1', stpnm: 'Main' }]);
    mocks.getBusPredictions.mockResolvedValue([]);

    const web = await webAnswer('next 99 bus');
    const bot = await botAnswer('next 99 bus');

    expect(bot).toBe(web);
    expect(bot).toContain('No buses are currently running on this route.');
  });

  it('malformed / unknown intent: both fall back to the AI suggestion', async () => {
    mocks.parseQuery.mockResolvedValue({ intent: 'unknown' });
    mocks.getTransitSuggestion.mockResolvedValue('Here are some directions.');

    const web = await webAnswer('asdf qwerty');
    const bot = await botAnswer('asdf qwerty');

    expect(bot).toBe(web);
    expect(bot).toBe('Here are some directions.');
  });
});
