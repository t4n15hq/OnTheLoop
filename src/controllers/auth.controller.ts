import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/auth.service';
import { AuthRequest } from '../middleware/auth.middleware';
import config from '../config';
import { reportError } from '../utils/sentry';

export class AuthController {
  static async register(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { email, password, name } = req.body;
      const result = await AuthService.register(email, password, name);

      res.status(201).json({
        message: 'User registered successfully',
        user: result.user,
        token: result.token,
      });
    } catch (error: any) {
      reportError(error, { route: 'auth/register' });
      res.status(400).json({ error: error.message || 'Registration failed' });
    }
  }

  static async login(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { email, password } = req.body;
      const result = await AuthService.login(email, password);

      res.status(200).json({
        message: 'Login successful',
        user: result.user,
        token: result.token,
      });
    } catch (error: any) {
      reportError(error, { route: 'auth/login' });
      res.status(401).json({ error: error.message || 'Login failed' });
    }
  }

  static async updatePassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { currentPassword, newPassword } = req.body;
      const userId = req.user!.userId;

      await AuthService.updatePassword(userId, currentPassword, newPassword);
      res.status(200).json({ message: 'Password updated successfully' });
    } catch (error: any) {
      reportError(error, { route: 'auth/password', userId: req.user?.userId });
      res.status(400).json({ error: error.message || 'Failed to update password' });
    }
  }

  /**
   * POST /api/auth/forgot-password
   * Always responds 200 with the same message regardless of whether the email
   * exists, to avoid account enumeration.
   */
  static async forgotPassword(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { email } = req.body;
      await AuthService.requestPasswordReset(email);
    } catch (error: any) {
      // Never surface failures — that would leak whether the account exists.
      logger.error('Forgot password error:', error);
    }

    res.status(200).json({
      message: 'If an account exists for that email, a password reset link has been sent.',
    });
  }

  /**
   * POST /api/auth/reset-password
   * Consumes a one-time reset token and sets a new password.
   */
  static async resetPassword(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { token, newPassword } = req.body;
      await AuthService.resetPassword(token, newPassword);
      res.status(200).json({ message: 'Password has been reset. Please sign in.' });
    } catch (error: any) {
      logger.error('Reset password error:', error);
      res.status(400).json({ error: 'Invalid or expired reset token' });
    }
  }

  /**
   * DELETE /api/account
   * Self-service account deletion. Requires the current password to be
   * re-entered. Cascades remove favorites, schedules and logs.
   */
  static async deleteAccount(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { password } = req.body;
      const userId = req.user!.userId;

      await AuthService.deleteAccount(userId, password);
      res.status(200).json({ message: 'Your account has been deleted.' });
    } catch (error: any) {
      logger.error('Delete account error:', error);
      res.status(400).json({ error: error.message || 'Failed to delete account' });
    }
  }

  static async updateProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const {
        name,
        email,
        emailNotifications,
        notificationsPausedUntil,
        quietHoursStart,
        quietHoursEnd,
      } = req.body;
      const userId = req.user!.userId;

      const user = await AuthService.updateProfile(userId, {
        name,
        email,
        emailNotifications,
        notificationsPausedUntil,
        quietHoursStart,
        quietHoursEnd,
      });
      res.status(200).json({ message: 'Profile updated successfully', user });
    } catch (error: any) {
      reportError(error, { route: 'auth/profile', userId: req.user?.userId });
      res.status(400).json({ error: error.message || 'Failed to update profile' });
    }
  }

  /**
   * Issue a one-time token that the user pastes to the Telegram bot
   * via `t.me/<bot>?start=<token>` to link their account.
   */
  static async createTelegramLink(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const token = await AuthService.createTelegramLinkToken(userId);

      const botUsername = config.telegram.botUsername;
      const deepLink = botUsername
        ? `https://t.me/${botUsername}?start=${token}`
        : null;

      res.status(200).json({ token, deepLink, botUsername: botUsername || null });
    } catch (error: any) {
      reportError(error, { route: 'auth/telegram/link', userId: req.user?.userId });
      res.status(500).json({ error: error.message || 'Failed to create link' });
    }
  }

  static async unlinkTelegram(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      await AuthService.unlinkTelegram(userId);
      res.status(200).json({ message: 'Telegram unlinked' });
    } catch (error: any) {
      reportError(error, { route: 'auth/telegram/unlink', userId: req.user?.userId });
      res.status(500).json({ error: error.message || 'Failed to unlink' });
    }
  }
}

export const registerValidation = [
  body('email')
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email')
    .normalizeEmail(),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
  body('name').optional().trim().isLength({ min: 1 }),
];

export const loginValidation = [
  body('email')
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email')
    .normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

export const passwordUpdateValidation = [
  body('currentPassword')
    .notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
];

export const forgotPasswordValidation = [
  body('email')
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email')
    .normalizeEmail(),
];

export const resetPasswordValidation = [
  body('token')
    .notEmpty().withMessage('Reset token is required'),
  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
];

export const deleteAccountValidation = [
  body('password')
    .notEmpty().withMessage('Current password is required'),
];

export const profileUpdateValidation = [
  body('name').optional({ nullable: true }).trim(),
  body('email').optional().trim().isEmail().withMessage('Invalid email address'),
  body('emailNotifications').optional().isBoolean(),
  // Accept either a valid ISO-8601 timestamp to pause until, or null/empty to resume.
  body('notificationsPausedUntil')
    .optional({ nullable: true, checkFalsy: false })
    .custom((value) => {
      if (value === null || value === '') return true;
      if (typeof value !== 'string') throw new Error('must be a string or null');
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new Error('must be an ISO-8601 timestamp');
      return true;
    }),
  body('quietHoursStart')
    .optional({ nullable: true, checkFalsy: false })
    .custom((value) => {
      if (value === null || value === '') return true;
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
        throw new Error('must be HH:mm (24-hour) or null');
      }
      return true;
    }),
  body('quietHoursEnd')
    .optional({ nullable: true, checkFalsy: false })
    .custom((value) => {
      if (value === null || value === '') return true;
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
        throw new Error('must be HH:mm (24-hour) or null');
      }
      return true;
    }),
];
