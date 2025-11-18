import { SNSClient, PublishCommand, PublishCommandInput } from '@aws-sdk/client-sns';
import config from '../config';
import logger from '../utils/logger';

export class SMSService {
  private static client = new SNSClient({
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
  });

  /**
   * Send an SMS message using AWS SNS
   * @param to - Recipient phone number (E.164 format)
   * @param message - Message body
   */
  static async sendSMS(to: string, message: string): Promise<void> {
    try {
      const params: PublishCommandInput = {
        Message: message,
        PhoneNumber: to,
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': {
            DataType: 'String',
            StringValue: 'Transactional', // Use Transactional for better delivery rates
          },
        },
      };

      // Add sender ID if configured (only works in supported regions like US)
      if (config.aws.snsPhoneNumber) {
        params.MessageAttributes!['AWS.SNS.SMS.OriginationNumber'] = {
          DataType: 'String',
          StringValue: config.aws.snsPhoneNumber,
        };
      }

      const command = new PublishCommand(params);
      const result = await this.client.send(command);

      logger.info(`SMS sent to ${to}: ${result.MessageId}`);
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
