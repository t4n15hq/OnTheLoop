import axios, { AxiosInstance } from 'axios';
import config from '../config';
import logger from '../utils/logger';

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

    try {
      await client.post('/sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: opts.parseMode,
        disable_web_page_preview: opts.disablePreview ?? true,
      });
    } catch (error: any) {
      const detail = error?.response?.data || error?.message || error;
      logger.error(`Telegram sendMessage failed for chat ${chatId}:`, detail);
      throw error;
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
}

export const TelegramService = new TelegramServiceImpl();
