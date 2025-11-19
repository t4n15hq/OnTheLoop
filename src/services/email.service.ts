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
    arrivals: Array<{ destination: string; minutesAway: string }>,
    boardingStopName?: string,
    alightingStopName?: string
  ): Promise<boolean> {
    // Update subject and route name to show journey if both stops provided
    let displayName = routeName;
    if (boardingStopName && alightingStopName) {
      displayName = `${boardingStopName} → ${alightingStopName}`;
    }
    const subject = `🚇 ${displayName} - Next Arrivals`;

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
      return { mins: minutesAway, time: timeStr };
    };

    let arrivalsHtml = '';
    if (arrivals.length === 0) {
      arrivalsHtml = '<p style="color: #888888; font-family: monospace; margin: 16px 0;">NO ARRIVALS FOUND.</p>';
    } else {
      arrivalsHtml = `
        <div style="margin: 24px 0;">
          <p style="margin: 0 0 16px 0; color: #888888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; font-family: monospace;">UPCOMING</p>
          ${arrivals
            .slice(0, 3)
            .map(
              (arrival) => {
                const { mins, time } = formatArrival(arrival.minutesAway);
                return `
                <div style="padding: 16px 0; border-bottom: 1px solid #262626; display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div style="color: #EDEDED; font-size: 16px; font-weight: 600; margin-bottom: 4px;">${arrival.destination}</div>
                    <div style="color: #888888; font-size: 12px; font-family: monospace;">${time}</div>
                  </div>
                  <div style="text-align: right;">
                    <span style="color: #2E9CFF; font-size: 24px; font-weight: 700; letter-spacing: -1px;">${mins}</span>
                    <span style="color: #888888; font-size: 12px; font-weight: 500;">min</span>
                  </div>
                </div>
              `;
              }
            )
            .join('')}
        </div>
      `;
    }

    // Service status
    const serviceStatus = `
      <div style="margin-top: 32px; padding: 16px; background: rgba(0, 255, 102, 0.05); border: 1px solid rgba(0, 255, 102, 0.2); border-radius: 8px; display: flex; align-items: center; gap: 12px;">
        <div style="width: 8px; height: 8px; background: #00FF66; border-radius: 50%; box-shadow: 0 0 8px rgba(0, 255, 102, 0.4);"></div>
        <span style="color: #00FF66; font-family: monospace; font-size: 12px; letter-spacing: 0.5px;">SYSTEM STATUS: NORMAL</span>
      </div>
    `;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #050505; color: #EDEDED;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td style="padding: 20px 0; text-align: center; background-color: #050505;">
                
                <!-- Main Card -->
                <div style="max-width: 600px; margin: 0 auto; background-color: #0F0F0F; border: 1px solid #262626; border-radius: 16px; overflow: hidden; text-align: left;">
                  
                  <!-- Header -->
                  <div style="padding: 24px 32px; border-bottom: 1px solid #262626; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: 800; font-size: 20px; letter-spacing: -1px; color: #EDEDED;">
                      <span style="color: #2E9CFF;">⟲</span> LOOP
                    </div>
                    <div style="font-family: monospace; color: #888888; font-size: 12px;">V2.0</div>
                  </div>

                  <!-- Content -->
                  <div style="padding: 32px;">
                    <!-- Hero -->
                    <div style="margin-bottom: 32px;">
                      <div style="font-family: monospace; font-size: 11px; color: #888888; margin-bottom: 8px; letter-spacing: 1px;">TRACKED ROUTE</div>
                      <div style="font-size: 28px; font-weight: 700; letter-spacing: -0.5px; color: #EDEDED; margin-bottom: 4px;">${displayName}</div>
                      <div style="color: #888888; font-size: 14px;">${boardingStopName && alightingStopName ? 'Your scheduled trip' : 'Arrival Alert'}</div>
                    </div>

                    ${arrivalsHtml}

                    ${serviceStatus}
                  </div>

                  <!-- Footer -->
                  <div style="background-color: #0A0A0A; padding: 24px; border-top: 1px solid #262626; text-align: center;">
                    <a href="https://askcta.xyz" style="display: inline-block; color: #EDEDED; background-color: #262626; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-bottom: 20px;">Open Dashboard</a>
                    
                    <p style="margin: 0; color: #444444; font-size: 11px; font-family: monospace; line-height: 1.6;">
                      Loop Utility • Chicago Transit Automation<br>
                      <a href="#" style="color: #666666; text-decoration: none;">Unsubscribe</a>
                    </p>
                  </div>

                </div>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;

    return this.sendEmail(email, subject, html);
  }
}

export default new EmailService();
