import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';
import prisma from '../utils/db';
import logger from '../utils/logger';

interface TokenPayload {
  userId: string;
  email: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function publicUser(user: {
  id: string;
  email: string;
  name: string | null;
  telegramChatId: string | null;
  emailNotifications: boolean;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    telegramLinked: Boolean(user.telegramChatId),
    emailNotifications: user.emailNotifications,
    createdAt: user.createdAt,
  };
}

export class AuthService {
  static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  static async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  static generateToken(payload: TokenPayload): string {
    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    } as jwt.SignOptions);
  }

  static verifyToken(token: string): TokenPayload {
    return jwt.verify(token, config.jwt.secret) as TokenPayload;
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
    logger.info(`User registered: ${user.email}`);

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
    logger.info(`User logged in: ${user.email}`);

    return { user: publicUser(user), token };
  }

  static async getUserById(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return user ? publicUser(user) : null;
  }

  static async getUserByTelegramChatId(chatId: string) {
    return prisma.user.findUnique({ where: { telegramChatId: chatId } });
  }

  static async updatePassword(userId: string, password: string) {
    const hashed = await this.hashPassword(password);
    await prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    logger.info(`Password updated for user: ${userId}`);
  }

  static async updateProfile(
    userId: string,
    data: { name?: string; email?: string; emailNotifications?: boolean }
  ) {
    const update: Record<string, unknown> = {};

    if (typeof data.name === 'string') update.name = data.name.trim() || null;
    if (typeof data.emailNotifications === 'boolean') update.emailNotifications = data.emailNotifications;
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
    logger.info(`Telegram linked for user: ${updated.email}`);
    return updated;
  }

  static async unlinkTelegram(userId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: null, telegramLinkToken: null },
    });
  }
}
