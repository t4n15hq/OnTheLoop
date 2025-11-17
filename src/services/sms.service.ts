import twilio from 'twilio';
import config from '../config';
import logger from '../utils/logger';

export class SMSService {
  private static client = twilio(
    config.twilio.accountSid,
    config.twilio.authToken
  );

  /**
   * Send an SMS message
   * @param to - Recipient phone number (E.164 format)
   * @param message - Message body
   */
  static async sendSMS(to: string, message: string): Promise<void> {
    try {
      const result = await this.client.messages.create({
        body: message,
        from: config.twilio.phoneNumber,
        to,
      });

      logger.info(`SMS sent to ${to}: ${result.sid}`);
    } catch (error) {
      logger.error(`Error sending SMS to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send multiple SMS messages (batched)
   * @param recipients - Array of phone numbers
   * @param message - Message body
   */
  static async sendBulkSMS(
    recipients: string[],
    message: string
  ): Promise<void> {
    try {
      const promises = recipients.map((recipient) =>
        this.sendSMS(recipient, message)
      );

      await Promise.all(promises);

      logger.info(`Bulk SMS sent to ${recipients.length} recipients`);
    } catch (error) {
      logger.error('Error sending bulk SMS:', error);
      throw error;
    }
  }

  /**
   * Validate incoming Twilio request
   * @param signature - X-Twilio-Signature header
   * @param url - The full URL of the webhook
   * @param params - POST parameters from Twilio
   */
  static validateWebhook(
    signature: string,
    url: string,
    params: Record<string, any>
  ): boolean {
    return twilio.validateRequest(
      config.twilio.authToken,
      signature,
      url,
      params
    );
  }

  /**
   * Format phone number to E.164 format
   * Assumes US numbers if no country code
   * @param phoneNumber - Phone number to format
   */
  static formatPhoneNumber(phoneNumber: string): string {
    // Remove all non-digit characters
    const cleaned = phoneNumber.replace(/\D/g, '');

    // If it starts with 1, it already has country code
    if (cleaned.startsWith('1')) {
      return `+${cleaned}`;
    }

    // Assume US number, add +1
    if (cleaned.length === 10) {
      return `+1${cleaned}`;
    }

    // If already formatted or different format, return as is
    return phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
  }
}
