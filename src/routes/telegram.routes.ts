import { Router } from 'express';
import { TelegramController } from '../controllers/telegram.controller';

const router = Router();

/**
 * POST /api/telegram/webhook
 * Telegram posts bot updates here. Secured with a shared secret header.
 */
router.post('/webhook', TelegramController.handleWebhook);

/**
 * POST /api/telegram/setup
 * One-shot helper to (re)register the webhook with Telegram.
 * Auth: header `x-telegram-admin-secret` must match TELEGRAM_WEBHOOK_SECRET.
 */
router.post('/setup', TelegramController.setupWebhook);

export default router;
