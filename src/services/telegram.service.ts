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
    opts: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; disablePreview?: boolean } = {}
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
