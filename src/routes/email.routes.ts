import { Router, Request, Response } from 'express';
import prisma from '../utils/db';
import logger from '../utils/logger';
import { verifyUnsubscribeToken } from '../utils/unsubscribe';

const router = Router();

/**
 * Verify the signed token and, if valid, turn off email notifications for the
 * user. Returns true when the flag was flipped, false when the link is invalid.
 * Extracted so it can be unit-tested without spinning up Express.
 */
export async function applyUnsubscribe(userId: string, token: string): Promise<boolean> {
  if (!verifyUnsubscribeToken(userId, token)) return false;
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { emailNotifications: false },
    });
    return true;
  } catch (err) {
    logger.error(`Unsubscribe failed for user ${userId}:`, err);
    return false;
  }
}

function confirmationPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #222;">
<h1 style="font-size: 20px;">You're unsubscribed</h1>
<p>Email arrival notifications have been turned off for your account. You can turn them back on anytime in Profile &rarr; General.</p>
<p style="color: #888; font-size: 13px;">Loop &bull; Chicago Transit Automation</p>
</body></html>`;
}

function invalidPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invalid link</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #222;">
<h1 style="font-size: 20px;">Invalid unsubscribe link</h1>
<p>This link is invalid or has expired. If you still want to stop email notifications, change it in Profile &rarr; General.</p>
</body></html>`;
}

async function handleUnsubscribe(req: Request, res: Response): Promise<void> {
  const userId = String(req.query.u || '');
  const token = String(req.query.t || '');
  const ok = await applyUnsubscribe(userId, token);
  res
    .status(ok ? 200 : 400)
    .type('html')
    .send(ok ? confirmationPage() : invalidPage());
}

// GET is the human-facing link in the footer. POST is the RFC 8058 one-click
// endpoint that mail clients hit for the `List-Unsubscribe-Post` header.
router.get('/unsubscribe', handleUnsubscribe);
router.post('/unsubscribe', handleUnsubscribe);

export default router;
