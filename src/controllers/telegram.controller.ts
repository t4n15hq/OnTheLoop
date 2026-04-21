import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { TelegramService, escapeHtml } from '../services/telegram.service';
import { AISMSService } from '../services/ai-sms.service';
import { FavoriteService } from '../services/favorite.service';
import { CTAService } from '../services/cta.service';
import config from '../config';
import logger from '../utils/logger';

interface TelegramChat { id: number; }
interface TelegramUser { id: number; first_name?: string; username?: string; }
interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
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

      // Fall through to AI for natural-language queries.
      if (!config.google.geminiApiKey) {
        await TelegramService.sendMessage(chatId, HELP_TEXT, HTML);
        return;
      }

      // AI responses are free-form prose — send as plain text so stray
      // angle brackets or ampersands don't break HTML parse mode.
      const reply = await AISMSService.processQuery(user.id, text);
      await TelegramService.sendMessage(chatId, reply);
    } catch (error) {
      logger.error(`Telegram handleMessage error for chat ${chatId}:`, error);
      try {
        await TelegramService.sendMessage(chatId, 'Something went wrong on my end. Try again in a moment.');
      } catch {}
    }
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

    const lines: string[] = ['<b>Your favorites</b>', ''];
    for (const fav of favorites) {
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
      lines.push(`<b>${escapeHtml(fav.name)}</b>\n${summary}`);
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
