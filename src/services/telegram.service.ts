import axios, { AxiosInstance } from 'axios';
import config from '../config';
import logger from '../utils/logger';

// Escape user-supplied text before embedding into an HTML-parse-mode message.
// Telegram's HTML mode only recognizes a small tag set; everything else must
// be entity-encoded so an ampersand or angle bracket doesn't break parsing.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Inline-button (callback) actions on scheduled pings -------------------
// callback_data is capped at 64 bytes by Telegram, so we keep the encoding
// compact: a single-char action tag, `|`-joined with any ids it needs. cuids
// are 25 chars, so `s|<favoriteId>|<scheduleId>` stays well under the limit.
// `|` never appears in a cuid, making the split unambiguous.
// Scheduled-ping actions use single-char tags; the assistant answer actions
// (#50 — Save this route / Set an alert / Refresh) use two-char tags so they
// never collide, and carry a short lookup token instead of the route payload
// (a resolved route + stop + direction won't fit the 64-byte cap — see the
// action-context store below).
export const TG_ACTION = {
  SNOOZE: 's',
  MUTE: 'm',
  NEXT: 'n',
  SAVE: 'sv',
  ALERT: 'al',
  REFRESH: 'rf',
} as const;

export type TelegramCallbackAction =
  | { action: 'mute' }
  | { action: 'snooze'; favoriteId: string; scheduleId?: string }
  | { action: 'next'; favoriteId: string }
  | { action: 'save'; token: string }
  | { action: 'alert'; token: string }
  | { action: 'refresh'; token: string };

/** Inline keyboard attached to each scheduled arrival ping. */
export function buildPingKeyboard(favoriteId: string, scheduleId?: string) {
  return {
    inline_keyboard: [
      [
        { text: 'Snooze 5m', callback_data: `${TG_ACTION.SNOOZE}|${favoriteId}|${scheduleId ?? ''}` },
        { text: 'Mute today', callback_data: TG_ACTION.MUTE },
        { text: 'Next one instead', callback_data: `${TG_ACTION.NEXT}|${favoriteId}` },
      ],
    ],
  };
}

/** Decode callback_data from a button tap. Returns null for anything unknown. */
export function parseCallbackData(data: string): TelegramCallbackAction | null {
  const [action, arg, scheduleId] = data.split('|');
  switch (action) {
    case TG_ACTION.MUTE:
      return { action: 'mute' };
    case TG_ACTION.SNOOZE:
      return arg
        ? { action: 'snooze', favoriteId: arg, scheduleId: scheduleId || undefined }
        : null;
    case TG_ACTION.NEXT:
      return arg ? { action: 'next', favoriteId: arg } : null;
    case TG_ACTION.SAVE:
      return arg ? { action: 'save', token: arg } : null;
    case TG_ACTION.ALERT:
      return arg ? { action: 'alert', token: arg } : null;
    case TG_ACTION.REFRESH:
      return arg ? { action: 'refresh', token: arg } : null;
    default:
      return null;
  }
}

// --- Assistant answer action context (#50) ---------------------------------
// The Save / Alert / Refresh buttons need the resolved route + stop + the
// original query (to re-run on Refresh). That won't fit callback_data's 64-byte
// cap, so we stash it here keyed by a short token and only send the token. A
// miss (process restart or TTL expiry) makes the button no-op gracefully — the
// caller just tells the user to ask again.
export interface AnswerActionContext {
  /** Original NL query, replayed by Refresh. */
  query: string;
  routeType: 'BUS' | 'TRAIN';
  routeId: string;
  routeName: string;
  stopId: string;
  stopName: string;
  direction: string;
}

const ACTION_CTX_TTL_MS = 60 * 60 * 1000; // 1h — answers go stale fast anyway.
const ACTION_CTX_MAX = 1000;
const actionContexts = new Map<string, { ctx: AnswerActionContext; expiresAt: number }>();
let ctxSeq = 0;

/** Stash an action context and return its lookup token. */
export function putActionContext(ctx: AnswerActionContext): string {
  const now = Date.now();
  if (actionContexts.size >= ACTION_CTX_MAX) {
    for (const [k, v] of actionContexts) {
      if (v.expiresAt <= now) actionContexts.delete(k);
    }
    // Still full of live entries → evict oldest (Map preserves insertion order).
    while (actionContexts.size >= ACTION_CTX_MAX) {
      const oldest = actionContexts.keys().next().value;
      if (oldest === undefined) break;
      actionContexts.delete(oldest);
    }
  }
  const token = (now.toString(36) + (ctxSeq++).toString(36) + Math.random().toString(36).slice(2, 6)).slice(-12);
  actionContexts.set(token, { ctx, expiresAt: now + ACTION_CTX_TTL_MS });
  return token;
}

/** Resolve a token to its context, or null if unknown / expired. */
export function getActionContext(token: string): AnswerActionContext | null {
  const entry = actionContexts.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    actionContexts.delete(token);
    return null;
  }
  return entry.ctx;
}

/** Inline keyboard attached to an assistant answer that resolved to a route. */
export function buildAnswerKeyboard(token: string) {
  return {
    inline_keyboard: [
      [
        { text: 'Save this route', callback_data: `${TG_ACTION.SAVE}|${token}` },
        { text: 'Set an alert', callback_data: `${TG_ACTION.ALERT}|${token}` },
        { text: 'Refresh', callback_data: `${TG_ACTION.REFRESH}|${token}` },
      ],
    ],
  };
}

/**
 * Minimal Telegram Bot API wrapper. We only need sendMessage and webhook management.
 */
class TelegramServiceImpl {
  private client: AxiosInstance | null = null;

  private getClient(): AxiosInstance | null {
    const token = config.telegram.botToken;
    if (!token) return null;
    if (!this.client) {
      this.client = axios.create({
        baseURL: `https://api.telegram.org/bot${token}`,
        timeout: 10_000,
      });
    }
    return this.client;
  }

  isConfigured(): boolean {
    return Boolean(config.telegram.botToken);
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    opts: {
      parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      disablePreview?: boolean;
      /** Inline keyboard / reply markup, passed through verbatim to Telegram. */
      replyMarkup?: unknown;
    } = {}
  ): Promise<void> {
    const client = this.getClient();
    if (!client) {
      logger.warn('Telegram bot token not configured; skipping sendMessage');
      return;
    }

    const payload = {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode,
      disable_web_page_preview: opts.disablePreview ?? true,
      reply_markup: opts.replyMarkup,
    };

    // Single retry on transient errors (timeouts, 5xx, 429 with retry_after).
    // 4xx-other (bot blocked, chat-not-found) are terminal — don't retry.
    try {
      await client.post('/sendMessage', payload);
    } catch (error: any) {
      const status = error?.response?.status;
      const code = error?.code;
      const timedOut = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
      const serverErr = status !== undefined && status >= 500;
      const throttled = status === 429;

      if (!timedOut && !serverErr && !throttled) {
        const detail = error?.response?.data || error?.message || error;
        logger.error(`Telegram sendMessage failed for chat ${chatId}:`, detail);
        throw error;
      }

      const retryAfter = throttled ? Number(error?.response?.data?.parameters?.retry_after) : 0;
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500;
      logger.warn(`Telegram sendMessage transient (${code || status}) for chat ${chatId}; retry in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));

      try {
        await client.post('/sendMessage', payload);
      } catch (retryErr: any) {
        const detail = retryErr?.response?.data || retryErr?.message || retryErr;
        logger.error(`Telegram sendMessage retry failed for chat ${chatId}:`, detail);
        throw retryErr;
      }
    }
  }

  /**
   * Edit an existing message's text (and optionally its inline keyboard) in
   * place. Powers the "Refresh" action (#50) — the same message updates with
   * fresh arrivals instead of spamming a new reply. Best-effort: Telegram
   * returns a benign 400 ("message is not modified") when the text is
   * unchanged, so failures are logged, not thrown.
   */
  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    opts: {
      parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      disablePreview?: boolean;
      replyMarkup?: unknown;
    } = {}
  ): Promise<void> {
    const client = this.getClient();
    if (!client) {
      logger.warn('Telegram bot token not configured; skipping editMessageText');
      return;
    }

    try {
      await client.post('/editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: opts.parseMode,
        disable_web_page_preview: opts.disablePreview ?? true,
        reply_markup: opts.replyMarkup,
      });
    } catch (error: any) {
      const detail = error?.response?.data || error?.message || error;
      logger.warn(`Telegram editMessageText failed for chat ${chatId}:`, detail);
    }
  }

  /**
   * Acknowledge a callback_query (button tap) so Telegram clears the button's
   * loading spinner. Best-effort: a failed ack never blocks the real handler.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    try {
      await client.post('/answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
      });
    } catch (err) {
      logger.warn('Telegram answerCallbackQuery failed:', err);
    }
  }

  /**
   * Register the public webhook URL with Telegram. Idempotent.
   * Call this once after deploy (or pass ?force=1 to setup route).
   */
  async setWebhook(url: string): Promise<void> {
    const client = this.getClient();
    if (!client) throw new Error('Telegram bot token not configured');

    const payload: Record<string, unknown> = { url, drop_pending_updates: false };
    if (config.telegram.webhookSecret) {
      payload.secret_token = config.telegram.webhookSecret;
    }

    const { data } = await client.post('/setWebhook', payload);
    logger.info(`Telegram setWebhook → ${JSON.stringify(data)}`);
  }

  async getWebhookInfo(): Promise<any> {
    const client = this.getClient();
    if (!client) throw new Error('Telegram bot token not configured');
    const { data } = await client.get('/getWebhookInfo');
    return data;
  }

  /**
   * Register the "/" autocomplete menu users see in Telegram. Idempotent —
   * Telegram replaces the list on each call.
   */
  async setCommandMenu(): Promise<void> {
    const client = this.getClient();
    if (!client) throw new Error('Telegram bot token not configured');

    const commands = [
      { command: 'next', description: 'Next arrivals for a saved favorite' },
      { command: 'favorites', description: 'Your saved routes with next arrivals' },
      { command: 'help', description: 'Show available commands' },
      { command: 'unlink', description: 'Disconnect this chat from your account' },
    ];

    const { data } = await client.post('/setMyCommands', { commands });
    logger.info(`Telegram setMyCommands → ${JSON.stringify(data)}`);
  }
}

export const TelegramService = new TelegramServiceImpl();
