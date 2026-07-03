import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import {
  TelegramService,
  escapeHtml,
  parseCallbackData,
  buildAnswerKeyboard,
  buildFavoritesKeyboard,
  buildLiveBoardKeyboard,
  putActionContext,
  getActionContext,
  type AnswerActionContext,
} from '../services/telegram.service';
import * as assistant from '../services/assistant';
import { FavoriteService } from '../services/favorite.service';
import { CTAService } from '../services/cta.service';
import { enqueueSnoozeNotification } from '../jobs/notification.job';
import config from '../config';
import logger from '../utils/logger';
import type { RouteType } from '@prisma/client';

// CTA train lines are identified by color; everything else the assistant
// resolves on the route-arrivals path is a bus. Used to tag a saved favorite.
const TRAIN_LINES = new Set(['Red', 'Blue', 'Brown', 'Green', 'Orange', 'Pink', 'Purple', 'Yellow']);

interface TelegramChat { id: number; }
interface TelegramUser { id: number; first_name?: string; username?: string; }
interface TelegramLocation {
  latitude: number;
  longitude: number;
  /** Present (seconds) on live-location shares; absent on a one-shot pin. */
  live_period?: number;
}
interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  location?: TelegramLocation;
}
interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}
interface TelegramInlineQuery {
  id: string;
  from?: TelegramUser;
  query: string;
  offset?: string;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  inline_query?: TelegramInlineQuery;
}

/**
 * End of the current day in the given IANA timezone, as a UTC instant.
 * Used to mute notifications "for today" via the existing
 * notificationsPausedUntil field. DST transitions at midnight are ignored
 * (offset is taken at `now`), which is fine for a same-day mute.
 */
function endOfLocalDay(now: Date, timeZone: string): Date {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(now)) map[p.type] = p.value;
  // Local wall-clock reinterpreted as if it were UTC, minus real UTC = offset.
  const asUtc = Date.UTC(
    +map.year, +map.month - 1, +map.day,
    +map.hour, +map.minute, +map.second
  );
  const offsetMs = asUtc - now.getTime();
  const local = new Date(now.getTime() + offsetMs);
  const endLocalMs = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    23, 59, 59, 999
  );
  return new Date(endLocalMs - offsetMs);
}

// Inline-mode hint (#52). The bot @handle is empty until the operator sets
// TELEGRAM_BOT_USERNAME, so phrase it to read fine either way.
const INLINE_HINT = config.telegram.botUsername
  ? `Type <code>@${escapeHtml(config.telegram.botUsername)}</code> in any chat to share a station's arrivals inline`
  : 'Type my @handle in any chat to share a station\'s arrivals inline';

// HTML-formatted. Send with parseMode: 'HTML'. Full reference for /help — kept
// grouped and scannable so it reads at a glance, not as a wall of text.
const HELP_TEXT = [
  '<b>OnTheLoop</b> — live CTA arrivals, right here.',
  '',
  '<b>Just ask</b>',
  '<i>"when\'s the next Blue Line?"</i>',
  '<i>"how do I get to Willis Tower?"</i>',
  'Every answer has buttons to <b>Save</b> the route, <b>Set an alert</b>, <b>Refresh</b>, or watch it 🔴 <b>Live</b> on a self-updating board.',
  '',
  '<b>Commands</b>',
  '/next &lt;route&gt; — next arrivals for a saved route (e.g. <code>/next 60</code>)',
  '/favorites — your saved routes with upcoming arrivals',
  '/unlink — disconnect this chat from your account',
  '/help — show this message',
  '',
  '<b>Shortcuts</b>',
  '📍 Share your location for the nearest stops + arrivals',
  '⭐ Tap a saved route on the keyboard for instant arrivals',
  INLINE_HINT,
  '',
  '<b>Alerts</b>',
  'Scheduled arrival alerts land here with <b>Snooze</b>, <b>Mute today</b>, and <b>Next one instead</b>.',
].join('\n');

// Warm, concise first-run welcome (after linking / on /start). Covers the
// essentials without repeating the full /help reference.
const WELCOME_TEXT = [
  'Here\'s what I can do:',
  '',
  '<b>Just ask</b> — in plain English:',
  '<i>"when\'s the next Blue Line?"</i>',
  '<i>"how do I get to Willis Tower?"</i>',
  '',
  '<b>Commands</b>',
  '/next &lt;route&gt; — arrivals for a saved route',
  '/favorites — all your saved routes, live',
  '/help — everything I can do',
  '',
  '<b>Shortcuts</b>',
  '📍 Share your location for the nearest stops',
  '⭐ Tap a saved route on the keyboard for instant arrivals',
].join('\n');

const HTML = { parseMode: 'HTML' as const };

export class TelegramController {
  /**
   * POST /api/telegram/webhook — Telegram posts updates here.
   * We accept only if the optional secret header matches.
   */
  static async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      if (config.telegram.webhookSecret) {
        const header = req.header('x-telegram-bot-api-secret-token');
        if (header !== config.telegram.webhookSecret) {
          logger.warn('Telegram webhook secret mismatch');
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
      }

      // Always ack 200 fast so Telegram doesn't retry; do the work after.
      res.status(200).json({ ok: true });

      const update: TelegramUpdate = req.body;

      // #52 Inline mode: `@bot <query>` from any chat. Stateless / anonymous.
      if (update.inline_query) {
        await TelegramController.handleInlineQuery(update.inline_query);
        return;
      }

      if (update.callback_query) {
        await TelegramController.handleCallback(update.callback_query);
        return;
      }

      // #51 Location sharing. A one-shot pin (and the first fix of a live
      // location) arrives as `update.message.location`. Subsequent live-location
      // refreshes arrive as `edited_message` — deferred in v1, so we only act on
      // the initial fix and never on edits.
      if (update.message?.location) {
        await TelegramController.handleLocation(update.message);
        return;
      }

      const message = update.message || update.edited_message;
      if (!message || !message.text) return;

      await TelegramController.handleMessage(message);
    } catch (error) {
      logger.error('Telegram webhook error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  }

  private static async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const text = (message.text || '').trim();

    try {
      if (text.startsWith('/start')) {
        await TelegramController.handleStart(chatId, text);
        return;
      }

      if (text === '/help') {
        await TelegramService.sendMessage(chatId, HELP_TEXT, HTML);
        return;
      }

      const user = await AuthService.getUserByTelegramChatId(chatId);
      if (!user) {
        await TelegramService.sendMessage(
          chatId,
          'This chat isn\'t linked to an account yet. Open the web app, tap <b>Link Telegram</b>, then send me the <code>/start</code> link.',
          HTML
        );
        return;
      }

      if (text === '/unlink') {
        await AuthService.unlinkTelegram(user.id);
        await TelegramService.sendMessage(
          chatId,
          'Unlinked. Re-link from the web app to use this bot again.'
        );
        return;
      }

      if (text === '/favorites' || text.toLowerCase() === 'favorites') {
        await TelegramController.sendFavorites(chatId, user.id);
        return;
      }

      if (text.startsWith('/next')) {
        const route = text.replace('/next', '').trim();
        if (!route) {
          await TelegramService.sendMessage(
            chatId,
            'Usage: <code>/next &lt;route&gt;</code>\nExample: <code>/next 60</code> or <code>/next Blue</code>',
            HTML
          );
          return;
        }
        await TelegramController.sendRouteArrivals(chatId, user.id, route);
        return;
      }

      // #54.1 Dynamic saved-routes keyboard: a tap on a favorite button sends
      // that favorite's name back as a plain text message. If the text is an
      // exact (case-insensitive) match for one of the user's favorites, run the
      // /next equivalent for it. Wrapped so a favorites lookup hiccup can never
      // block the natural-language path below.
      try {
        const favorites = await FavoriteService.getUserFavorites(user.id);
        const tapped = favorites.find(
          (f) => f.name.trim().toLowerCase() === text.toLowerCase()
        );
        if (tapped) {
          await TelegramController.sendFavoriteArrivals(chatId, tapped, favorites);
          return;
        }
      } catch (err) {
        logger.warn(`Favorite keyboard-tap lookup failed for chat ${chatId}:`, err);
      }

      // Fall through to the shared assistant pipeline for natural-language
      // queries (#49). Intent parse, favorite match, the bounded live-arrivals
      // fan-out, and answer formatting all live in `services/assistant` now —
      // the exact same pipeline the web app uses — so the bot and web return
      // identical answers for the same query.
      if (!config.google.geminiApiKey) {
        await TelegramService.sendMessage(chatId, HELP_TEXT, HTML);
        return;
      }

      // Assistant answers are free-form (may embed AI directions prose) — send
      // as plain text so stray angle brackets or ampersands don't break HTML
      // parse mode. When the answer resolved to a concrete route/stop, attach
      // the Save / Alert / Refresh action buttons (#50).
      const result = await assistant.answer({ query: text, userId: user.id });
      const replyMarkup = TelegramController.buildAnswerActions(text, result);
      await TelegramService.sendMessage(
        chatId,
        result.answer,
        replyMarkup ? { replyMarkup } : {}
      );
    } catch (error) {
      logger.error(`Telegram handleMessage error for chat ${chatId}:`, error);
      try {
        await TelegramService.sendMessage(chatId, 'Something went wrong on my end. Try again in a moment.');
      } catch {}
    }
  }

  /**
   * Handle a callback_query — a tap on one of the inline action buttons we
   * attach to scheduled pings ("Snooze 5m", "Mute today", "Next one instead").
   */
  private static async handleCallback(cq: TelegramCallbackQuery): Promise<void> {
    // Clear the button spinner right away; ack failure must not block the work.
    await TelegramService.answerCallbackQuery(cq.id);

    const chat = cq.message?.chat;
    if (!chat) return; // Message too old for Telegram to include — nothing to reply to.
    const chatId = String(chat.id);

    const parsed = cq.data ? parseCallbackData(cq.data) : null;
    if (!parsed) return;

    try {
      const user = await AuthService.getUserByTelegramChatId(chatId);
      if (!user) {
        await TelegramService.sendMessage(
          chatId,
          'This chat isn\'t linked to an account. Re-link from the web app to use these actions.'
        );
        return;
      }

      switch (parsed.action) {
        case 'mute': {
          const until = endOfLocalDay(new Date(), config.scheduleTimezone);
          await AuthService.pauseNotificationsUntil(user.id, until);
          await TelegramService.sendMessage(
            chatId,
            'Muted for the rest of today. Alerts resume tomorrow.'
          );
          return;
        }
        case 'snooze': {
          await enqueueSnoozeNotification({
            userId: user.id,
            favoriteId: parsed.favoriteId,
            scheduleId: parsed.scheduleId,
          });
          await TelegramService.sendMessage(
            chatId,
            'Snoozed — I\'ll ping you again in 5 minutes.'
          );
          return;
        }
        case 'next': {
          await TelegramController.sendNextArrival(chatId, user.id, parsed.favoriteId);
          return;
        }
        case 'save': {
          const ctx = getActionContext(parsed.token);
          if (!ctx) {
            await TelegramService.sendMessage(
              chatId,
              'That answer has expired. Ask me again and tap Save this route.'
            );
            return;
          }
          const favorite = await TelegramController.saveFavoriteFromContext(user.id, ctx);
          await TelegramService.sendMessage(
            chatId,
            `Saved <b>${escapeHtml(favorite.name)}</b> to your favorites. Send /favorites to see it.`,
            HTML
          );
          return;
        }
        case 'alert': {
          const ctx = getActionContext(parsed.token);
          if (!ctx) {
            await TelegramService.sendMessage(
              chatId,
              'That answer has expired. Ask me again and tap Set an alert.'
            );
            return;
          }
          // Schedules need a target time + days a chat message can't collect
          // cleanly, so deep-link to the web app to finish setting the alert.
          const link = config.publicUrl.replace(/\/$/, '');
          await TelegramService.sendMessage(
            chatId,
            `To set an alert for <b>${escapeHtml(ctx.routeName)}</b>, open the web app and add a schedule to this route:\n${link}`,
            HTML
          );
          return;
        }
        case 'refresh': {
          const ctx = getActionContext(parsed.token);
          if (!ctx) {
            await TelegramService.sendMessage(
              chatId,
              'That answer has expired. Ask me again for fresh arrivals.'
            );
            return;
          }
          await TelegramController.refreshAnswer(chatId, cq.message?.message_id, user.id, ctx);
          return;
        }
        case 'live': {
          const ctx = getActionContext(parsed.token);
          if (!ctx) {
            await TelegramService.sendMessage(
              chatId,
              'That answer has expired. Ask me again and tap Live.'
            );
            return;
          }
          await TelegramController.startLiveBoardFromContext(chatId, ctx);
          return;
        }
        case 'live_stop': {
          const messageId = cq.message?.message_id;
          if (messageId !== undefined) {
            const { stopLiveBoard } = await import('../jobs/live-board.job');
            await stopLiveBoard(chatId, messageId);
          }
          return;
        }
      }
    } catch (error) {
      logger.error(`Telegram handleCallback error for chat ${chatId}:`, error);
      try {
        await TelegramService.sendMessage(chatId, 'Couldn\'t do that just now. Try again in a moment.');
      } catch {}
    }
  }

  /**
   * Handle an inline_query (#52): `@bot <query>` typed in any chat. Anonymous
   * and read-only — no user lookup, no personal data. We match train stations by
   * name and answer with tappable arrival boards, cached by Telegram for a short
   * window so popular stops don't hammer the CTA API.
   *
   * NB: also needs a one-time BotFather `/setinline` by the operator to be
   * delivered at all; the handler is inert (never invoked) until then.
   */
  private static async handleInlineQuery(iq: TelegramInlineQuery): Promise<void> {
    try {
      const { buildInlineResults } = await import('../services/telegram-inline');
      const results = await buildInlineResults(iq.query || '');
      await TelegramService.answerInlineQuery(iq.id, results, { cacheTime: 30, isPersonal: false });
    } catch (error) {
      logger.warn('Telegram inline query failed:', error);
      // Answer with nothing (short cache) so the client stops spinning.
      try {
        await TelegramService.answerInlineQuery(iq.id, [], { cacheTime: 5 });
      } catch {}
    }
  }

  /**
   * Build the natural-language query we feed the shared assistant for a shared
   * location (#51). Anchoring on the exact coordinates lets the Maps-grounded
   * pipeline surface the nearest stops/stations + arrivals.
   */
  private static buildLocationQuery(lat: number, lon: number): string {
    return (
      `I'm near latitude ${lat}, longitude ${lon} in Chicago. ` +
      `What are the nearest CTA stops or train stations, and when are the next arrivals?`
    );
  }

  /**
   * Handle a shared location (#51): answer with nearest stops/stations + live
   * arrivals via the shared assistant (reusing the Maps grounding), and attach
   * the Save / Alert / Refresh / Live action buttons whenever the answer
   * resolves to a concrete route/stop so the rider can save a nearby stop.
   * v1 answers the first fix only; live-location refresh is deferred.
   */
  private static async handleLocation(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const loc = message.location;
    if (!loc) return;

    try {
      const user = await AuthService.getUserByTelegramChatId(chatId);
      if (!user) {
        await TelegramService.sendMessage(
          chatId,
          'This chat isn\'t linked to an account yet. Open the web app, tap <b>Link Telegram</b>, then send me the <code>/start</code> link.',
          HTML
        );
        return;
      }

      if (!config.google.geminiApiKey) {
        await TelegramService.sendMessage(
          chatId,
          'Finding nearby stops needs the assistant, which isn\'t configured right now. Try /favorites instead.'
        );
        return;
      }

      const query = TelegramController.buildLocationQuery(loc.latitude, loc.longitude);
      const result = await assistant.answer({ query, userId: user.id });
      const replyMarkup = TelegramController.buildAnswerActions(query, result);
      await TelegramService.sendMessage(
        chatId,
        result.answer,
        replyMarkup ? { replyMarkup } : {}
      );
    } catch (error) {
      logger.error(`Telegram handleLocation error for chat ${chatId}:`, error);
      try {
        await TelegramService.sendMessage(
          chatId,
          'Couldn\'t look up nearby stops just now. Try again in a moment.'
        );
      } catch {}
    }
  }

  /** Live arrivals for a resolved answer context — powers the live board (#53). */
  private static async fetchArrivalsForContext(ctx: AnswerActionContext) {
    if (ctx.routeType === 'TRAIN') {
      return CTAService.getTrainArrivals(ctx.stopId, ctx.routeId, ctx.direction || undefined);
    }
    return CTAService.getBusPredictions(ctx.stopId, ctx.routeId, 3, ctx.direction || undefined);
  }

  /**
   * Start a live-updating board (#53) from a resolved answer context: send the
   * initial board (with a Stop button), capture its message id, then hand off to
   * the BullMQ job that edits that message every ~30s until it expires or is
   * stopped.
   */
  private static async startLiveBoardFromContext(
    chatId: string,
    ctx: AnswerActionContext
  ): Promise<void> {
    const {
      startLiveBoard,
      formatLiveBoard,
      LIVE_BOARD_WINDOW_MS,
    } = await import('../jobs/live-board.job');

    const now = Date.now();
    let arrivals: Awaited<ReturnType<typeof CTAService.getBusPredictions>> = [];
    try {
      arrivals = await TelegramController.fetchArrivalsForContext(ctx);
    } catch (err) {
      logger.warn(`Live board initial fetch failed for chat ${chatId}:`, err);
      arrivals = [];
    }

    const text = formatLiveBoard(
      { routeName: ctx.routeName, stopName: ctx.stopName, expiresAt: now + LIVE_BOARD_WINDOW_MS },
      arrivals,
      now
    );
    const messageId = await TelegramService.sendMessageReturningId(chatId, text, {
      parseMode: 'HTML',
      replyMarkup: buildLiveBoardKeyboard(),
    });
    if (messageId === null) {
      // Couldn't create the board message — nothing to edit, so don't schedule.
      await TelegramService.sendMessage(chatId, 'Couldn\'t start live updates just now. Try again.');
      return;
    }

    await startLiveBoard(
      {
        chatId,
        messageId,
        routeType: ctx.routeType,
        routeId: ctx.routeId,
        routeName: ctx.routeName,
        stopId: ctx.stopId,
        stopName: ctx.stopName,
        direction: ctx.direction,
      },
      undefined,
      now
    );
  }

  /**
   * If an assistant answer resolved to a concrete route/stop (route-arrivals or
   * a matching favorite — a {@link RouteRealTimeArrivals} payload), stash the
   * resolved context and return the Save / Alert / Refresh inline keyboard
   * (#50). Returns undefined for directions or answers with no live route, so
   * those replies stay button-free.
   */
  private static buildAnswerActions(
    query: string,
    result: assistant.AssistantResult
  ): ReturnType<typeof buildAnswerKeyboard> | undefined {
    const rt = result.realTimeArrivals;
    // RouteRealTimeArrivals has `stops`; DirectionsRealTimeArrivals has `routes`.
    if (!rt || !('stops' in rt) || rt.stops.length === 0) return undefined;

    const stop = rt.stops[0];
    if (!stop.stopId) return undefined;

    const token = putActionContext({
      query,
      routeType: TRAIN_LINES.has(rt.route) ? 'TRAIN' : 'BUS',
      routeId: rt.route,
      routeName: rt.routeName,
      stopId: stop.stopId,
      stopName: stop.stopName,
      direction: stop.direction || '',
    });
    return buildAnswerKeyboard(token);
  }

  /** Create a Favorite from a resolved answer context (Save this route, #50). */
  private static async saveFavoriteFromContext(
    userId: string,
    ctx: AnswerActionContext
  ) {
    const routeType = ctx.routeType as RouteType;
    return FavoriteService.createFavorite({
      userId,
      routeType,
      routeId: ctx.routeId,
      direction: ctx.direction || undefined,
      // Train boarding points key off stationId, buses off stopId. Set both the
      // type-specific id and the generic boarding fields the arrival lookups use.
      stationId: routeType === 'TRAIN' ? ctx.stopId : undefined,
      stopId: routeType === 'BUS' ? ctx.stopId : undefined,
      boardingStopId: ctx.stopId,
      boardingStopName: ctx.stopName || undefined,
      name: ctx.routeName || `Route ${ctx.routeId}`,
    });
  }

  /** Re-run the stored query and edit the original message with fresh arrivals (Refresh, #50). */
  private static async refreshAnswer(
    chatId: string,
    messageId: number | undefined,
    userId: string,
    ctx: AnswerActionContext
  ): Promise<void> {
    const result = await assistant.answer({ query: ctx.query, userId });
    const replyMarkup = TelegramController.buildAnswerActions(ctx.query, result);

    // Edit in place when we still have the message; otherwise fall back to a
    // fresh reply (e.g. the original is too old for Telegram to reference).
    if (messageId !== undefined) {
      await TelegramService.editMessageText(
        chatId,
        messageId,
        result.answer,
        replyMarkup ? { replyMarkup } : {}
      );
    } else {
      await TelegramService.sendMessage(
        chatId,
        result.answer,
        replyMarkup ? { replyMarkup } : {}
      );
    }
  }

  /** Reply with the arrival(s) after the soonest one — powers "Next one instead". */
  private static async sendNextArrival(
    chatId: string,
    userId: string,
    favoriteId: string
  ): Promise<void> {
    const favorite = await FavoriteService.getFavoriteById(favoriteId, userId);
    if (!favorite) {
      await TelegramService.sendMessage(chatId, 'That favorite is no longer available.');
      return;
    }

    let arrivals;
    if (favorite.routeType === 'TRAIN' && favorite.stationId) {
      arrivals = await CTAService.getTrainArrivals(
        favorite.stationId,
        favorite.routeId,
        favorite.direction || undefined
      );
    } else if (favorite.routeType === 'BUS' && favorite.stopId) {
      arrivals = await CTAService.getBusPredictions(
        favorite.stopId,
        favorite.routeId,
        3,
        favorite.direction || undefined
      );
    }

    // Drop the soonest arrival — the user already saw that in the ping.
    const following = (arrivals || []).slice(1);
    if (following.length === 0) {
      await TelegramService.sendMessage(
        chatId,
        `<b>${escapeHtml(favorite.name)}</b>\n\nNo later arrivals right now.`,
        HTML
      );
      return;
    }

    const body = CTAService.formatArrivalsForSMS(following, `After this — ${favorite.name}`);
    await TelegramService.sendMessage(chatId, body, HTML);
  }

  private static async handleStart(chatId: string, text: string): Promise<void> {
    const parts = text.split(/\s+/);
    const token = parts[1];

    if (!token) {
      const existing = await AuthService.getUserByTelegramChatId(chatId);
      if (existing) {
        await TelegramService.sendMessage(
          chatId,
          `You're already linked as <code>${escapeHtml(existing.email)}</code>. Send /help to see everything I can do.`,
          HTML
        );
      } else {
        await TelegramService.sendMessage(
          chatId,
          '👋 <b>Welcome to OnTheLoop</b> — live CTA arrivals in chat.\n\nTo get started, open the web app, tap <b>Link Telegram</b>, and follow the link it gives you back here.',
          HTML
        );
      }
      return;
    }

    const user = await AuthService.consumeTelegramLinkToken(token, chatId);
    if (!user) {
      await TelegramService.sendMessage(
        chatId,
        'That link is invalid or already used. Generate a fresh one in the web app.'
      );
      return;
    }

    await TelegramService.sendMessage(
      chatId,
      `<b>You're linked</b> ✅\nConnected to <code>${escapeHtml(user.email)}</code>. Scheduled arrival alerts will show up here.\n\n${WELCOME_TEXT}`,
      HTML
    );
  }

  private static async sendFavorites(chatId: string, userId: string): Promise<void> {
    const favorites = await FavoriteService.getUserFavorites(userId);
    if (favorites.length === 0) {
      await TelegramService.sendMessage(
        chatId,
        'No saved routes yet. Ask me about a route and tap <b>Save this route</b>, or add one in the web app — either way it\'ll show up here and on your tap keyboard.',
        HTML
      );
      return;
    }

    const shown = favorites.slice(0, 5);
    const summaries = await Promise.all(shown.map(async (fav) => {
      let summary = '<i>no upcoming</i>';
      try {
        let arrivals;
        if (fav.routeType === 'TRAIN' && fav.stationId) {
          arrivals = await CTAService.getTrainArrivals(
            fav.stationId,
            fav.routeId,
            fav.direction || undefined
          );
        } else if (fav.routeType === 'BUS' && fav.stopId) {
          arrivals = await CTAService.getBusPredictions(
            fav.stopId,
            fav.routeId,
            2,
            fav.direction || undefined
          );
        }
        if (arrivals && arrivals.length) {
          summary = arrivals
            .slice(0, 2)
            .map((a) => `${a.minutesAway} min`)
            .join(', ');
        }
      } catch (err) {
        logger.warn(`Failed arrivals for favorite ${fav.id}:`, err);
      }
      return `<b>${escapeHtml(fav.name)}</b>\n${summary}`;
    }));

    const lines: string[] = ['<b>Your favorites</b>', ''];
    for (const summary of summaries) {
      lines.push(summary);
      lines.push('');
    }
    if (favorites.length > shown.length) {
      lines.push(`<i>Showing ${shown.length} of ${favorites.length} favorites.</i>`);
      lines.push('');
    }
    // Trim trailing blank line
    while (lines.length && lines[lines.length - 1] === '') lines.pop();

    // #54.1 Attach the dynamic saved-routes keyboard, built from the CURRENT
    // favorites (one button per favorite). Querying here means it always
    // reflects the latest set — added/renamed/deleted routes show up next time.
    const keyboard = buildFavoritesKeyboard(favorites);
    await TelegramService.sendMessage(
      chatId,
      lines.join('\n'),
      keyboard ? { parseMode: 'HTML', replyMarkup: keyboard } : HTML
    );
  }

  /**
   * Send live arrivals for a specific favorite (the /next equivalent used by the
   * #54.1 saved-routes keyboard). Re-attaches the freshly-built favorites
   * keyboard so it stays in sync with the user's current set.
   */
  private static async sendFavoriteArrivals(
    chatId: string,
    favorite: { routeType: string; stationId?: string | null; stopId?: string | null; routeId: string; direction?: string | null; name: string },
    allFavorites: { name: string }[]
  ): Promise<void> {
    let arrivals;
    if (favorite.routeType === 'TRAIN' && favorite.stationId) {
      arrivals = await CTAService.getTrainArrivals(
        favorite.stationId,
        favorite.routeId,
        favorite.direction || undefined
      );
    } else if (favorite.routeType === 'BUS' && favorite.stopId) {
      arrivals = await CTAService.getBusPredictions(
        favorite.stopId,
        favorite.routeId,
        3,
        favorite.direction || undefined
      );
    }

    const body = CTAService.formatArrivalsForSMS(arrivals || [], favorite.name);
    const keyboard = buildFavoritesKeyboard(allFavorites);
    await TelegramService.sendMessage(
      chatId,
      body,
      keyboard ? { parseMode: 'HTML', replyMarkup: keyboard } : HTML
    );
  }

  private static async sendRouteArrivals(
    chatId: string,
    userId: string,
    routeQuery: string
  ): Promise<void> {
    const favorites = await FavoriteService.getUserFavorites(userId);
    const match = favorites.find(
      (f) => f.routeId.toLowerCase() === routeQuery.toLowerCase()
    );

    if (!match) {
      await TelegramService.sendMessage(
        chatId,
        `No favorite found for <code>${escapeHtml(routeQuery)}</code>. Send /favorites to see what you have.`,
        HTML
      );
      return;
    }

    let arrivals;
    if (match.routeType === 'TRAIN' && match.stationId) {
      arrivals = await CTAService.getTrainArrivals(
        match.stationId,
        match.routeId,
        match.direction || undefined
      );
    } else if (match.routeType === 'BUS' && match.stopId) {
      arrivals = await CTAService.getBusPredictions(
        match.stopId,
        match.routeId,
        3,
        match.direction || undefined
      );
    }

    const body = CTAService.formatArrivalsForSMS(arrivals || [], match.name);
    await TelegramService.sendMessage(chatId, body, HTML);
  }

  /**
   * POST /api/telegram/setup — admin-only helper to register the webhook.
   * Protected by TELEGRAM_WEBHOOK_SECRET to keep it simple.
   */
  static async setupWebhook(req: Request, res: Response): Promise<void> {
    try {
      const secret = req.header('x-telegram-admin-secret');
      if (!config.telegram.webhookSecret || secret !== config.telegram.webhookSecret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const base = (req.body?.publicUrl || config.publicUrl).replace(/\/$/, '');
      const url = `${base}/api/telegram/webhook`;
      await TelegramService.setWebhook(url);
      // Best-effort: register the "/" command autocomplete menu. If Telegram
      // rejects this for any reason, the webhook still worked, so don't fail.
      try {
        await TelegramService.setCommandMenu();
      } catch (err) {
        logger.warn('setCommandMenu failed (webhook still registered):', err);
      }
      const info = await TelegramService.getWebhookInfo();
      res.status(200).json({ url, info });
    } catch (error: any) {
      logger.error('setupWebhook error:', error);
      res.status(500).json({ error: error.message || 'Failed to set webhook' });
    }
  }
}
