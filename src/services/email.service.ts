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
      const fromAddress = config.email?.from || config.email?.user;
      const fromName = config.email?.fromName || 'Loop CTA Tracker';

      const info = await this.transporter.sendMail({
        from: `"${fromName}" <${fromAddress}>`,
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
    const subject = `🚇 ${routeName} - Next Arrivals`;

    // Format arrivals with both relative and absolute time
    const formatArrival = (minutesAway: string) => {
      const mins = parseInt(minutesAway);
      const now = new Date();
      const arrivalTime = new Date(now.getTime() + mins * 60000);
      const timeStr = arrivalTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      return `${minutesAway} min (${timeStr})`;
    };

    let arrivalsHtml = '';
    if (arrivals.length === 0) {
      arrivalsHtml = '<p style="color: #64748B; font-size: 14px; margin: 16px 0;">No arrivals found at this time.</p>';
    } else {
      arrivalsHtml = `
        <div style="margin: 20px 0;">
          <p style="margin: 0 0 12px 0; color: #64748B; font-size: 13px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">NEXT ARRIVALS</p>
          ${arrivals
            .slice(0, 3)
            .map(
              (arrival) => `
                <div style="padding: 14px 0; border-bottom: 1px solid #F1F5F9;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 18px;">🚇</span>
                    <span style="color: #0EA5E9; font-size: 16px; font-weight: 700;">${formatArrival(arrival.minutesAway)}</span>
                  </div>
                  <div style="margin-top: 4px; padding-left: 26px; color: #64748B; font-size: 14px;">${arrival.destination}</div>
                </div>
              `
            )
            .join('')}
        </div>
      `;
    }

    // Service status (always show running on time for now)
    const serviceStatus = `
      <div style="margin: 24px 0; padding: 12px; background: #F0FDF4; border-radius: 8px; border-left: 3px solid #10B981;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 16px;">✅</span>
          <span style="color: #059669; font-weight: 600; font-size: 14px;">Running on time</span>
        </div>
      </div>
    `;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F8FAFC;">
          <div style="max-width: 600px; margin: 40px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08);">

            <!-- Content -->
            <div style="padding: 32px;">
              <!-- Location Icon + Route Name -->
              <div style="margin-bottom: 8px;">
                <span style="font-size: 16px; margin-right: 4px;">📍</span>
                <span style="color: #0F172A; font-size: 18px; font-weight: 700;">${routeName}</span>
              </div>
              <p style="margin: 0 0 20px 0; color: #64748B; font-size: 13px;">Scheduled arrival times</p>

              ${arrivalsHtml}

              ${serviceStatus}
            </div>

            <!-- Footer -->
            <div style="background: #F8FAFC; padding: 20px 32px; border-top: 1px solid #E2E8F0;">
              <div style="text-align: center; margin-bottom: 12px;">
                <a href="mailto:noreply@askcta.xyz?subject=Unsubscribe" style="color: #0EA5E9; text-decoration: none; font-size: 13px; font-weight: 500;">
                  Manage alerts
                </a>
              </div>
              <p style="margin: 0; text-align: center; color: #94A3B8; font-size: 11px; line-height: 1.5;">
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
