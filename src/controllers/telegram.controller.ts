import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import {
  TelegramService,
  escapeHtml,
  parseCallbackData,
  buildAnswerKeyboard,
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
interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}
interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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

// HTML-formatted. Send with parseMode: 'HTML'.
const HELP_TEXT = [
  '<b>Commands</b>',
  '/next &lt;route&gt; — next arrivals for a favorite (e.g. <code>/next 60</code>)',
  '/favorites — your saved routes with upcoming arrivals',
  '/unlink — disconnect this chat from your account',
  '/help — show this message',
  '',
  '<b>Or just ask</b>',
  '<i>"when\'s the next blue line?"</i>',
  '<i>"how do I get to Willis Tower?"</i>',
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

      if (update.callback_query) {
        await TelegramController.handleCallback(update.callback_query);
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
      }
    } catch (error) {
      logger.error(`Telegram handleCallback error for chat ${chatId}:`, error);
      try {
        await TelegramService.sendMessage(chatId, 'Couldn\'t do that just now. Try again in a moment.');
      } catch {}
    }
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
          `Already linked as <code>${escapeHtml(existing.email)}</code>. Send /help to see commands.`,
          HTML
        );
      } else {
        await TelegramService.sendMessage(
          chatId,
          'Welcome. To link this chat, open the web app, tap <b>Link Telegram</b>, and follow the link it gives you.',
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
      `<b>Linked</b>\nConnected to <code>${escapeHtml(user.email)}</code>. Scheduled arrival alerts will show up here.\n\n${HELP_TEXT}`,
      HTML
    );
  }

  private static async sendFavorites(chatId: string, userId: string): Promise<void> {
    const favorites = await FavoriteService.getUserFavorites(userId);
    if (favorites.length === 0) {
      await TelegramService.sendMessage(
        chatId,
        'No favorites yet. Add some in the web app and they\'ll show up here.'
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
    await TelegramService.sendMessage(chatId, lines.join('\n'), HTML);
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
