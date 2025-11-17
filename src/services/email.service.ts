import nodemailer from 'nodemailer';
import config from '../config';
import logger from '../utils/logger';

class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    if (config.email?.user && config.email?.pass) {
      // AWS SES configuration (if host and port are specified)
      if (config.email.host && config.email.port) {
        this.transporter = nodemailer.createTransport({
          host: config.email.host,
          port: config.email.port,
          secure: config.email.port === 465, // true for 465, false for other ports
          auth: {
            user: config.email.user,
            pass: config.email.pass,
          },
        });
        logger.info(`Email service configured with custom SMTP (${config.email.host}:${config.email.port})`);
      } else {
        // Fallback to Gmail
        this.transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: config.email.user,
            pass: config.email.pass,
          },
        });
        logger.info('Email service configured with Gmail');
      }
    } else {
      logger.warn('Email credentials not configured. Email notifications disabled.');
    }
  }

  async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    if (!this.transporter) {
      logger.warn('Email service not configured. Skipping email send.');
      return false;
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"Loop CTA Tracker" <${config.email?.user}>`,
        to,
        subject,
        html,
      });

      logger.info(`Email sent to ${to}: ${info.messageId}`);
      return true;
    } catch (error) {
      logger.error('Error sending email:', error);
      return false;
    }
  }

  async sendArrivalNotification(
    email: string,
    routeName: string,
    arrivals: Array<{ destination: string; minutesAway: string }>
  ): Promise<boolean> {
    const subject = `Loop: ${routeName} Arrivals`;

    let arrivalsHtml = '';
    if (arrivals.length === 0) {
      arrivalsHtml = '<p style="color: #64748B;">No arrivals found at this time.</p>';
    } else {
      arrivalsHtml = arrivals
        .slice(0, 3)
        .map(
          (arrival) => `
            <div style="padding: 12px; background: #F1F5F9; border-radius: 8px; margin-bottom: 8px;">
              <strong style="color: #0F172A;">${arrival.destination}</strong><br>
              <span style="color: #0EA5E9; font-size: 18px; font-weight: 600;">${arrival.minutesAway} min</span>
            </div>
          `
        )
        .join('');
    }

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F8FAFC;">
          <div style="max-width: 600px; margin: 40px auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <!-- Header -->
            <div style="background: linear-gradient(135deg, #0EA5E9 0%, #8B5CF6 100%); padding: 32px; text-align: center;">
              <div style="width: 48px; height: 48px; background: rgba(255, 255, 255, 0.2); border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; font-size: 28px; margin-bottom: 12px;">
                ⟲
              </div>
              <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 800;">Loop</h1>
              <p style="margin: 8px 0 0 0; color: rgba(255, 255, 255, 0.9); font-size: 14px;">Your CTA, On Loop</p>
            </div>

            <!-- Content -->
            <div style="padding: 32px;">
              <h2 style="margin: 0 0 8px 0; color: #0F172A; font-size: 20px;">${routeName}</h2>
              <p style="margin: 0 0 24px 0; color: #64748B; font-size: 14px;">Scheduled arrival times</p>

              ${arrivalsHtml}

              <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #E2E8F0; text-align: center;">
                <p style="margin: 0; color: #64748B; font-size: 13px;">
                  This is an automated notification from Loop CTA Tracker
                </p>
              </div>
            </div>

            <!-- Footer -->
            <div style="background: #F8FAFC; padding: 24px; text-align: center; border-top: 1px solid #E2E8F0;">
              <p style="margin: 0; color: #64748B; font-size: 12px;">
                © 2025 Loop • Powered by CTA APIs & Google Gemini AI
              </p>
            </div>
          </div>
        </body>
      </html>
    `;

    return this.sendEmail(email, subject, html);
  }
}

export default new EmailService();
