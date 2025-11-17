import { Router } from 'express';
import { SMSController } from '../controllers/sms.controller';

const router = Router();

/**
 * POST /api/sms/webhook
 * Twilio webhook for incoming SMS
 */
router.post('/webhook', SMSController.handleIncomingSMS);

export default router;
