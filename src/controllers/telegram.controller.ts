import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { TelegramService } from '../services/telegram.service';
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

const HELP_TEXT = [
  'Commands:',
  '• /next <route> — next arrivals for one of your favorites (e.g. /next 60)',
  '• /favorites — list your saved routes with upcoming arrivals',
  '• /unlink — disconnect this Telegram chat from your account',
  '• /help — show this message',
  '',
  'You can also just ask naturally:',
  '"when is the next blue line?"',
  '"how do I get to Willis Tower?"',
].join('\n');

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
        await TelegramService.sendMessage(chatId, HELP_TEXT);
        return;
      }

      const user = await AuthService.getUserByTelegramChatId(chatId);
      if (!user) {
        await TelegramService.sendMessage(
          chatId,
          'This chat isn\'t linked to an account yet. Open the web app, tap "Link Telegram", then send me the /start link.'
        );
        return;
      }

      if (text === '/unlink') {
        await AuthService.unlinkTelegram(user.id);
        await TelegramService.sendMessage(chatId, 'Unlinked. You\'ll need to re-link from the web app to use this bot again.');
        return;
      }

      if (text === '/favorites' || text.toLowerCase() === 'favorites') {
        await TelegramController.sendFavorites(chatId, user.id);
        return;
      }

      if (text.startsWith('/next')) {
        const route = text.replace('/next', '').trim();
        if (!route) {
          await TelegramService.sendMessage(chatId, 'Usage: /next <route id>  (e.g. /next 60 or /next Blue)');
          return;
        }
        await TelegramController.sendRouteArrivals(chatId, user.id, route);
        return;
      }

      // Fall through to AI for natural-language queries.
      if (!config.google.geminiApiKey) {
        await TelegramService.sendMessage(chatId, HELP_TEXT);
        return;
      }

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
          `You're already linked as ${existing.email}. Send /help to see commands.`
        );
      } else {
        await TelegramService.sendMessage(
          chatId,
          'Welcome! To link this chat, open the web app, tap "Link Telegram", and follow the link it gives you.'
        );
      }
      return;
    }

    const user = await AuthService.consumeTelegramLinkToken(token, chatId);
    if (!user) {
      await TelegramService.sendMessage(
        chatId,
        'That link token is invalid or already used. Generate a new one from the web app.'
      );
      return;
    }

    await TelegramService.sendMessage(
      chatId,
      `Linked to ${user.email}. You'll get scheduled arrival alerts here.\n\n${HELP_TEXT}`
    );
  }

  private static async sendFavorites(chatId: string, userId: string): Promise<void> {
    const favorites = await FavoriteService.getUserFavorites(userId);
    if (favorites.length === 0) {
      await TelegramService.sendMessage(chatId, 'No favorites yet. Add some from the web app.');
      return;
    }

    const lines: string[] = ['Your favorites:', ''];
    for (const fav of favorites) {
      let summary = 'no upcoming';
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
            .map((a) => `${a.minutesAway}m`)
            .join(', ');
        }
      } catch (err) {
        logger.warn(`Failed arrivals for favorite ${fav.id}:`, err);
      }
      lines.push(`• ${fav.name} — ${summary}`);
    }
    await TelegramService.sendMessage(chatId, lines.join('\n'));
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
        `No favorite found for "${routeQuery}". Use /favorites to see what you have.`
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
    await TelegramService.sendMessage(chatId, body);
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
      const info = await TelegramService.getWebhookInfo();
      res.status(200).json({ url, info });
    } catch (error: any) {
      logger.error('setupWebhook error:', error);
      res.status(500).json({ error: error.message || 'Failed to set webhook' });
    }
  }
}
