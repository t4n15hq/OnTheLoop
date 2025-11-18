import { Router } from 'express';
import { SMSController } from '../controllers/sms.controller';

const router = Router();

/**
 * POST /api/sms/webhook
 * AWS SNS webhook for incoming SMS (requires SNS topic subscription)
 *
 * Note: Unlike Twilio, AWS SNS requires a dedicated phone number and topic subscription
 * for two-way SMS. If you need this feature, you'll need to:
 * 1. Request a dedicated origination number in AWS SNS
 * 2. Create an SNS topic for incoming messages
 * 3. Subscribe this endpoint to the topic
 * 4. Configure the phone number to publish to the topic
 */
router.post('/webhook', SMSController.handleIncomingSMS);

export default router;
