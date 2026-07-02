// Native (Rust/napi) bcrypt — runs hashing on a background thread instead of
// blocking the event loop like the pure-JS bcryptjs did. Prebuilt binaries
// (incl. linux-musl for the Alpine image), so no node-gyp build step. Produces
// and verifies standard $2b$ hashes, so existing bcryptjs hashes stay valid.
import { hash as bcryptHash, verify as bcryptVerify } from '@node-rs/bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';
import prisma from '../utils/db';
import logger from '../utils/logger';
import emailService from './email.service';

interface TokenPayload {
  userId: string;
  email: string;
  // Populated by jwt on verify; used to invalidate sessions issued before a
  // password change/reset.
  iat?: number;
  exp?: number;
}

// How long a password reset link stays valid.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const QUIET_HOUR_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeQuietHour(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!QUIET_HOUR_RE.test(trimmed)) {
    throw new Error('Quiet hours must be in HH:mm format');
  }
  return trimmed;
}

function publicUser(user: {
  id: string;
  email: string;
  name: string | null;
  telegramChatId: string | null;
  emailNotifications: boolean;
  notificationsPausedUntil: Date | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    telegramLinked: Boolean(user.telegramChatId),
    emailNotifications: user.emailNotifications,
    notificationsPausedUntil: user.notificationsPausedUntil
      ? user.notificationsPausedUntil.toISOString()
      : null,
    quietHoursStart: user.quietHoursStart,
    quietHoursEnd: user.quietHoursEnd,
    createdAt: user.createdAt,
  };
}

export class AuthService {
  static async hashPassword(password: string): Promise<string> {
    return bcryptHash(password, 10);
  }

  static async comparePassword(password: string, hashed: string): Promise<boolean> {
    return bcryptVerify(password, hashed);
  }

  static generateToken(payload: TokenPayload): string {
    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    } as jwt.SignOptions);
  }

  /**
   * Verify a JWT and confirm it is still valid for the user.
   *
   * Pins the algorithm to HS256 (defence against alg-confusion / "none"
   * downgrade attacks) and rejects any token minted before the user last
   * changed their password, so a password reset invalidates existing sessions.
   */
  static async verifyToken(token: string): Promise<TokenPayload> {
    const payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
    }) as TokenPayload;

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      throw new Error('User no longer exists');
    }
    if (
      user.passwordChangedAt &&
      typeof payload.iat === 'number' &&
      payload.iat * 1000 < user.passwordChangedAt.getTime()
    ) {
      throw new Error('Token invalidated by password change');
    }

    return payload;
  }

  static async register(email: string, password: string, name?: string) {
    const normalized = normalizeEmail(email);

    const existing = await prisma.user.findUnique({ where: { email: normalized } });
    if (existing) {
      throw new Error('An account with this email already exists');
    }

    const hashedPassword = await this.hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email: normalized,
        password: hashedPassword,
        name: name?.trim() || null,
      },
    });

    const token = this.generateToken({ userId: user.id, email: user.email });
    logger.info(`User registered: ${user.id}`);

    return { user: publicUser(user), token };
  }

  static async login(email: string, password: string) {
    const normalized = normalizeEmail(email);

    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      throw new Error('Invalid credentials');
    }

    const valid = await this.comparePassword(password, user.password);
    if (!valid) {
      throw new Error('Invalid credentials');
    }

    const token = this.generateToken({ userId: user.id, email: user.email });
    logger.info(`User logged in: ${user.id}`);

    return { user: publicUser(user), token };
  }

  static async getUserById(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return user ? publicUser(user) : null;
  }

  static async getUserByTelegramChatId(chatId: string) {
    return prisma.user.findUnique({ where: { telegramChatId: chatId } });
  }

  /**
   * Pause all scheduled notifications until the given instant (reuses the
   * existing `notificationsPausedUntil` field). Powers the Telegram
   * "Mute today" quick action.
   */
  static async pauseNotificationsUntil(userId: string, until: Date) {
    await prisma.user.update({
      where: { id: userId },
      data: { notificationsPausedUntil: until },
    });
  }

  /**
   * Change the password for a logged-in user. Requires the current password
   * to be re-entered (defence against session hijack / drive-by CSRF) and
   * stamps passwordChangedAt so existing tokens are invalidated.
   */
  static async updatePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new Error('User not found');
    }

    const valid = await this.comparePassword(currentPassword, user.password);
    if (!valid) {
      throw new Error('Current password is incorrect');
    }

    const hashed = await this.hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashed, passwordChangedAt: new Date() },
    });
    logger.info(`Password updated for user: ${userId}`);
  }

  /**
   * Begin a password reset. Always resolves without revealing whether the
   * email exists (no account enumeration). When the account exists we store a
   * SHA-256 hash of a random token (the raw token only ever lives in the
   * emailed link) with a 30-minute expiry.
   */
  static async requestPasswordReset(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      logger.info(`Password reset requested for unknown email: ${normalized}`);
      return;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: sha256(rawToken),
        passwordResetExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const resetLink = `${config.publicUrl}/reset-password?token=${rawToken}`;
    await emailService.sendPasswordResetEmail(user.email, resetLink);
    logger.info(`Password reset link issued for user: ${user.id}`);
  }

  /**
   * Complete a password reset. Looks the user up by the hashed token, enforces
   * single-use + expiry, sets the new hash, stamps passwordChangedAt (which
   * invalidates existing sessions) and clears the reset token.
   */
  static async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const hashed = sha256(rawToken);
    const user = await prisma.user.findUnique({ where: { passwordResetToken: hashed } });

    if (
      !user ||
      !user.passwordResetExpires ||
      user.passwordResetExpires.getTime() < Date.now()
    ) {
      throw new Error('Invalid or expired reset token');
    }

    const hashedPassword = await this.hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordChangedAt: new Date(),
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });
    logger.info(`Password reset completed for user: ${user.id}`);
  }

  /**
   * Self-service account deletion. Requires the current password to be
   * re-entered. Relies on schema-level cascades to remove favorites,
   * schedules and notification logs.
   */
  static async deleteAccount(userId: string, currentPassword: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new Error('User not found');
    }

    const valid = await this.comparePassword(currentPassword, user.password);
    if (!valid) {
      throw new Error('Current password is incorrect');
    }

    await prisma.user.delete({ where: { id: userId } });
    logger.info(`Account deleted: ${userId}`);
  }

  static async updateProfile(
    userId: string,
    data: {
      name?: string;
      email?: string;
      emailNotifications?: boolean;
      notificationsPausedUntil?: string | null;
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
    }
  ) {
    const update: Record<string, unknown> = {};

    if (typeof data.name === 'string') update.name = data.name.trim() || null;
    if (typeof data.emailNotifications === 'boolean') update.emailNotifications = data.emailNotifications;
    if (data.notificationsPausedUntil !== undefined) {
      if (data.notificationsPausedUntil === null || data.notificationsPausedUntil === '') {
        update.notificationsPausedUntil = null;
      } else {
        const parsed = new Date(data.notificationsPausedUntil);
        if (Number.isNaN(parsed.getTime())) throw new Error('Invalid pause timestamp');
        update.notificationsPausedUntil = parsed;
      }
    }
    if (data.quietHoursStart !== undefined) {
      update.quietHoursStart = normalizeQuietHour(data.quietHoursStart);
    }
    if (data.quietHoursEnd !== undefined) {
      update.quietHoursEnd = normalizeQuietHour(data.quietHoursEnd);
    }
    if (typeof data.email === 'string') {
      const normalized = normalizeEmail(data.email);
      if (normalized) {
        const clash = await prisma.user.findFirst({
          where: { email: normalized, NOT: { id: userId } },
        });
        if (clash) throw new Error('That email is already in use');
        update.email = normalized;
      }
    }

    const user = await prisma.user.update({ where: { id: userId }, data: update });
    logger.info(`Profile updated for user: ${userId}`);
    return publicUser(user);
  }

  /**
   * Generate (or reuse) a one-time Telegram link token for a user.
   * The user sends `/start <token>` to the bot to bind their chat.
   */
  static async createTelegramLinkToken(userId: string): Promise<string> {
    const token = crypto.randomBytes(24).toString('base64url');
    await prisma.user.update({
      where: { id: userId },
      data: { telegramLinkToken: token },
    });
    return token;
  }

  /**
   * Consume a link token: bind the given chatId to the user that owns the token.
   * Returns the bound user, or null if the token is unknown/expired.
   */
  static async consumeTelegramLinkToken(token: string, chatId: string) {
    const user = await prisma.user.findUnique({ where: { telegramLinkToken: token } });
    if (!user) return null;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { telegramChatId: chatId, telegramLinkToken: null },
    });
    logger.info(`Telegram linked for user: ${updated.id}`);
    return updated;
  }

  static async unlinkTelegram(userId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: null, telegramLinkToken: null },
    });
  }
}
